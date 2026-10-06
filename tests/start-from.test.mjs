import test from 'node:test';
import assert from 'node:assert/strict';
import {createChromeFixture} from './chrome-fixture.mjs';
import {createInitialState} from '../extension/core.js';

const papers=[1,2,3,4,5].map(i=>({id:`range-${i}`,sourceIndex:i===5?'0500':String(i).padStart(4,'0'),title:i===5?'Selected: Fifth/Paper':`Range paper ${i}`,doi:`10.1234/range-${i}`}));
const settings={delaySeconds:0.25,timeoutSeconds:25,resultTimeoutSeconds:12,downloadTimeoutSeconds:30,autoReopenVerification:false};
const stateOf=async f=>(await f.send({type:'GET_STATE'})).state;
function site(){let navigation=0,doi=null;return options=>{
  if(navigation!==options.calls.navigation.length){navigation=options.calls.navigation.length;doi=null;}
  if(options.func.name==='installPageWatcher')return {ok:true};
  if(options.func.name==='submitDoi'){doi=options.args[0];return {ok:true};}
  if(options.func.name==='inspectPage')return doi?{kind:'pdf',url:`https://files.fixture.example/${encodeURIComponent(doi)}.pdf`,readyState:'complete'}:{kind:'home',url:'https://sci-hub.box/',readyState:'complete'};
  throw Error(`Unexpected script ${options.func.name}`);
};}
async function until(f,predicate,label){for(let i=0;i<60;i++){const s=await stateOf(f);if(predicate(s))return s;await f.advance(250);}assert.fail(`Never reached ${label}: ${JSON.stringify(await stateOf(f))}`);}
async function fresh(extra={}){return createChromeFixture({bundle:{papers},scriptHandler:site(),...extra});}

test('start at the last list position preserves earlier pending papers and original filename numbering',async()=>{
  const f=await fresh();
  const response=await f.send({type:'START_FROM',startFromNumber:5,settings});
  assert.equal(response.ok,true,response.error);
  const downloading=await until(f,s=>s.papers[4].status==='downloading','last-position download');
  assert.equal(downloading.startFromNumber,5);
  assert.deepEqual(downloading.papers.slice(0,4).map(p=>p.status),['pending','pending','pending','pending']);
  assert.match(downloading.papers[4].filename,/^LiteratureBatch\/0500_Selected_ Fifth_Paper_/);
  assert.equal(downloading.papers[4].sourceIndex,'0500');
  await f.completeDownload(downloading.papers[4].downloadId);
  await until(f,s=>!s.running,'end of selected range');
  await f.send({type:'START',limit:0});
  const done=await stateOf(f);
  assert.equal(done.running,false);
  assert.equal(done.startFromNumber,5);
  assert.deepEqual(done.papers.slice(0,4).map(p=>p.status),['pending','pending','pending','pending']);
  assert.equal(f.calls.downloads.length,1);
});

test('invalid start boundaries and invalid settings leave the entire saved state unchanged',async()=>{
  const f=await fresh();
  const before=await stateOf(f);
  for(const startFromNumber of [0,-1,6,1.5,'2',true,null,[2]]){
    const result=await f.send({type:'START_FROM',startFromNumber,settings});
    assert.equal(result.ok,false,`Accepted invalid range ${JSON.stringify(startFromNumber)}`);
    assert.deepEqual(await stateOf(f),before);
  }
  const invalidSettings=await f.send({type:'START_FROM',startFromNumber:2,settings:{delaySeconds:999}});
  assert.equal(invalidSettings.ok,false);
  assert.deepEqual(await stateOf(f),before);
  assert.equal(f.calls.navigation.length,0);
});

test('starting from a range skips existing success, failed and missing-DOI records without resetting them',async()=>{
  const saved=createInitialState({papers});
  saved.settings={...saved.settings,...settings};
  Object.assign(saved.papers[1],{status:'success',attempts:1,downloadId:99,filename:'Already-downloaded.pdf'});
  Object.assign(saved.papers[2],{status:'failed',attempts:2,reasonCode:'not_found'});
  Object.assign(saved.papers[3],{status:'missing_doi',doi:'',attempts:0});
  const f=await fresh({persisted:{literatureBatchState:saved}});
  const existing=saved.papers.slice(1,4);
  await f.send({type:'START_FROM',startFromNumber:2});
  const state=await until(f,s=>s.papers[4].status==='downloading','next eligible pending record');
  assert.deepEqual(state.papers.slice(1,4),existing);
  assert.equal(state.papers[0].status,'pending');
  assert.equal(f.calls.downloads.length,1);
});

test('changing the start from a paused search preserves its attempt history and downloads only the selected DOI',async()=>{
  const saved=createInitialState({papers});
  saved.settings={...saved.settings,...settings};
  Object.assign(saved,{running:false,activeId:papers[0].id,tabId:11,phase:'result',pauseKind:'user',watchId:'old-paper-watcher',currentDocumentId:'old-paused-document'});
  Object.assign(saved.papers[0],{status:'searching',attempts:2,startedAt:'2026-10-05T11:55:00Z',lastFailure:{reasonCode:'not_found'}});
  const f=await fresh({persisted:{literatureBatchState:saved},session:{literatureBatchSession:1},tabItems:[{id:11,url:'https://sci-hub.box/',status:'complete',documentId:'old-paused-document'}]});
  await f.send({type:'START_FROM',startFromNumber:3});
  await f.send({type:'PAGE_CHANGED',watchId:'old-paper-watcher'},{id:f.chrome.runtime.id,url:'https://sci-hub.box/',tab:{id:11},frameId:0,documentId:'old-paused-document'});
  const state=await until(f,s=>s.papers[2].status==='downloading','selected third DOI');
  assert.equal(state.papers[0].status,'pending');
  assert.equal(state.papers[0].attempts,2);
  assert.equal(state.papers[0].lastFailure.reasonCode,'not_found');
  assert.ok(state.papers[0].lastInterruptedSearch);
  assert.equal(state.papers[1].status,'pending');
  assert.match(f.calls.downloads[0].url,/range-3/);
});

test('running queue, verification waiting, and paused live download reject Start From',async()=>{
  for(const condition of ['running','verification','downloading']){
    const saved=createInitialState({papers});saved.settings={...saved.settings,...settings};
    Object.assign(saved,{running:condition==='running',waitingForVerification:condition==='verification',pauseKind:condition==='verification'?'verification':'user',activeId:papers[0].id,tabId:11,phase:'result'});
    Object.assign(saved.papers[0],{status:condition==='downloading'?'downloading':'searching',attempts:1,downloadId:condition==='downloading'?10:null,downloadIntentAt:Date.parse('2026-10-05T12:00:00Z')});
    const f=await fresh({persisted:{literatureBatchState:saved},session:{literatureBatchSession:1},tabItems:[{id:11,url:'https://sci-hub.box/',status:'complete',documentId:'current'}],downloadItems:condition==='downloading'?[{id:10,state:'in_progress',mime:'application/pdf',fileSize:-1}]:[],scriptHandler:options=>options.func.name==='installPageWatcher'?{ok:true}:{kind:'unknown',readyState:'complete'}});
    const before=await stateOf(f);
    const result=await f.send({type:'START_FROM',startFromNumber:4});
    assert.equal(result.ok,false,condition);
    const after=await stateOf(f);
    assert.equal(after.startFromNumber,before.startFromNumber);
    assert.deepEqual(after.papers,before.papers);
    assert.equal(after.activeId,before.activeId);
  }
});

test('worker restore and ordinary Start retain the selected range; importing a new list resets it to one',async()=>{
  const f=await fresh();
  await f.send({type:'START_FROM',startFromNumber:4,settings});
  const fourth=await until(f,s=>s.papers[3].status==='downloading','fourth record');
  await f.completeDownload(fourth.papers[3].downloadId);
  await f.send({type:'PAUSE'});
  const recovered=await fresh({persisted:f.persisted,session:f.session,tabItems:[...f.tabs.values()]});
  assert.equal((await stateOf(recovered)).startFromNumber,4);
  await recovered.send({type:'START',limit:0});
  const fifth=await until(recovered,s=>s.papers[4].status==='downloading','remaining item inside range');
  assert.deepEqual(fifth.papers.slice(0,3).map(p=>p.status),['pending','pending','pending']);
  await recovered.completeDownload(fifth.papers[4].downloadId);
  await until(recovered,s=>!s.running,'range end after restore');
  const imported=await recovered.send({type:'IMPORT',papers:[{title:'Unnumbered RIS paper',doi:'10.1234/new-one'},{title:'Other unnumbered record',doi:'10.1234/new-two'}],sourceName:'new.ris'});
  assert.equal(imported.ok,true);
  assert.equal(imported.state.startFromNumber,1);
  assert.deepEqual(imported.state.papers.map(p=>p.sourceIndex),['1','2']);
  await recovered.send({type:'START',limit:0});
  const newFirst=await until(recovered,s=>s.papers[0].status==='downloading','first imported record');
  assert.match(newFirst.papers[0].filename,/^LiteratureBatch\/0001_Unnumbered RIS paper_/);
});
