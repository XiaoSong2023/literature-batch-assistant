// Real MV3 downloads API test. Only synthetic files from a loopback server are used.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {loadPlaywright, loadModule} from './browser-env.mjs';
const {chromium} = loadPlaywright();
const {PDFDocument, StandardFonts} = loadModule('pdf-lib');
const extensionDir=path.resolve(import.meta.dirname,'../extension');
const expectedVersion=JSON.parse(await fs.readFile(path.join(extensionDir,'manifest.json'),'utf8')).version;
const work=await fs.mkdtemp(path.join(os.tmpdir(),'literature-v13-url-test-'));
const downloadDir=path.join(work,'downloads'),profileDir=path.join(work,'profile');
await fs.mkdir(downloadDir);
await fs.mkdir(path.join(profileDir,'Default'),{recursive:true});
await fs.writeFile(path.join(profileDir,'Default','Preferences'),JSON.stringify({download:{default_directory:downloadDir,prompt_for_download:false,directory_upgrade:true},savefile:{default_directory:downloadDir}}));
const document=await PDFDocument.create(),font=await document.embedFont(StandardFonts.Helvetica),pdfPage=document.addPage();
pdfPage.drawText('LOCAL URL DOWNLOAD TEST - NOT A RESEARCH ARTICLE',{x:40,y:750,size:14,font});
for(let i=0;i<40;i++)pdfPage.drawText(`Fixture line ${i+1}: ${'abcdefghijklmnopqrstuvwxyz'.repeat(2)}`,{x:40,y:720-i*15,size:8,font});
const pdf=Buffer.from(await document.save({useObjectStreams:false}));
const requests=[];
const server=http.createServer((req,res)=>{
  requests.push(req.url);
  let body=pdf,mime='application/pdf';
  if(req.url==='/html'){mime='text/html';body=Buffer.from(`<html><body>${'Landing page, not a PDF. '.repeat(120)}</body></html>`);}
  if(req.url==='/generic')mime='application/download';
  if(req.url==='/small')body=Buffer.from('%PDF-1.7\nTiny incomplete fixture\n%%EOF\n');
  res.writeHead(200,{'content-type':mime,'content-length':body.length});res.end(body);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://fixture-pdf.test:${server.address().port}`;
const records=[
  {sourceIndex:'64',title:'URL only PDF',pdfUrl:`${base}/pdf`},
  {sourceIndex:'65',title:'HTML is not success',pdfUrl:`${base}/html`},
  {sourceIndex:'66',title:'Chrome sniffs generic PDF response',pdfUrl:`${base}/generic`},
  {sourceIndex:'67',title:'Tiny file is not success',pdfUrl:`${base}/small`},
  {sourceIndex:'68',title:'Collection abstract A',pdfUrl:`${base}/shared`},
  {sourceIndex:'69',title:'Collection abstract B',pdfUrl:`${base}/shared`},
  {sourceIndex:'70',title:'Manual landing only',landingUrl:`${base}/landing`},
];
let context;
try{
  context=await chromium.launchPersistentContext(profileDir,{
    executablePath: process.env.CHROMIUM_EXE || undefined,
    headless:true,acceptDownloads:true,
    args:[`--disable-extensions-except=${extensionDir}`,`--load-extension=${extensionDir}`,'--no-proxy-server','--disable-background-networking','--host-resolver-rules=MAP fixture-pdf.test 127.0.0.1, MAP * ~NOTFOUND'],
  });
  await context.route(/^https?:\/\//,route=>new URL(route.request().url()).hostname==='fixture-pdf.test'?route.continue():route.abort());
  let worker=context.serviceWorkers()[0];if(!worker)worker=await context.waitForEvent('serviceworker',{timeout:15000});
  const extensionId=new URL(worker.url()).hostname,page=await context.newPage();
  const cdp=await context.newCDPSession(page);
  await cdp.send('Browser.setDownloadBehavior',{behavior:'default',eventsEnabled:true});
  await page.goto(`chrome-extension://${extensionId}/dashboard.html`);
  await page.waitForFunction(() => /^\d+$/.test(document.getElementById('totalCount').textContent));
  const message=payload=>page.evaluate(value=>chrome.runtime.sendMessage(value),payload);
  assert.equal(await page.evaluate(()=>chrome.runtime.getManifest().version),expectedVersion);
  assert.equal((await message({type:'IMPORT',sourceName:'LOCAL PDF URL FIXTURES',papers:records})).ok,true);
  assert.equal(requests.length,0,'Import alone must not download');
  assert.equal((await message({type:'START',limit:0,settings:{delaySeconds:0.25,downloadTimeoutSeconds:30}})).ok,true);
  let state;const began=Date.now();
  do{
    state=(await message({type:'GET_STATE'})).state;
    if(!state.running)break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }while(Date.now()-began<30000);
  const papers=state.papers;
  if(papers[0].status!=='success') {
    await fs.writeFile(path.join(import.meta.dirname,'mv3-url-failure.json'),JSON.stringify({state,requests,work},null,2));
    console.log(JSON.stringify({papers,requests,pauseReason:state.pauseReason,work},null,2));
  }
  assert.equal(state.running,false,JSON.stringify(state));
  assert.deepEqual(papers.map(p=>p.status),['success','failed','success','failed','success','success','missing_doi']);
  assert.equal(papers[1].reasonCode,'unverified_file_type');
  assert.equal(papers[2].mime,'application/pdf','Chrome may sniff a real PDF despite a generic HTTP Content-Type');
  assert.equal(papers[3].reasonCode,'file_too_small');
  assert.equal(state.processedThisRun,6);
  assert.equal(state.tabId,null,'URL-only queue must not open a search tab');
  assert.ok(papers.every(p=>p.doi===''));
  assert.equal(requests.length,6);assert.equal(requests.filter(url=>url==='/shared').length,2);
  assert.equal(requests.includes('/landing'),false);
  const saved=[];
  for(const paper of papers.filter(p=>Number.isInteger(p.downloadId))){
    const item=await page.evaluate(async id=>(await chrome.downloads.search({id}))[0],paper.downloadId);
    assert.equal(item.state,'complete');assert.equal(item.byExtensionId,extensionId);
    assert.ok(path.basename(item.filename).startsWith(`${paper.sourceIndex.padStart(4,'0')}_`));
    assert.equal(path.basename(item.filename).endsWith('_.pdf'),false);
    const bytes=await fs.readFile(item.filename);
    if(paper.status==='success'){assert.equal(bytes.subarray(0,5).toString(),'%PDF-');assert.ok(bytes.length>=1024);}
    saved.push({sourceIndex:paper.sourceIndex,title:paper.title,status:paper.status,reasonCode:paper.reasonCode,mime:item.mime,...(paper.sourceIndex==='66'?{serverContentType:'application/download'}:{}),bytes:bytes.length,filename:path.basename(item.filename)});
  }
  await page.screenshot({path:path.join(import.meta.dirname,'url-queue-preview.png'),fullPage:true});
  const report={ok:true,version:expectedVersion,realExtensionLoaded:true,requests,processed:state.processedThisRun,paperStatuses:papers.map(p=>({sourceIndex:p.sourceIndex,status:p.status,reasonCode:p.reasonCode})),savedFiles:saved,totalQueueMs:Date.now()-began,profile:work,externalArticleDownloads:false,manualLandingOpened:false};
  await fs.writeFile(path.join(import.meta.dirname,'mv3-url-result.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}finally{
  if(context)await context.close();
  await new Promise(resolve=>server.close(resolve));
}
