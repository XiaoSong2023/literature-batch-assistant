import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState } from '../extension/core.js';
import { createChromeFixture } from './chrome-fixture.mjs';

const records = [1,2,3].map(index => ({id:`p${index}`,sourceIndex:index,title:`Speed fixture ${index}`,doi:`10.1234/speed-${index}`}));
const getState = async f => (await f.send({type:'GET_STATE'})).state;

function fastSite(outcomes) {
  let submitted = null, navCount = 0;
  return ({func,args,calls}) => {
    if (calls.navigation.length !== navCount) { navCount = calls.navigation.length; submitted = null; }
    if (func.name === 'installPageWatcher') return {ok:true};
    if (func.name === 'submitDoi') { submitted=args[0]; return {ok:true}; }
    if (func.name === 'inspectPage') return {kind:'home',url:'https://sci-hub.box/',readyState:'interactive',...(!submitted?{}:outcomes[submitted])};
    throw Error(`Unexpected script ${func.name}`);
  };
}

test('not-found DOM is processed while a subframe keeps tab.status loading', async () => {
  const f=await createChromeFixture({bundle:{papers:records},scriptHandler:fastSite({'10.1234/speed-1':{kind:'not_found',message:'Article not found'}})});
  await f.send({type:'START',limit:0,settings:{delaySeconds:3,timeoutSeconds:20,downloadTimeoutSeconds:30}});
  // Chrome tab status can remain loading long after useful page DOM is rendered.
  f.tabs.values().next().value.status='loading';
  for(let i=0;i<6;i++) await f.advance(500);
  const state=await getState(f);
  assert.equal(state.papers[0].status,'failed');
  assert.equal(state.papers[0].reasonCode,'not_found');
  assert.ok(state.papers[0].finishedAt);
});

const speedSettings={delaySeconds:0.25,timeoutSeconds:25,resultTimeoutSeconds:2,downloadTimeoutSeconds:30,autoRobotNo:true};
async function until(f,predicate,label,iterations=100){
  for(let i=0;i<iterations;i++){
    const state=await getState(f);if(predicate(state))return state;
    await f.advance(250);
  }
  assert.fail(`Never reached ${label}: ${JSON.stringify(await getState(f))}`);
}

test('unknown result is quickly recorded as retryable detection timeout, never as absent',async()=>{
  const f=await createChromeFixture({bundle:{papers:records},scriptHandler:fastSite({'10.1234/speed-1':{kind:'unknown'},'10.1234/speed-2':{kind:'pdf',url:'https://files.fixture.example/next.pdf'}})});
  await f.send({type:'START',limit:0,settings:speedSettings});
  const start=f.now;
  const state=await until(f,s=>s.papers[1].status==='downloading','next paper after short unknown timeout');
  assert.equal(state.papers[0].reasonCode,'detection_timeout');
  assert.match(state.papers[0].reason,/可重试|可稍后重试/);
  assert.ok(f.now-start<6000);
});

test('next DOI begins after configured quarter-second gap without waiting for watchdog',async()=>{
  const f=await createChromeFixture({bundle:{papers:records},scriptHandler:fastSite(Object.fromEntries(records.map(p=>[p.doi,{kind:'pdf',url:`https://files.fixture.example/${p.id}.pdf`}])))});
  await f.send({type:'START',limit:0,settings:speedSettings});
  const first=await until(f,s=>s.papers[0].status==='downloading','first download');
  await f.completeDownload(first.papers[0].downloadId);
  await f.advance(249);
  assert.equal((await getState(f)).papers[1].status,'pending');
  await f.advance(1);
  assert.equal((await getState(f)).papers[1].status,'searching');
});

test('outgoing document and stale events cannot download the previous page for the new DOI',async()=>{
  const f=await createChromeFixture({bundle:{papers:records},autoCommitSubmission:false,scriptHandler:fastSite({'10.1234/speed-1':{kind:'pdf',url:'https://files.fixture.example/new.pdf'}})});
  await f.send({type:'START',limit:0,settings:speedSettings});
  const state=await until(f,s=>s.phase==='result','submitted DOI');
  const outgoingId=f.tabs.get(state.tabId).documentId;
  await f.advance(1000);
  assert.equal(f.calls.downloads.length,0);
  await f.chrome.webNavigation.onErrorOccurred.emit({tabId:state.tabId,frameId:0,documentId:outgoingId,error:'net::ERR_CONNECTION_RESET'});
  const stale=await f.send({type:'PAGE_CHANGED',watchId:state.watchId},{id:f.chrome.runtime.id,url:'https://sci-hub.box/',tab:{id:state.tabId},frameId:0,documentId:outgoingId});
  assert.equal(stale.active,false);
  assert.equal((await getState(f)).papers[0].status,'searching');
  f.tabs.get(state.tabId).documentId='committed-result-document';
  await f.chrome.webNavigation.onDOMContentLoaded.emit({tabId:state.tabId,frameId:0,documentId:'committed-result-document',url:'https://sci-hub.box/'});
  await f.settle();
  assert.equal((await getState(f)).papers[0].status,'downloading');
  assert.equal(f.calls.downloads.length,1);
});

test('automatic No clicks once, then downloaded PDF can be recognized in the same document',async()=>{
  const outcomes={'10.1234/speed-1':{kind:'captcha',robotNo:true,readyState:'complete',message:'Are you a robot?'}};
  const base=fastSite(outcomes);
  const f=await createChromeFixture({bundle:{papers:records},scriptHandler:options=>{
    if(options.func.name==='clickRobotNo'){outcomes['10.1234/speed-1']={kind:'pdf',url:'https://files.fixture.example/robot.pdf'};return {status:'clicked'};}
    return base(options);
  }});
  await f.send({type:'START',limit:0,settings:speedSettings});
  const state=await until(f,s=>s.papers[0].status==='downloading','PDF after local No click');
  assert.equal(state.papers[0].robotClicks,1);
  assert.equal(f.calls.scripts.filter(call=>call.name==='clickRobotNo').length,1);
});

test('disabled automatic No leaves the challenge for manual action',async()=>{
  const f=await createChromeFixture({bundle:{papers:records},scriptHandler:fastSite({'10.1234/speed-1':{kind:'captcha',robotNo:true,readyState:'complete',message:'Manual verification'}})});
  await f.send({type:'START',limit:0,settings:{...speedSettings,autoRobotNo:false}});
  const state=await until(f,s=>!s.running,'manual challenge pause');
  assert.equal(state.papers[0].status,'searching');
  assert.equal(f.calls.scripts.filter(call=>call.name==='clickRobotNo').length,0);
  assert.equal(state.papers[1].status,'pending');
});

test('worker restart retains one-click intent and will not click the challenge twice',async()=>{
  const outcome={kind:'captcha',robotNo:true,readyState:'complete',message:'Are you a robot?'};
  const base=fastSite({'10.1234/speed-1':outcome});
  const f=await createChromeFixture({bundle:{papers:records},scriptHandler:options=>options.func.name==='clickRobotNo'?{status:'clicked'}:base(options)});
  await f.send({type:'START',limit:0,settings:speedSettings});
  const current=await until(f,s=>s.papers[0].robotClicks===1,'persisted No-click intent');
  const recovered=await createChromeFixture({persisted:f.persisted,session:f.session,tabItems:[...f.tabs.values()],scriptHandler:options=>{
    if(options.func.name==='inspectPage')return outcome;
    if(options.func.name==='installPageWatcher')return {ok:true};
    throw Error('Repeated click after recovery is forbidden');
  }});
  await recovered.advance(22000);
  const state=await getState(recovered);
  assert.equal(state.running,false);
  assert.equal(state.papers[0].robotClicks,1);
  assert.equal(state.papers[0].id,current.papers[0].id);
  assert.equal(recovered.calls.scripts.filter(call=>call.name==='clickRobotNo').length,0);
});

test('saved v1 queue migrates speed defaults without changing completed or failed records',async()=>{
  const saved=createInitialState({sourceName:'Original saved queue',papers:[...records,{id:'missing',title:'Missing DOI citation',doi:''}]});
  delete saved.settingsVersion;
  saved.settings={siteUrl:'https://sci-hub.box/',delaySeconds:8,timeoutSeconds:90,downloadTimeoutSeconds:300};
  Object.assign(saved.papers[0],{status:'success',attempts:1,downloadId:77,filename:'C:/Downloads/Existing.pdf'});
  Object.assign(saved.papers[1],{status:'failed',attempts:2,reasonCode:'not_found',reason:'Original failure reason'});
  const originalPapers=structuredClone(saved.papers);
  const f=await createChromeFixture({persisted:{literatureBatchState:saved}});
  const migrated=await getState(f);
  assert.equal(migrated.settingsVersion,2);
  assert.equal(migrated.settings.delaySeconds,1);
  assert.equal(migrated.settings.timeoutSeconds,25);
  assert.equal(migrated.settings.resultTimeoutSeconds,12);
  assert.deepEqual(migrated.papers,originalPapers);
  assert.equal(migrated.sourceName,'Original saved queue');
});

test('skip current records retryable manual skip and never overlaps a live un-cancelled download',async()=>{
  const f=await createChromeFixture({bundle:{papers:records},scriptHandler:fastSite({'10.1234/speed-1':{kind:'pdf',url:'https://files.fixture.example/skip.pdf'}})});
  await f.send({type:'START',limit:0,settings:speedSettings});
  await until(f,s=>s.papers[0].status==='downloading','live download to skip');
  f.chrome.downloads.cancel=async()=>{throw Error('Cancellation not settled');};
  const response=await f.send({type:'SKIP_CURRENT'});
  assert.equal(response.ok,true);
  assert.equal(response.state.papers[0].status,'downloading');
  assert.equal(response.state.papers[1].status,'pending');
  assert.equal(response.state.running,false);
});

test('PDF DOM starts download without waiting for full page loading', async () => {
  const f=await createChromeFixture({bundle:{papers:records},scriptHandler:fastSite({'10.1234/speed-1':{kind:'pdf',url:'https://files.fixture.example/fast.pdf'}})});
  await f.send({type:'START',limit:0,settings:{delaySeconds:3,timeoutSeconds:20,downloadTimeoutSeconds:30}});
  f.tabs.values().next().value.status='loading';
  for(let i=0;i<6;i++) await f.advance(500);
  assert.equal((await getState(f)).papers[0].status,'downloading');
  assert.equal(f.calls.downloads.length,1);
});

test('sci-net.xyz result redirect downloads PDF and returns to sci-hub.box for the next DOI',async()=>{
  let f;
  const base=fastSite(Object.fromEntries(records.map(p=>[p.doi,{kind:'pdf',url:`https://files.fixture.example/${p.id}.pdf`}])));
  f=await createChromeFixture({bundle:{papers:records},scriptHandler:options=>{
    const result=base(options);
    if(options.func.name==='submitDoi'&&options.args[0]===records[0].doi)f.tabs.get(options.target.tabId).url='https://sci-net.xyz/10.1111/scd.12848';
    return result;
  }});
  await f.send({type:'START',limit:0,settings:speedSettings});
  const first=await until(f,s=>s.papers[0].status==='downloading','PDF from allowed result host');
  assert.equal(f.tabs.get(first.tabId).url,'https://sci-net.xyz/10.1111/scd.12848');
  await f.completeDownload(first.papers[0].downloadId);
  await until(f,s=>s.papers[1].status==='downloading','next DOI returned to original homepage');
  assert.equal(f.calls.navigation.at(-1).url,'https://sci-hub.box/');
  assert.equal(f.calls.downloads.length,2);
});

test('a redirect to any other origin still pauses without downloading its apparent PDF',async()=>{
  let f;
  const base=fastSite({'10.1234/speed-1':{kind:'pdf',url:'https://files.fixture.example/unsupported.pdf'}});
  f=await createChromeFixture({bundle:{papers:records},scriptHandler:options=>{
    const result=base(options);
    if(options.func.name==='submitDoi')f.tabs.get(options.target.tabId).url='https://unapproved.fixture.example/result';
    return result;
  }});
  await f.send({type:'START',limit:0,settings:speedSettings});
  const state=await until(f,s=>!s.running,'unsupported-origin pause');
  assert.equal(state.papers[0].status,'searching');
  assert.match(state.pauseReason,/未授权/);
  assert.equal(f.calls.downloads.length,0);
});
