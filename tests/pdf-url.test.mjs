import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../extension/core.js';
import {parseBibliography} from '../extension/importers.js';
import {createChromeFixture} from './chrome-fixture.mjs';

const url = 'https://files.example/abstracts.pdf?token=CaseSensitive#page=14';
const record = (n, extra = {}) => ({id:`url-${n}`,sourceIndex:String(n),title:`Paper ${n}`,pdfUrl:url,...extra});
const get = async f => (await f.send({type:'GET_STATE'})).state;
const start = f => f.send({type:'START',limit:0,settings:{delaySeconds:0.25,downloadTimeoutSeconds:30}});

test('CSV/JSON explicit PDF aliases preserve title and source number without fabricating a DOI', () => {
  for (const field of ['pdfUrl','fullTextUrl','url']) {
    const csv=parseBibliography(`index,title,${field}\n64,Chinese article,${url}`, 'urls.csv');
    const json=parseBibliography(JSON.stringify([{index:64,title:'Chinese article',[field]:url}]), 'urls.json');
    for(const result of [csv,json]) {
      assert.equal(result.papers[0].sourceIndex,'64');
      assert.equal(result.papers[0].pdfUrl,url);
      assert.equal(result.papers[0].doi,'');
      assert.equal(core.normalizePapers(result.papers)[0].status,'pending');
      assert.equal(result.stats.eligible,1);
      assert.equal(result.stats.withPdfUrl,1);
      assert.doesNotMatch(result.papers[0].sourceStatus,/缺少可用 DOI/);
    }
  }
});

test('RIS L1 is downloadable while an ordinary UR is preserved only as a manual entry', () => {
  const result=parseBibliography(`TY  - JOUR\nTI  - PDF\nL1  - ${url}\nUR  - https://journal.example/article/42\nER  -\nTY  - JOUR\nTI  - Landing only\nUR  - https://journal.example/article/99.pdf\nER  -`, 'urls.ris');
  assert.equal(result.papers[0].pdfUrl,url);
  assert.equal(result.papers[0].landingUrl,'https://journal.example/article/42');
  assert.equal(result.papers[1].pdfUrl,'');
  assert.equal(core.normalizePapers(result.papers)[1].status,'missing_doi');
});

test('TXT accepts standalone HTTP(S) URLs and DOI URLs retain their DOI meaning', () => {
  const result=parseBibliography(`${url}\nhttp://files.example/download?id=3\nhttps://doi.org/10.1234/example\nA title https://example.com/file.pdf`, 'urls.txt');
  assert.equal(result.papers.length,3);
  assert.equal(result.papers[0].pdfUrl,url);
  assert.equal(result.papers[1].pdfUrl,'http://files.example/download?id=3');
  assert.equal(result.papers[2].doi,'10.1234/example');
  assert.equal(result.papers[2].pdfUrl,'');
  assert.equal(result.warnings.length,1);
});

test('unsafe URLs never become download targets and importing performs no requests', () => {
  for (const value of ['javascript:alert(1)','file:///C:/x.pdf','data:application/pdf;base64,AA','https://user:password@example.com/x.pdf','https://example.com/has space.pdf']) {
    const result=parseBibliography(JSON.stringify([{title:'Unsafe',pdfUrl:value}]), 'urls.json');
    assert.equal(result.papers[0].pdfUrl,'');
    assert.equal(core.normalizePapers(result.papers)[0].status,'missing_doi');
    assert.ok(result.warnings.length);
  }
});

test('an unrecognized browser MIME remains pending manual file verification even for a .pdf URL', () => {
  const result=core.verifyDownload({state:'complete',exists:true,mime:'application/download',fileSize:4000,url});
  assert.equal(result.ok,false);
  assert.equal(result.code,'unverified_file_type');
  assert.match(result.reason,/文件已下载.*人工检查/);
  assert.doesNotMatch(result.reason,/未收录|not found/i);
});

test('PDF alias priority is stable and conflicting URLs are disclosed', () => {
  const result=parseBibliography(JSON.stringify([{title:'Priority',url:'https://example.com/landing',fullTextUrl:'https://example.com/alternate',pdfUrl:url}]),'urls.json');
  assert.equal(result.papers[0].pdfUrl,url);
  assert.match(result.warnings.join(' '),/多个.*链接/);
});

test('URL-only filenames omit an empty DOI suffix and migration retains completed progress', () => {
  const state=core.createInitialState({papers:[record(64),record(65,{doi:'10.1234/legacy'})]});
  assert.equal(core.sanitizeFilename(state.papers[0]),'LiteratureBatch/0064_Paper 64.pdf');
  Object.assign(state.papers[0],{status:'missing_doi',attempts:0});
  Object.assign(state.papers[1],{status:'success',attempts:2,downloadId:91,filename:'saved.pdf'});
  const before=structuredClone(state.papers[1]);
  core.migrateState(state);
  assert.equal(state.papers[0].status,'pending');
  assert.deepEqual(state.papers[1],before);
  const migrated=structuredClone(state); core.migrateState(state);
  assert.deepEqual(state,migrated);
});

test('deduplication requires matching title as well as DOI or exact URL', () => {
  for (const source of [{pdfUrl:url},{doi:'10.1234/collection'}]) {
    const a={title:'Abstract A',...source}, b={title:'Abstract B',...source};
    assert.notEqual(core.paperImportKey(a),core.paperImportKey(b));
    assert.equal(core.paperImportKey(a),core.paperImportKey({...a,title:'  abstract   A '}));
  }
  assert.notEqual(core.paperImportKey(record(1)),core.paperImportKey(record(1,{pdfUrl:url.replace('CaseSensitive','casesensitive')})));
});

test('URL-only queue starts downloads directly and rejects HTML without navigating or injecting scripts', async () => {
  const f=await createChromeFixture({bundle:{papers:[record(1),record(2,{pdfUrl:'https://files.example/landing'}),record(3)]}});
  assert.equal((await start(f)).ok,true);
  let state=await get(f);
  assert.equal(state.papers[0].status,'downloading');
  await f.completeDownload(state.papers[0].downloadId);
  await f.advance(500);
  state=await get(f);
  assert.equal(state.papers[0].status,'success');
  await f.completeDownload(state.papers[1].downloadId,{mime:'text/html',fileSize:4096});
  await f.advance(500);
  state=await get(f);
  assert.equal(state.papers[1].status,'failed');
  assert.equal(state.papers[1].reasonCode,'unverified_file_type');
  await f.completeDownload(state.papers[2].downloadId,{mime:'application/pdf',fileSize:100});
  await f.advance(500);
  state=await get(f);
  assert.equal(state.papers[2].reasonCode,'file_too_small');
  assert.equal(state.processedThisRun,3);
  assert.equal(f.calls.downloads.length,3);
  assert.equal(f.calls.navigation.length,0);
  assert.equal(f.calls.scripts.length,0);
  assert.equal((await f.send({type:'RETRY_FAILED'})).ok,true);
  state=await get(f);
  assert.deepEqual(state.papers.map(p=>p.status),['success','pending','pending']);
  assert.equal(state.papers[1].lastFailure.reasonCode,'unverified_file_type');
});

test('explicit PDF takes priority when a record also has a DOI', async () => {
  const f=await createChromeFixture({bundle:{papers:[record(1,{doi:'10.1234/also-has-doi'})]}});
  await start(f);
  assert.equal(f.calls.downloads[0]?.url,url);
  assert.equal(f.calls.navigation.length,0);
});

test('URL download intent survives a worker restart without a second download', async () => {
  const f=await createChromeFixture({bundle:{papers:[record(1)]}});
  await start(f);
  const state=await get(f);
  assert.equal(state.papers[0].status,'downloading');
  const resumed=await createChromeFixture({persisted:f.persisted,session:f.session,downloadItems:[...f.downloads.values()]});
  await resumed.completeDownload(state.papers[0].downloadId);
  assert.equal((await get(resumed)).papers[0].status,'success');
  assert.equal(resumed.calls.downloads.length,0);
  assert.equal(resumed.calls.navigation.length,0);
});

test('a failed second download of the same collection URL cannot claim the previous file', async () => {
  const f=await createChromeFixture({bundle:{papers:[record(1),record(2)]}});
  await start(f);
  const first=(await get(f)).papers[0];
  await f.completeDownload(first.downloadId);
  f.chrome.downloads.download=async()=>{throw Error('Failed to start second transfer');};
  await f.advance(500);
  const state=await get(f);
  assert.equal(state.papers[0].status,'success');
  assert.equal(state.papers[1].status,'failed');
  assert.equal(state.papers[1].reasonCode,'download_start_error');
  assert.notEqual(state.papers[1].downloadId,first.downloadId);
});

test('start-from, pause and resume include URL-only records and retain preceding entries', async () => {
  const f=await createChromeFixture({bundle:{papers:[record(1),record(2),record(3)]}});
  await f.send({type:'START_FROM',startFromNumber:2,settings:{delaySeconds:0.25}});
  let state=await get(f);
  assert.equal(state.papers[0].status,'pending');
  assert.equal(state.papers[1].status,'downloading');
  await f.send({type:'PAUSE'});
  await f.completeDownload(state.papers[1].downloadId);
  await f.advance(500);
  assert.equal((await get(f)).papers[2].status,'pending');
  await start(f);
  state=await get(f);
  assert.equal(state.papers[2].status,'downloading');
  assert.equal(f.calls.downloads.length,2);
});
