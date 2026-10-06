import test from 'node:test';
import assert from 'node:assert/strict';
import {createInitialState} from '../extension/core.js';
import {createChromeFixture} from './chrome-fixture.mjs';

const record=n=>({id:`net-${n}`,sourceIndex:String(n),title:`Network ${n}`,pdfUrl:`https://files.example/${n}.pdf`});
const settings={delaySeconds:0.25,timeoutSeconds:5,resultTimeoutSeconds:2,downloadTimeoutSeconds:30};
const get=async f=>(await f.send({type:'GET_STATE'})).state;
const start=f=>f.send({type:'START',limit:0,settings});
const never=()=>new Promise(()=>{});

test('an unresponsive page script releases the command queue and reaches its page deadline',async()=>{
  const f=await createChromeFixture({bundle:{papers:[{id:'doi',title:'Blocked script',doi:'10.1234/blocked'},record(2)]},scriptHandler:never});
  await start(f);
  await f.advance(500);
  let replied=false;const read=get(f).then(state=>{replied=true;return state;});
  await f.advance(6000);
  assert.equal(replied,true,'GET_STATE is blocked behind an unresolved executeScript');
  const state=await read;
  assert.equal(state.papers[0].status,'failed');
  assert.match(state.papers[0].reasonCode,/timeout/);
  await f.advance(500);
  assert.equal((await get(f)).papers[1].status,'downloading');
});

test('a hung navigation call cannot permanently block Pause or following records',async()=>{
  const f=await createChromeFixture({bundle:{papers:[{id:'doi',doi:'10.1234/navigation'},record(2)]}});
  f.chrome.tabs.create=never;
  let replied=false;const started=start(f).then(value=>{replied=true;return value;});
  await f.settle();await f.advance(6000);
  assert.equal(replied,true,'START must resolve when tabs.create never returns');
  assert.equal((await started).ok,true);
  assert.equal((await get(f)).papers[0].reasonCode,'navigation_error');
  await f.advance(500);assert.equal((await get(f)).papers[1].status,'downloading');
});

test('closing a tab during a hung page read preserves that paper for Continue instead of skipping it',async()=>{
  let blocked=true;
  const f=await createChromeFixture({bundle:{papers:[{id:'doi',title:'Keep current',doi:'10.1234/closed-hung'},record(2)]},scriptHandler:({func})=>blocked?never():func.name==='inspectPage'?{kind:'home',readyState:'complete'}:{ok:true}});
  await start(f);const initial=await get(f);await f.advance(500);
  await f.chrome.tabs.remove(initial.tabId);await f.settle();
  await f.advance(6000);
  const closed=await get(f);
  assert.equal(closed.papers[0].status,'searching');assert.equal(closed.activeId,'doi');assert.equal(closed.running,false);
  blocked=false;await start(f);
  const resumed=await get(f);assert.equal(resumed.activeId,'doi');assert.equal(resumed.papers[0].attempts,1);assert.equal(resumed.papers[1].status,'pending');
});

test('transient interrupted downloads resume in place and closing the task tab preserves tracking',async()=>{
  const f=await createChromeFixture({bundle:{papers:[record(1),record(2)]}});
  await start(f);let state=await get(f);const id=state.papers[0].downloadId;
  const tab=await f.chrome.tabs.create({url:'https://sci-hub.box/'});
  // A direct URL can follow a DOI item whose task tab remains open.
  const saved=f.persisted.literatureBatchState;saved.tabId=tab.id;
  const restored=await createChromeFixture({persisted:{literatureBatchState:saved},session:f.session,downloadItems:[...f.downloads.values()],tabItems:[tab]});
  let resumes=0;
  restored.chrome.downloads.resume=async downloadId=>{resumes++;Object.assign(restored.downloads.get(downloadId),{state:'in_progress',error:undefined});};
  Object.assign(restored.downloads.get(id),{state:'interrupted',error:'NETWORK_FAILED',canResume:true});
  await restored.chrome.downloads.onChanged.emit({id,state:{current:'interrupted'}});await restored.settle();
  await restored.chrome.tabs.remove(tab.id);await restored.settle();
  state=await get(restored);
  assert.equal(state.activeId,'net-1');assert.equal(state.papers[0].downloadId,id);assert.equal(state.papers[1].status,'pending');
  await restored.advance(2500);
  assert.equal(resumes,1);assert.equal(restored.calls.downloads.length,0);
  await restored.completeDownload(id);
  assert.equal((await get(restored)).papers[0].status,'success');
});

test('network errors without resume get only two automatic retries then continue with a reason',async()=>{
  const f=await createChromeFixture({bundle:{papers:[record(1),record(2)]}});
  await start(f);
  for(let attempt=0;attempt<3;attempt++){
    const state=await get(f),id=state.papers[0].downloadId;
    Object.assign(f.downloads.get(id),{state:'interrupted',error:'NETWORK_FAILED',canResume:false});
    await f.chrome.downloads.onChanged.emit({id,state:{current:'interrupted'}});await f.settle();
    await f.advance(attempt===0?2500:4500);
  }
  const state=await get(f);
  assert.equal(state.papers[0].status,'failed');assert.equal(state.papers[0].reasonCode,'NETWORK_FAILED');
  assert.match(state.papers[0].reason,/2.*重试|重试.*2/);
  assert.equal(state.papers[1].status,'downloading');
  assert.equal(f.calls.downloads.filter(item=>item.url===record(1).pdfUrl).length,3);
  assert.equal(state.papers[0].attempts,1,'automatic recovery belongs to the original paper attempt');
});

test('a rejected resume falls back to a new download only after confirming the old transfer is interrupted',async()=>{
  const f=await createChromeFixture({bundle:{papers:[record(1),record(2)]}});await start(f);
  const first=(await get(f)).papers[0].downloadId;
  f.chrome.downloads.resume=async()=>{throw Error('Download cannot be resumed');};
  Object.assign(f.downloads.get(first),{state:'interrupted',error:'SERVER_CONTENT_LENGTH_MISMATCH',canResume:true});
  await f.chrome.downloads.onChanged.emit({id:first,state:{current:'interrupted'}});await f.settle();await f.advance(2500);
  const state=await get(f);assert.notEqual(state.papers[0].downloadId,first);
  assert.equal(state.papers[0].downloadRetryCount,1);assert.equal(f.calls.downloads.length,2);
  assert.equal(state.papers[1].status,'pending');
  await f.completeDownload(state.papers[0].downloadId);assert.equal((await get(f)).papers[0].status,'success');
});

test('a fulfilled resume that leaves the same interrupted item unchanged falls back rather than repeating resume',async()=>{
  const f=await createChromeFixture({bundle:{papers:[record(1),record(2)]}});await start(f);
  const id=(await get(f)).papers[0].downloadId;let resumes=0;
  f.chrome.downloads.resume=async()=>{resumes++;};
  Object.assign(f.downloads.get(id),{state:'interrupted',error:'SERVER_CONTENT_LENGTH_MISMATCH',canResume:true});
  await f.chrome.downloads.onChanged.emit({id,state:{current:'interrupted'}});await f.settle();await f.advance(2500);
  await f.advance(2500);await f.advance(4500);
  const state=await get(f);assert.equal(resumes,1);assert.notEqual(state.papers[0].downloadId,id);
  assert.equal(state.papers[0].downloadRetryCount,2);assert.equal(f.calls.downloads.length,2);
  await f.completeDownload(state.papers[0].downloadId);assert.equal((await get(f)).papers[0].status,'success');
});

test('paused interruption is retained until Continue and does not auto-retry while paused',async()=>{
  const f=await createChromeFixture({bundle:{papers:[record(1),record(2)]}});await start(f);
  const id=(await get(f)).papers[0].downloadId;await f.send({type:'PAUSE'});
  Object.assign(f.downloads.get(id),{state:'interrupted',error:'NETWORK_FAILED',canResume:false});
  await f.chrome.downloads.onChanged.emit({id,state:{current:'interrupted'}});await f.settle();await f.advance(10000);
  assert.equal((await get(f)).activeId,'net-1');assert.equal(f.calls.downloads.length,1);
  await start(f);await f.advance(2500);
  assert.equal((await get(f)).papers[0].status,'downloading');assert.equal(f.calls.downloads.length,2);
});

test('retry unfinished preserves success, includes failed/skipped/paused/pending and resets the range',async()=>{
  const state=createInitialState({papers:[record(1),record(2),record(3),record(4),record(5),{id:'missing',title:'No link'}]});
  state.startFromNumber=4;
  Object.assign(state.papers[0],{status:'success',attempts:3,downloadId:8,filename:'saved.pdf'});
  state.papers[1].status='failed';state.papers[1].reason='Old error';state.papers[2].status='skipped';state.papers[3].status='paused';
  const success=structuredClone(state.papers[0]);
  const f=await createChromeFixture({persisted:{literatureBatchState:state}});
  const result=await f.send({type:'RETRY_UNFINISHED'});
  assert.equal(result.ok,true,result.error);assert.equal(result.count,4);
  assert.equal(result.state.startFromNumber,1);assert.equal(result.state.running,true);
  assert.deepEqual(result.state.papers[0],success);
  assert.deepEqual(result.state.papers.map(p=>p.status),['success','downloading','pending','pending','pending','missing_doi']);
});

test('retry scope failed runs only failed records and leaves ordinary pending or skipped entries alone',async()=>{
  const state=createInitialState({papers:[record(1),record(2),record(3)]});
  state.papers[1].status='failed';state.papers[2].status='skipped';
  const f=await createChromeFixture({persisted:{literatureBatchState:state}});
  const result=await f.send({type:'RETRY_UNFINISHED',scope:'failed'});
  assert.equal(result.ok,true,result.error);assert.equal(result.count,1);
  assert.deepEqual(result.state.papers.map(p=>p.status),['pending','downloading','skipped']);
  await f.completeDownload(result.state.papers[1].downloadId);await f.advance(1500);
  assert.equal((await get(f)).running,false);assert.equal(f.calls.downloads.length,1);
});

test('retry failed suspends a paused search without searching that non-failed paper',async()=>{
  const state=createInitialState({papers:[{id:'search',doi:'10.1234/paused'},record(2)]});
  state.activeId='search';state.papers[0].status='searching';state.papers[0].attempts=1;state.papers[1].status='failed';
  const f=await createChromeFixture({persisted:{literatureBatchState:state}});
  const result=await f.send({type:'RETRY_UNFINISHED',scope:'failed'});
  assert.equal(result.ok,true,result.error);assert.deepEqual(result.state.papers.map(p=>p.status),['pending','downloading']);
  assert.equal(f.calls.navigation.length,0);assert.equal(result.state.papers[0].attempts,1);
});

test('failed-only selection survives Pause, worker restart and Continue until explicitly expanded',async()=>{
  const state=createInitialState({papers:[record(1),record(2),record(3)]});
  state.papers[0].status='failed';state.papers[2].status='failed';
  const f=await createChromeFixture({persisted:{literatureBatchState:state}});
  await f.send({type:'RETRY_UNFINISHED',scope:'failed',settings});
  const first=await get(f);await f.send({type:'PAUSE'});await f.completeDownload(first.papers[0].downloadId);
  const restored=await createChromeFixture({persisted:f.persisted,session:f.session,downloadItems:[...f.downloads.values()]});
  await start(restored);const next=await get(restored);
  assert.equal(next.papers[1].status,'pending');assert.equal(next.papers[2].status,'downloading');
  await restored.completeDownload(next.papers[2].downloadId);await restored.advance(1500);
  assert.equal((await get(restored)).running,false);assert.equal((await get(restored)).papers[1].status,'pending');
  const all=await restored.send({type:'RETRY_UNFINISHED'});assert.equal(all.state.papers[1].status,'downloading');
  assert.equal(all.state.papers[0].status,'success');assert.equal(all.state.papers[2].status,'success');
});

test('download history timeout releases commands and keeps the live download bound for manual recovery',async()=>{
  const f=await createChromeFixture({bundle:{papers:[record(1),record(2)]}});await start(f);
  const state=await get(f),id=state.papers[0].downloadId,original=f.chrome.downloads.search;
  f.chrome.downloads.search=never;
  const read=get(f);await f.settle();await f.advance(6000);
  const paused=await read;assert.equal(paused.running,false);assert.equal(paused.activeId,'net-1');assert.equal(paused.papers[0].downloadId,id);
  f.chrome.downloads.search=original;await start(f);await f.completeDownload(id);
  assert.equal((await get(f)).papers[0].status,'success');assert.equal(f.calls.downloads.length,1);
});

test('late tab creation is closed without taking ownership of the next paper',async()=>{
  const f=await createChromeFixture({bundle:{papers:[{id:'doi',doi:'10.1234/late-tab'},record(2)]}});
  let resolveCreate;const originalCreate=f.chrome.tabs.create;
  f.chrome.tabs.create=()=>new Promise(resolve=>{resolveCreate=resolve;});
  const started=start(f);await f.settle();await f.advance(6000);await started;await f.advance(500);
  const next=(await get(f)).papers[1];assert.equal(next.status,'downloading');
  const late=await originalCreate({url:'https://sci-hub.box/'});resolveCreate(late);await f.settle();
  const state=await get(f);assert.equal(state.tabId,null);assert.equal(f.tabs.has(late.id),false);
  assert.equal(state.papers[1].downloadId,next.downloadId);
});

test('late download start is reconciled once without a duplicate transfer',async()=>{
  const f=await createChromeFixture({bundle:{papers:[record(1),record(2)]}});
  const original=f.chrome.downloads.download;let resolveStart,options;
  f.chrome.downloads.download=value=>{options=value;return new Promise(resolve=>{resolveStart=resolve;});};
  const started=start(f);await f.settle();await f.advance(6000);await started;
  const waiting=await get(f);assert.equal(waiting.papers[0].status,'downloading');assert.equal(waiting.papers[1].status,'pending');
  const id=await original(options);resolveStart(id);await f.settle();
  assert.equal((await get(f)).papers[0].downloadId,id);assert.equal(f.calls.downloads.length,1);
  await f.completeDownload(id);assert.equal((await get(f)).papers[0].status,'success');
});

test('a download response arriving after its total budget cannot attach to the next paper',async()=>{
  const f=await createChromeFixture({bundle:{papers:[record(1),record(2)]}});
  const original=f.chrome.downloads.download;let resolveStart,options;
  f.chrome.downloads.download=value=>{options=value;return new Promise(resolve=>{resolveStart=resolve;});};
  const started=start(f);await f.settle();await f.advance(6000);await started;
  f.chrome.downloads.download=original;
  await f.advance(25000);await f.advance(500);
  const next=(await get(f)).papers[1];assert.equal(next.status,'downloading');
  const lateId=await original(options);resolveStart(lateId);await f.settle();
  assert.equal(f.downloads.get(lateId).state,'interrupted');
  assert.equal((await get(f)).papers[1].downloadId,next.downloadId);
});

test('automatic retries share one total download budget across restarts',async()=>{
  const f=await createChromeFixture({bundle:{papers:[record(1),record(2)]}});await start(f);
  const before=await get(f),id=before.papers[0].downloadId;
  await f.advance(27000);
  Object.assign(f.downloads.get(id),{state:'interrupted',error:'NETWORK_TIMEOUT',canResume:false});
  await f.chrome.downloads.onChanged.emit({id,state:{current:'interrupted'}});await f.settle();await f.advance(2500);
  const retry=await get(f);assert.equal(retry.papers[0].downloadBudgetStartedAt,before.papers[0].downloadIntentAt);
  await f.advance(1500);
  const done=await get(f);assert.equal(done.papers[0].reasonCode,'download_timeout');
  assert.ok(f.calls.cancelled.includes(retry.papers[0].downloadId));
});

test('45 seconds without received bytes triggers bounded recovery before the five minute total',async()=>{
  const f=await createChromeFixture({bundle:{papers:[record(1),record(2)]}});
  await f.send({type:'START',limit:0,settings:{...settings,downloadTimeoutSeconds:300}});
  const id=(await get(f)).papers[0].downloadId;
  await f.advance(46000);
  assert.ok(f.calls.cancelled.includes(id),'Stalled transfer must be cancelled before retry');
  await f.advance(2500);
  const state=await get(f);assert.equal(state.papers[0].status,'downloading');
  assert.notEqual(state.papers[0].downloadId,id);assert.equal(state.papers[0].downloadRetryCount,1);
  assert.equal(state.papers[1].status,'pending');
});

test('slow transfers with increasing received bytes are not classified as stalled',async()=>{
  const f=await createChromeFixture({bundle:{papers:[record(1)]}});
  await f.send({type:'START',limit:0,settings:{...settings,downloadTimeoutSeconds:300}});
  const id=(await get(f)).papers[0].downloadId;
  for(let i=1;i<=4;i++){f.downloads.get(id).bytesReceived=100*i;await f.advance(40000);}
  assert.equal((await get(f)).papers[0].status,'downloading');assert.deepEqual(f.calls.cancelled,[]);
  await f.completeDownload(id);assert.equal((await get(f)).papers[0].status,'success');
});

test('retry unfinished retains an in-flight download and never downloads an already successful entry again',async()=>{
  const f=await createChromeFixture({bundle:{papers:[record(1),record(2),record(3)]}});await start(f);
  let state=await get(f);await f.completeDownload(state.papers[0].downloadId);await f.advance(500);
  await f.send({type:'PAUSE'});state=await get(f);const id=state.papers[1].downloadId;
  const retry=await f.send({type:'RETRY_UNFINISHED'});
  assert.equal(retry.ok,true,retry.error);assert.equal(retry.state.papers[0].status,'success');
  assert.equal(retry.state.papers[1].downloadId,id);assert.equal(retry.state.activeId,'net-2');
  await start(f);await f.completeDownload(id);await f.advance(500);
  assert.equal((await get(f)).papers[2].status,'downloading');
  assert.equal(f.calls.downloads.filter(item=>item.url===record(1).pdfUrl).length,1);
});
