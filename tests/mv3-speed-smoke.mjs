// Real MV3 regression test: all site pages and PDF downloads are local fixtures.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {loadPlaywright, loadModule} from './browser-env.mjs';
const {chromium} = loadPlaywright();
const {PDFDocument, StandardFonts} = loadModule('pdf-lib');
const extensionDir=path.resolve(import.meta.dirname,'../extension');
const crossSiteOnly=process.argv.includes('--cross-site-only');
const startFromOnly=process.argv.includes('--start-from-only');
const work=await fs.mkdtemp(path.join(os.tmpdir(),'literature-extension-speed-test-'));
const downloadDir=path.join(work,'downloads');await fs.mkdir(downloadDir);
const profileDir=path.join(work,'profile');
if(startFromOnly){
  await fs.mkdir(path.join(profileDir,'Default'),{recursive:true});
  await fs.writeFile(path.join(profileDir,'Default','Preferences'),JSON.stringify({download:{default_directory:downloadDir,prompt_for_download:false,directory_upgrade:true},savefile:{default_directory:downloadDir}}));
}
const document=await PDFDocument.create(),font=await document.embedFont(StandardFonts.Helvetica),pdfPage=document.addPage();
pdfPage.drawText('LOCAL TEST FIXTURE - NOT A RESEARCH ARTICLE',{x:40,y:750,size:16,font});
for(let i=0;i<40;i++)pdfPage.drawText(`Download fixture line ${i+1}: ${'abcdefghijklmnopqrstuvwxyz'.repeat(2)}`,{x:40,y:720-i*15,size:8,font});
const pdf=Buffer.from(await document.save({useObjectStreams:false}));
let requests=0,noClicks=0;const routeLog=[],postAt=new Map(),manualClicks=new Map(),manualPosts=new Map();
const server=http.createServer((req,res)=>{requests++;res.writeHead(200,{'content-type':'application/pdf','content-length':pdf.length});res.end(pdf);});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port;
const pdfHtml=label=>`<h1>${label}</h1><iframe id="pdf" src="http://fixture-pdf.test:${port}/${label}.pdf"></iframe>`;
const pendingFrame='<iframe style="display:none" src="/fixture-never-finishes"></iframe>';
const records=(startFromOnly?[
  {id:'before-range',doi:'10.1234/should-stay-pending',title:'Earlier paper must remain pending'},
  {id:'range-second',doi:'10.1234/start-from-second',title:'Start range second paper'},
  {id:'range-third',doi:'10.1234/start-from-third',title:'Start range third paper'},
]:crossSiteOnly?[
  {id:'cross-site',doi:'10.1111/scd.12848',title:'Captured sci-net page with synthetic PDF'},
  {id:'next-pdf',doi:'10.1234/next-pdf',title:'Next DOI returns to original search homepage'},
]:[
  {id:'missing-result',doi:'10.1234/missing-result',title:'Explicit not-found fixture'},
  {id:'loading-pdf',doi:'10.1234/loading-pdf',title:'PDF with never-finished subframe'},
  {id:'unknown',doi:'10.1234/unknown',title:'Unknown result should be retryable'},
  {id:'robot-no',doi:'10.1234/robot-no',title:'Local robot No button fixture'},
  {id:'next-pdf',doi:'10.1234/next-pdf',title:'Next PDF after completed download'},
  {id:'missing-doi',doi:'',title:'Citation without DOI'},
]).map((paper,index)=>({...paper,sourceIndex:String(index+1).padStart(4,'0')}));
let context;
try{
  context=await chromium.launchPersistentContext(profileDir,{
    executablePath: process.env.CHROMIUM_EXE || undefined,
    headless:true,acceptDownloads:true,
    args:[`--disable-extensions-except=${extensionDir}`,`--load-extension=${extensionDir}`,'--no-proxy-server','--host-resolver-rules=MAP fixture-pdf.test 127.0.0.1, MAP sci-hub.box ~NOTFOUND, MAP sci-net.xyz ~NOTFOUND'],
  });
  await context.route(/^https:\/\//,route=>route.abort());
  await context.route('https://sci-net.xyz/**',async route=>{
    routeLog.push({method:route.request().method(),url:route.request().url(),at:Date.now()});
    if(route.request().resourceType()!=='document')return route.fulfill({status:200,body:''});
    const captured=(await fs.readFile(path.join(import.meta.dirname,'../data/site-sci-net-observed.html'),'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
    const frame=captured.match(/<iframe\b[^>]*src\s*=\s*(['"])(.*?)\1/i);
    assert.ok(frame,'Captured page must contain the observed iframe');
    const body=captured.replace(frame[0],frame[0].replace(frame[2],`http://fixture-pdf.test:${port}/captured-sci-net-fixture.pdf`));
    return route.fulfill({status:200,contentType:'text/html',body});
  });
  await context.route('https://sci-hub.box/**',async route=>{
    const req=route.request(),url=new URL(req.url());
    routeLog.push({method:req.method(),url:req.url(),at:Date.now()});
    if(url.pathname==='/fixture-never-finishes')return; // Intentionally unresolved frame.
    if(url.pathname==='/fixture-no-click'){noClicks++;return route.fulfill({status:200,body:'LOCAL CLICK RECORDED'});}
    if(url.pathname==='/fixture-manual-click'){const key=url.searchParams.get('case');manualClicks.set(key,(manualClicks.get(key)||0)+1);return route.fulfill({status:200,body:'LOCAL MANUAL CLICK RECORDED'});}
    if(url.pathname==='/fixture-verified-pdf')return route.fulfill({contentType:'text/html',body:pdfHtml('manual-new-document')});
    let html;
    if(req.method()==='POST'){
      const doi=new URLSearchParams(req.postData()||'').get('request');postAt.set(doi,Date.now());
      if(doi==='10.1111/scd.12848')return route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><script>location.replace("https://sci-net.xyz/10.1111/scd.12848");</script>'});
      if(doi?.startsWith('10.1234/manual-')){
        const scenario=doi.slice('10.1234/'.length);manualPosts.set(scenario,(manualPosts.get(scenario)||0)+1);
        if(scenario==='manual-home'&&manualPosts.get(scenario)>1)html=pdfHtml('manual-home-resubmitted');
        else{
          const resolved=scenario==='manual-home'?"location.href='/fixture-verified-home'":scenario==='manual-new'?"location.href='/fixture-verified-pdf'":`document.title='Manual fixture resolved';document.body.innerHTML=${JSON.stringify(pdfHtml('manual-same-document'))}`;
          html=`<title>Sci-Hub: are you a robot?</title><div class="question"><div class="ask">Are you a robot?</div><div class="answer" onclick="check()">No</div><altcha-widget style="display:none"></altcha-widget></div><script>window.localClicks=0;window.check=function(){window.localClicks++;fetch('/fixture-manual-click?case=${scenario}');${scenario==='manual-timeout'?'if(window.localClicks<2)return;':''}${resolved};};</script>`;
        }
      }
      else if(doi==='10.1234/missing-result')html='<h1>The requested article is not available in the database.</h1>'+pendingFrame;
      else if(doi==='10.1234/unknown')html='<h1>Unrecognized result fixture</h1>'+pendingFrame;
      else if(doi==='10.1234/robot-no')html=`<title>Sci-Hub: are you a robot?</title><div class="question"><div class="ask" translate="en:isrobot">Are you a robot?</div><div class="answer" onclick="check()" translate="en:nope">No</div><altcha-widget style="display:none" challengeurl="/captcha/challenge/local-only"></altcha-widget></div><script>window.check=function(){fetch('/fixture-no-click');document.title='Resolved local fixture';document.body.innerHTML=${JSON.stringify(pdfHtml('robot-resolved'))};};</script>`;
      else html=pdfHtml(doi.split('/')[1])+pendingFrame;
    }else html='<form method="POST" action="/"><textarea name="request"></textarea><button type="submit">open</button></form>'+pendingFrame;
    await route.fulfill({status:200,contentType:'text/html',body:`<!doctype html><html><body>${html}</body></html>`});
  });
  let worker=context.serviceWorkers()[0];if(!worker)worker=await context.waitForEvent('serviceworker',{timeout:15000});
  const extensionId=new URL(worker.url()).hostname,page=await context.newPage();
  const cdp=await context.newCDPSession(page);
  await cdp.send('Browser.setDownloadBehavior',startFromOnly?{behavior:'default',eventsEnabled:true}:{behavior:'allow',downloadPath:downloadDir,eventsEnabled:true});
  await page.goto(`chrome-extension://${extensionId}/dashboard.html`);
  await page.waitForFunction(() => /^\d+$/.test(document.getElementById('totalCount').textContent));
  const message=payload=>page.evaluate(message=>chrome.runtime.sendMessage(message),payload);
  const initial=await message({type:'GET_STATE'});
  // A private build may bundle a starting list; the public build starts empty. Either is replaced below.
  assert.ok(Array.isArray(initial.state.papers));
  assert.equal((await message({type:'IMPORT',sourceName:'LOCAL SPEED FIXTURES',papers:records})).ok,true);
  const started=await message({type:startFromOnly?'START_FROM':'START',limit:0,...(startFromOnly?{startFromNumber:2}:{}),settings:{delaySeconds:0.25,timeoutSeconds:8,resultTimeoutSeconds:2,downloadTimeoutSeconds:30,autoRobotNo:true}});
  assert.equal(started.ok,true,started.error);
  let result;const startedAt=Date.now(),deadline=startedAt+30000;
  do{
    result=await message({type:'GET_STATE'});
    if(!result.state.running)break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }while(Date.now()<deadline);
  const papers=result.state.papers;
  if(result.state.running||papers.some(p=>p.status==='searching')||(crossSiteOnly&&papers.some(p=>p.status!=='success'))||(!crossSiteOnly&&!startFromOnly&&(papers[0].reasonCode!=='not_found'||papers[2].reasonCode!=='detection_timeout'))){
    await fs.writeFile(path.join(import.meta.dirname,'mv3-speed-failure.json'),JSON.stringify({routeLog,requests,noClicks,state:result.state},null,2));
    console.log(JSON.stringify({routeLog,requests,noClicks,state:result.state},null,2));
  }
  if(startFromOnly){
    assert.deepEqual(papers.map(p=>p.status),['pending','success','success']);
    assert.equal(result.state.startFromNumber,2);
    assert.equal(postAt.has('10.1234/should-stay-pending'),false);
  }else if(crossSiteOnly){
    assert.deepEqual(papers.map(p=>p.status),['success','success'],JSON.stringify(result.state));
    assert.ok(routeLog.some(entry=>entry.url==='https://sci-net.xyz/10.1111/scd.12848'));
    assert.ok(routeLog.filter(entry=>entry.url==='https://sci-hub.box/'&&entry.method==='GET').length>=2,'Next DOI must return to the original homepage');
  }else{
    assert.deepEqual(papers.map(p=>p.status),['failed','success','failed','success','success','missing_doi']);
    assert.equal(papers[0].reasonCode,'not_found');
    assert.equal(papers[2].reasonCode,'detection_timeout');
    assert.equal(noClicks,1,'Exact No action must be bounded to one click');
    assert.equal(papers[3].robotClicks,1);
    assert.ok(Date.parse(papers[0].finishedAt)-postAt.get(papers[0].doi)<5000,'Explicit absence must not wait for pending subframe');
    assert.ok(Date.parse(papers[2].finishedAt)-postAt.get(papers[2].doi)<6000,'Unknown result must use short retryable timeout');
  }
  const saved=[];
  for(const paper of papers.filter(p=>p.status==='success')){
    const item=await page.evaluate(async id=>(await chrome.downloads.search({id}))[0],paper.downloadId);
    assert.equal(item.mime,'application/pdf');assert.equal(item.state,'complete');assert.equal(item.byExtensionId,extensionId);
    const bytes=await fs.readFile(item.filename);assert.equal(bytes.subarray(0,5).toString(),'%PDF-');
    if(startFromOnly)assert.ok(path.basename(item.filename).startsWith(`${paper.sourceIndex}_`),`Native Chrome must retain sequence number in ${item.filename}`);
    saved.push({id:paper.id,pdfBytes:bytes.length,filename:path.basename(item.filename)});
  }
  const report={ok:true,realExtensionLoaded:true,initialPapers:initial.state.papers.length,paperStatuses:papers.map(p=>({id:p.id,status:p.status,reasonCode:p.reasonCode})),realPDFDownloads:saved,robotNoClicks:noClicks,unknownResultTimeoutMs:crossSiteOnly||startFromOnly?null:Date.parse(papers[2].finishedAt)-postAt.get(papers[2].doi),totalQueueMs:Date.now()-startedAt,localFixtureRequests:requests,profile:work,liveSciHubUsed:false,crossSiteRedirect:crossSiteOnly,startFromNumber:result.state.startFromNumber};
  report.manualVerificationCases=[];
  for(const scenario of crossSiteOnly||startFromOnly?[]:['manual-timeout','manual-new','manual-home']){
    assert.equal((await message({type:'IMPORT',sourceName:'LOCAL MANUAL VERIFICATION',papers:[{id:scenario,title:scenario,doi:`10.1234/${scenario}`}]})).ok,true);
    assert.equal((await message({type:'START',limit:3,settings:{autoRobotNo:scenario==='manual-timeout',autoReopenVerification:false,timeoutSeconds:25,resultTimeoutSeconds:12}})).ok,true);
    let waiting;const manualDeadline=Date.now()+35000;
    do{
      waiting=(await message({type:'GET_STATE'})).state;
      if(waiting.waitingForVerification)break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }while(Date.now()<manualDeadline);
    assert.equal(waiting.waitingForVerification,true,JSON.stringify(waiting));
    assert.equal(waiting.pauseKind,'verification');
    await page.evaluate(async tabId=>chrome.scripting.executeScript({target:{tabId},func:id=>{document.documentElement.dataset.fixtureTabId=String(id);},args:[tabId]}),waiting.tabId);
    let taskPage;
    for(const candidate of context.pages().filter(candidate=>candidate.url().startsWith('https://sci-hub.box/'))){
      if(await candidate.evaluate(id=>document.documentElement.dataset.fixtureTabId===String(id),waiting.tabId))taskPage=candidate;
    }
    assert.ok(taskPage,'Managed local fixture tab must exist');
    // This is a simulated user click in a local fixture, not a real CAPTCHA solution.
    await taskPage.locator('.question .answer').click();
    let done;const resumeStarted=Date.now();
    do{
      done=(await message({type:'GET_STATE'})).state;
      if(done.papers[0].status==='success')break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }while(Date.now()<resumeStarted+8000);
    assert.equal(done.papers[0].status,'success',JSON.stringify(done));
    assert.equal(done.papers[0].attempts,1);
    assert.equal(done.runId,waiting.runId);
    if(scenario==='manual-home')assert.equal(manualPosts.get(scenario),2);
    const item=await page.evaluate(async id=>(await chrome.downloads.search({id}))[0],done.papers[0].downloadId);
    const bytes=await fs.readFile(item.filename);assert.equal(bytes.subarray(0,5).toString(),'%PDF-');
    report.manualVerificationCases.push({scenario,resumedAutomatically:true,clicks:manualClicks.get(scenario),postCount:manualPosts.get(scenario),resumeToDownloadMs:Date.now()-resumeStarted,pdfBytes:bytes.length,attempts:done.papers[0].attempts});
    // Wait for idle before replacing this local fixture queue.
    for(let i=0;i<20&&done.running;i++){await new Promise(resolve=>setTimeout(resolve,100));done=(await message({type:'GET_STATE'})).state;}
  }
  report.localFixtureRequests=requests;
  await fs.writeFile(path.join(import.meta.dirname,startFromOnly?'mv3-start-from-result.json':crossSiteOnly?'mv3-cross-site-result.json':'mv3-speed-result.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}finally{
  if(context)await context.close();
  await new Promise(resolve=>server.close(resolve));
}
