import test from 'node:test';
import assert from 'node:assert/strict';
import {createChromeFixture} from './chrome-fixture.mjs';
import {createInitialState} from '../extension/core.js';

const papers=[1,2,3,4].map(i=>({id:`verify-${i}`,sourceIndex:i,title:`Verification fixture ${i}`,doi:`10.1234/verify-${i}`}));
const settings={delaySeconds:0.25,timeoutSeconds:25,resultTimeoutSeconds:12,downloadTimeoutSeconds:30,autoRobotNo:true,autoReopenVerification:false,verificationReopenSeconds:45};
const stateOf=async f=>(await f.send({type:'GET_STATE'})).state;

function mutableSite(initial={kind:'captcha',robotNo:true,readyState:'complete',message:'Manual verification required'}){
  let navigation=0,submitted=false;
  const site={outcome:initial,submissions:[],noClicks:0,script(options){
    const {func,args,calls}=options;
    if(calls.navigation.length!==navigation){navigation=calls.navigation.length;submitted=false;}
    if(func.name==='installPageWatcher')return {ok:true};
    if(func.name==='clickRobotNo'){site.noClicks++;return {status:'clicked'};}
    if(func.name==='submitDoi'){submitted=true;site.submissions.push(args[0]);site.onSubmit?.(args[0]);return {ok:true};}
    if(func.name==='inspectPage')return submitted?site.outcome:{kind:'home',url:'https://sci-hub.box/',readyState:'complete'};
    throw Error(`Unexpected injected function ${func.name}`);
  }};
  return site;
}
async function until(f,predicate,label,iterations=120){
  for(let i=0;i<iterations;i++){const state=await stateOf(f);if(predicate(state))return state;await f.advance(250);}
  assert.fail(`Never reached ${label}: ${JSON.stringify(await stateOf(f))}`);
}

test('manual No completion after automatic-click timeout resumes the same DOI without pressing Start',async()=>{
  const site=mutableSite();
  const f=await createChromeFixture({bundle:{papers},scriptHandler:site.script});
  await f.send({type:'START',limit:3,settings});
  await until(f,s=>s.papers[0].robotClicks===1,'automatic click');
  await f.advance(22000);
  const waiting=await stateOf(f);
  assert.equal(waiting.running,false);
  assert.equal(waiting.papers[0].status,'searching');
  site.outcome={kind:'pdf',url:'https://files.fixture.example/manual-finish.pdf',readyState:'complete'};
  await f.chrome.tabs.onUpdated.emit(waiting.tabId,{status:'complete'});
  await f.settle();
  await f.advance(1000);
  const resumed=await stateOf(f);
  assert.equal(resumed.papers[0].status,'downloading');
  assert.equal(resumed.running,true);
  assert.equal(resumed.papers[0].attempts,1);
  assert.equal(resumed.runId,waiting.runId);
  assert.equal(resumed.processedThisRun,waiting.processedThisRun);
  assert.equal(site.noClicks,1);
});

async function waitingFixture({autoRobotNo=false}={}){
  const site=mutableSite();
  const f=await createChromeFixture({bundle:{papers},scriptHandler:site.script});
  await f.send({type:'START',limit:3,settings:{...settings,autoRobotNo}});
  const waiting=await until(f,s=>s.waitingForVerification,'verification waiting');
  return {f,site,waiting};
}

test('manual verification may take minutes and unknown intermediate pages never trigger resume',async()=>{
  const {f,site}=await waitingFixture();
  await f.advance(120000);
  let state=await stateOf(f);
  assert.equal(state.waitingForVerification,true);
  assert.equal(state.pauseKind,'verification');
  assert.equal(state.papers[0].status,'searching');
  assert.equal(state.phaseDeadlineAt,0);
  site.outcome={kind:'unknown',readyState:'complete'};
  await f.advance(60000);
  state=await stateOf(f);
  assert.equal(state.waitingForVerification,true);
  assert.equal(state.running,false);
  assert.equal(f.calls.downloads.length,0);
  site.outcome={kind:'pdf',url:'https://files.fixture.example/slow-manual.pdf',readyState:'complete'};
  await f.advance(1000);
  state=await stateOf(f);
  assert.equal(state.papers[0].status,'downloading');
  assert.equal(state.waitingForVerification,false);
  assert.equal(state.papers[0].attempts,1);
});

test('verification navigation to a new PDF document resumes without a Start command',async()=>{
  const {f,site,waiting}=await waitingFixture();
  site.outcome={kind:'pdf',url:'https://files.fixture.example/new-document.pdf',readyState:'interactive'};
  f.tabs.get(waiting.tabId).documentId='manually-verified-new-document';
  await f.chrome.webNavigation.onDOMContentLoaded.emit({tabId:waiting.tabId,frameId:0,documentId:'manually-verified-new-document',url:'https://sci-hub.box/'});
  await f.settle();
  const state=await stateOf(f);
  assert.equal(state.papers[0].status,'downloading');
  assert.equal(state.papers[0].attempts,1);
  assert.equal(state.processedThisRun,waiting.processedThisRun);
});

test('verification redirect to homepage resubmits the same DOI once without increasing attempts',async()=>{
  const {f,site,waiting}=await waitingFixture();
  site.outcome={kind:'home',url:'https://sci-hub.box/',readyState:'complete'};
  site.onSubmit=()=>{site.outcome={kind:'pdf',url:'https://files.fixture.example/resubmitted.pdf',readyState:'complete'};};
  f.tabs.get(waiting.tabId).documentId='verification-redirect-home';
  await f.chrome.webNavigation.onCommitted.emit({tabId:waiting.tabId,frameId:0,documentId:'verification-redirect-home',url:'https://sci-hub.box/'});
  await f.settle();
  const state=await until(f,s=>s.papers[0].status==='downloading','same DOI resubmitted');
  assert.deepEqual(site.submissions,[papers[0].doi,papers[0].doi]);
  assert.equal(state.papers[0].attempts,1);
  assert.equal(state.papers[0].verificationHomeResubmits,1);
  assert.equal(state.runId,waiting.runId);
});

test('manual verification yielding explicit not-found records failure and continues to next paper',async()=>{
  const {f,site}=await waitingFixture();
  site.outcome={kind:'not_found',message:'Article not found',readyState:'complete'};
  await f.advance(1000);
  const state=await stateOf(f);
  assert.equal(state.papers[0].status,'failed');
  assert.equal(state.papers[0].reasonCode,'not_found');
  assert.equal(state.running,true);
  assert.equal(state.waitingForVerification,false);
  assert.equal(state.processedThisRun,1);
});

test('explicit user pause cancels automatic verification resume',async()=>{
  const {f,site,waiting}=await waitingFixture();
  await f.send({type:'PAUSE'});
  site.outcome={kind:'pdf',url:'https://files.fixture.example/user-paused.pdf',readyState:'complete'};
  await f.chrome.tabs.onUpdated.emit(waiting.tabId,{status:'complete'});
  await f.advance(60000);
  const state=await stateOf(f);
  assert.equal(state.running,false);
  assert.equal(state.waitingForVerification,false);
  assert.equal(state.pauseKind,'user');
  assert.equal(state.papers[0].status,'searching');
  assert.equal(f.calls.downloads.length,0);
});

test('closing the managed tab cancels verification waiting instead of reopening it',async()=>{
  const {f,waiting}=await waitingFixture();
  await f.chrome.tabs.remove(waiting.tabId);
  await f.settle();
  await f.advance(60000);
  const state=await stateOf(f);
  assert.equal(state.running,false);
  assert.equal(state.waitingForVerification,false);
  assert.equal(state.pauseKind,'tab_closed');
  assert.equal(state.tabId,null);
  assert.equal(f.tabs.size,0);
  assert.equal(f.calls.navigation.length,1);
});

test('same-browser worker recovery retains verification waiting and resumes a now-visible PDF',async()=>{
  const {f,waiting}=await waitingFixture();
  const recovered=await createChromeFixture({persisted:f.persisted,session:f.session,tabItems:[...f.tabs.values()],scriptHandler:options=>{
    if(options.func.name==='inspectPage')return {kind:'pdf',url:'https://files.fixture.example/recovered-manual.pdf',readyState:'complete'};
    if(options.func.name==='installPageWatcher')return {ok:true};
    throw Error('Recovery must not resubmit or click again');
  }});
  const state=await until(recovered,s=>s.papers[0].status==='downloading','worker recovered verification');
  assert.equal(state.runId,waiting.runId);
  assert.equal(state.papers[0].attempts,1);
  assert.equal(state.waitingForVerification,false);
});

test('full browser restart disables verification autoresume even if PDF is now visible',async()=>{
  const {f}=await waitingFixture();
  const restarted=await createChromeFixture({persisted:f.persisted,tabItems:[...f.tabs.values()],scriptHandler:()=>({kind:'pdf',url:'https://files.fixture.example/restart.pdf',readyState:'complete'})});
  await restarted.advance(60000);
  const state=await stateOf(restarted);
  assert.equal(state.running,false);
  assert.equal(state.waitingForVerification,false);
  assert.equal(state.pauseKind,'browser_restart');
  assert.equal(state.papers[0].status,'searching');
  assert.equal(restarted.calls.downloads.length,0);
});

test('automatic verification resume preserves remaining trial count and stops after third attempt',async()=>{
  const saved=createInitialState({papers});
  saved.settings={...settings,autoRobotNo:false};
  Object.assign(saved,{running:true,activeId:papers[2].id,tabId:11,phase:'result',currentDocumentId:'trial-result',blockedDocumentId:'old-home',phaseStartedAt:Date.parse('2026-10-05T12:00:00Z'),processedThisRun:2,limit:3,runId:7});
  saved.papers[0].status='success';saved.papers[1].status='failed';
  Object.assign(saved.papers[2],{status:'searching',attempts:1,submittedAt:'2026-10-05T12:00:00Z'});
  let outcome={kind:'captcha',robotNo:false,readyState:'complete',message:'Manual challenge'};
  const f=await createChromeFixture({persisted:{literatureBatchState:saved},session:{literatureBatchSession:1},tabItems:[{id:11,documentId:'trial-result',url:'https://sci-hub.box/',status:'complete'}],scriptHandler:options=>options.func.name==='installPageWatcher'?{ok:true}:outcome});
  await until(f,s=>s.waitingForVerification,'trial verification wait');
  outcome={kind:'pdf',url:'https://files.fixture.example/trial-last.pdf',readyState:'complete'};
  const downloading=await until(f,s=>s.papers[2].status==='downloading','third trial download');
  await f.completeDownload(downloading.papers[2].downloadId);
  const done=await stateOf(f);
  assert.equal(done.running,false);
  assert.equal(done.processedThisRun,3);
  assert.equal(done.papers[3].status,'pending');
  assert.equal(done.papers[2].attempts,1);
  assert.equal(done.runId,7);
});

test('manual Reopen Current replaces only managed tab and preserves DOI, attempt and trial counts',async()=>{
  const {f,site,waiting}=await waitingFixture();
  const unrelated=await f.chrome.tabs.create({url:'https://unrelated.fixture.example/',active:false});
  const result=await f.send({type:'REOPEN_CURRENT'});
  assert.equal(result.ok,true,result.error);
  const state=await until(f,s=>s.waitingForVerification,'challenge in reopened managed tab');
  assert.notEqual(state.tabId,waiting.tabId);
  assert.equal(f.tabs.has(waiting.tabId),false);
  assert.equal(f.tabs.has(unrelated.id),true);
  assert.deepEqual(site.submissions,[papers[0].doi,papers[0].doi]);
  assert.equal(state.papers[0].attempts,1);
  assert.equal(state.papers[0].pageRecoveryCount,1);
  assert.equal(state.runId,waiting.runId);
  assert.equal(state.limit,waiting.limit);
  assert.equal(state.processedThisRun,waiting.processedThisRun);
  await f.chrome.tabs.onRemoved.emit(waiting.tabId,{});
  await f.settle();
  assert.equal((await stateOf(f)).waitingForVerification,true);
});

test('automatic verification recovery runs once after 45 seconds and does not loop on a repeated challenge',async()=>{
  const site=mutableSite();
  const f=await createChromeFixture({bundle:{papers},scriptHandler:site.script});
  await f.send({type:'START',limit:3,settings:{...settings,autoRobotNo:false,autoReopenVerification:true}});
  const waiting=await until(f,s=>s.waitingForVerification,'automatic recovery countdown');
  await f.advance(44000);
  assert.equal((await stateOf(f)).tabId,waiting.tabId);
  await f.advance(1100);
  let state=await until(f,s=>s.waitingForVerification&&s.tabId!==waiting.tabId,'single automatic recovery');
  assert.equal(state.papers[0].automaticPageRecoveries,1);
  assert.equal(state.papers[0].pageRecoveryCount,1);
  assert.equal(state.papers[0].attempts,1);
  assert.deepEqual(site.submissions,[papers[0].doi,papers[0].doi]);
  const recoveredId=state.tabId;
  await f.advance(180000);
  state=await stateOf(f);
  assert.equal(state.tabId,recoveredId);
  assert.equal(state.papers[0].automaticPageRecoveries,1);
  assert.equal(f.calls.navigation.length,2);
});

test('manual Pause cancels the automatic reopen timer',async()=>{
  const site=mutableSite();
  const f=await createChromeFixture({bundle:{papers},scriptHandler:site.script});
  await f.send({type:'START',limit:3,settings:{...settings,autoRobotNo:false,autoReopenVerification:true}});
  const waiting=await until(f,s=>s.waitingForVerification,'pending automatic recovery');
  await f.send({type:'PAUSE'});
  await f.advance(120000);
  const state=await stateOf(f);
  assert.equal(state.tabId,waiting.tabId);
  assert.equal(state.pauseKind,'user');
  assert.equal(state.waitingForVerification,false);
  assert.equal(f.calls.navigation.length,1);
});

test('legacy verification pause is recovered while legacy explicit user pause remains stopped',async()=>{
  for(const manualPause of [false,true]){
    const saved=createInitialState({papers});
    delete saved.waitingForVerification;delete saved.pauseKind;delete saved.verification;delete saved.controlVersion;
    saved.settings={...settings,autoRobotNo:false};
    Object.assign(saved,{running:false,activeId:papers[0].id,tabId:12,phase:'result',currentDocumentId:'legacy-captcha',blockedDocumentId:'old-home',phaseStartedAt:Date.parse('2026-10-05T12:00:00Z'),pauseReason:manualPause?'已手动暂停；正在进行的浏览器下载会继续核对，后续文献不会开始。':'已点击 No，但网站验证仍未完成。请人工处理或跳过当前条。'});
    Object.assign(saved.papers[0],{status:'searching',attempts:1,submittedAt:'2026-10-05T12:00:00Z'});
    const f=await createChromeFixture({persisted:{literatureBatchState:saved},session:{literatureBatchSession:1},tabItems:[{id:12,url:'https://sci-hub.box/',status:'complete',documentId:'legacy-captcha'}],scriptHandler:options=>options.func.name==='installPageWatcher'?{ok:true}:{kind:'pdf',url:'https://files.fixture.example/legacy.pdf',readyState:'complete'}});
    await f.advance(1000);
    const state=await stateOf(f);
    assert.equal(state.papers[0].status,manualPause?'searching':'downloading');
    assert.equal(f.calls.downloads.length,manualPause?0:1);
  }
});

test('Skip after failed page recovery clears the old intent so Start can process the next DOI',async()=>{
  const saved=createInitialState({papers});
  saved.settings={...settings};
  Object.assign(saved,{running:false,pauseKind:'error',activeId:papers[0].id,tabId:11,phase:'reopening',recoveryIntent:{paperId:papers[0].id,oldTabId:11,oldClosed:false,token:'failed-old-recovery',startedAt:Date.parse('2026-10-05T12:00:00Z')}});
  Object.assign(saved.papers[0],{status:'searching',attempts:1});
  const site=mutableSite({kind:'pdf',url:'https://files.fixture.example/after-failed-recovery.pdf',readyState:'complete'});
  const f=await createChromeFixture({persisted:{literatureBatchState:saved},session:{literatureBatchSession:1},tabItems:[{id:11,url:'https://sci-hub.box/',status:'complete',documentId:'old-failed-recovery'}],scriptHandler:site.script});
  const skipped=await f.send({type:'SKIP_CURRENT'});
  assert.equal(skipped.ok,true);
  assert.equal(skipped.state.papers[0].reasonCode,'skipped_by_user');
  assert.equal(skipped.state.recoveryIntent,null);
  await f.send({type:'START',limit:3});
  const resumed=await until(f,s=>s.papers[1].status==='downloading','next DOI after stale recovery skip');
  assert.equal(resumed.papers[1].attempts,1);
  assert.deepEqual(site.submissions,[papers[1].doi]);
  assert.equal(resumed.recoveryIntent,null);
});

test('browser restart never closes or navigates an unrelated tab that reused the old task tab ID',async()=>{
  const saved=createInitialState({papers});
  saved.settings={...settings};
  Object.assign(saved,{running:true,activeId:papers[0].id,tabId:7,phase:'reopening',currentDocumentId:'old-session-document',recoveryIntent:{paperId:papers[0].id,oldTabId:7,oldClosed:false,token:'previous-session-recovery',startedAt:Date.parse('2026-10-05T11:00:00Z')}});
  Object.assign(saved.papers[0],{status:'searching',attempts:1,pageRecoveryCount:1});
  const site=mutableSite({kind:'pdf',url:'https://files.fixture.example/safe-restart.pdf',readyState:'complete'});
  const f=await createChromeFixture({persisted:{literatureBatchState:saved},tabItems:[{id:7,url:'https://unrelated.fixture.example/important',status:'complete',documentId:'new-unrelated-document'}],scriptHandler:site.script});
  const stopped=await stateOf(f);
  assert.equal(stopped.pauseKind,'browser_restart');
  assert.equal(stopped.tabId,null);
  await f.send({type:'START',limit:3});
  const resumed=await until(f,s=>s.papers[0].status==='downloading','new safely managed task tab');
  assert.notEqual(resumed.tabId,7);
  assert.equal(f.tabs.get(7).url,'https://unrelated.fixture.example/important');
  assert.equal(f.tabs.get(7).documentId,'new-unrelated-document');
  assert.equal(resumed.papers[0].attempts,1);
});
