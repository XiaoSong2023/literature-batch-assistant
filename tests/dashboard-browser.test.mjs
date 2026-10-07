import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createInitialState } from '../extension/core.js';
import { parseBibliography } from '../extension/importers.js';
import { loadPlaywright, chromeExecutable, serveExtension } from './browser-env.mjs';
import { createDemoBibliography } from './fixtures/demo-papers.mjs';

const { chromium } = loadPlaywright();
const extensionDir = path.resolve(import.meta.dirname, '../extension');
const SEARCH_DOI = '10.5555/demo.2019.10037';

// The styled confirmation dialog replaces window.confirm.
async function answerDialog(page, accept) {
  await page.locator('#confirmDialog[open]').waitFor();
  await page.locator(accept ? '#confirmOk' : '#confirmCancel').click();
  await page.locator('#confirmDialog:not([open])').waitFor({ state: 'attached' });
}

function retryCsv(count) {
  const rows = Array.from({ length: count }, (_, i) => `${i + 1},"Unfinished paper ${i + 1}",10.5555/retry.${String(i + 1).padStart(4, '0')}`);
  return ['index,title,doi', ...rows].join('\r\n');
}

test('dashboard renders a 2174-record list and exports distinct unresolved groups in Chromium', async t => {
  const state = createInitialState({ sourceName: '示例文献清单', papers: createDemoBibliography(2174) });
  const browser = await chromium.launch({ headless: true, executablePath: chromeExecutable() });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
  await serveExtension(context, extensionDir);
  await context.addInitScript(initialState => {
    window.fixtureState = initialState;
    window.fixtureCommands = [];
    window.fixtureReports = [];
    window.fixtureListeners = [];
    const pdf='%PDF-1.7\n1 0 obj <</Type/Catalog>> endobj\n%%EOF\n';
    const data=new Map([['paper.pdf',pdf],['paper (1).pdf',pdf],['paper (2).pdf',pdf.replace('Catalog','Changed')],['notes.txt','Keep this text']]);
    window.fixtureDirectory={kind:'directory',name:'Memory PDF fixture',removed:[],data,
      async queryPermission(){return 'granted';},async requestPermission(){return 'granted';},
      async *entries(){for(const name of data.keys())yield [name,{kind:'file',name}];},
      async getFileHandle(name){if(!data.has(name))throw new DOMException('Missing file','NotFoundError');return {kind:'file',name,async getFile(){return new File([data.get(name)],name,{lastModified:1});}};},
      async removeEntry(name){if(!data.has(name))throw new DOMException('Missing file','NotFoundError');this.removed.push(name);data.delete(name);},
    };
    window.showDirectoryPicker=async()=>window.fixtureDirectory;
    window.chrome = {
      runtime: { async sendMessage(message) {
        window.fixtureCommands.push(message);
        if (message.type === 'START') window.fixtureState.running = true;
        if (message.type === 'RETRY_UNFINISHED') window.fixtureState.running = true;
        if (message.type === 'START_FROM') {window.fixtureState.running=true;window.fixtureState.startFromNumber=message.startFromNumber;}
        if (message.type === 'PAUSE') {window.fixtureState.running=false;window.fixtureState.waitingForVerification=false;window.fixtureState.pauseKind='user';}
        if (message.type === 'REOPEN_CURRENT') {window.fixtureState.running=true;window.fixtureState.waitingForVerification=false;}
        if (message.type === 'IMPORT') {
          window.fixtureState.sourceName=message.sourceName;
          window.fixtureState.papers=message.papers.map(p=>({...p,status:p.doi||p.pdfUrl?'pending':'missing_doi',attempts:0}));
          window.fixtureState.startFromNumber=1;
          window.fixtureState.activeId=null;
          window.fixtureState.waitingForVerification=false;
        }
        return { ok: true, state: structuredClone(window.fixtureState) };
      } },
      storage: { onChanged: { addListener(callback) { window.fixtureListeners.push(callback); } } },
      downloads: { async download(options) {
        const bytes = new Uint8Array(await (await fetch(options.url)).arrayBuffer());
        window.fixtureReports.push({ ...options, text: new TextDecoder().decode(bytes), bytes: Array.from(bytes) });
        return window.fixtureReports.length;
      } },
      tabs: { async create() { throw Error('External tabs not permitted in UI fixture'); } },
    };
  }, state);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('https://fixture.example/dashboard.html');
  await page.waitForFunction(() => document.querySelector('#totalCount').textContent === '2174');

  await t.test('all 2174 records are counted, table paginates, no layout overflow', async () => {
    assert.equal(await page.locator('#missingCount').textContent(), String(state.papers.filter(p => p.status === 'missing_doi').length));
    assert.equal(await page.locator('#papersBody tr').count(), 50);
    assert.match(await page.locator('#pageInfo').textContent(), /第 1 \/ 44 页/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await page.locator('#emptyQueue').isHidden(), true, 'A loaded queue never shows the empty state');
    await page.screenshot({ path: path.join(import.meta.dirname, 'dashboard-preview.png') });
    await page.locator('#nextPage').click();
    assert.match(await page.locator('#pageInfo').textContent(), /第 2 \/ 44 页/);
    await page.locator('#query').fill(SEARCH_DOI);
    assert.equal(await page.locator('#papersBody tr').count(), 1);
    await page.locator('#query').fill('');
  });

  await t.test('status chips filter the table and show per-status counts', async () => {
    const missing = state.papers.filter(p => p.status === 'missing_doi').length;
    assert.equal(await page.locator('[data-count="missing_doi"]').textContent(), String(missing));
    await page.locator('label.chip:has(input[value="missing_doi"])').click();
    assert.match(await page.locator('#pageInfo').textContent(), new RegExp(`共 ${missing} 条`));
    await page.locator('label.chip:has(input[value="all"])').click();
    assert.match(await page.locator('#pageInfo').textContent(), /共 2174 条/);
  });

  await t.test('start-three and pause send correct engine commands', async () => {
    await page.locator('#start3').click();
    await page.waitForFunction(() => window.fixtureCommands.some(m => m.type === 'START'));
    const start = await page.evaluate(() => window.fixtureCommands.find(m => m.type === 'START'));
    assert.equal(start.limit, 3);
    assert.equal(start.settings.timeoutSeconds, state.settings.timeoutSeconds);
    assert.equal(await page.locator('#startAll').isDisabled(), true);
    assert.equal(await page.locator('#queuePanel').evaluate(node => node.classList.contains('is-running')), true);
    await page.locator('#pause').click();
    await page.waitForFunction(() => window.fixtureCommands.some(m => m.type === 'PAUSE'));
    assert.equal(await page.locator('#startAll').isEnabled(), true);
  });

  await t.test('Start From sends a numeric list position and ordinary Continue keeps the saved range',async()=>{
    assert.equal(await page.locator('#startFromNumber').getAttribute('max'),'2174');
    await page.locator('#startFromNumber').fill('12');
    await page.evaluate(()=>{for(const listener of window.fixtureListeners)listener({},'local');});
    assert.equal(await page.locator('#startFromNumber').inputValue(),'12','state refresh must preserve an unsubmitted range edit');
    await page.locator('#startFrom').click();
    const chosen=await page.evaluate(()=>window.fixtureCommands.at(-1));
    assert.equal(chosen.type,'START_FROM');
    assert.equal(chosen.startFromNumber,12);
    assert.match(await page.locator('#queueRange').textContent(),/第 12–2174 条/);
    assert.equal(await page.locator('#startFrom').isDisabled(),true);
    assert.equal(await page.locator('#startFromNumber').isDisabled(),true);
    await page.locator('#pause').click();
    await page.locator('#startAll').click();
    const continued=await page.evaluate(()=>window.fixtureCommands.at(-1));
    assert.equal(continued.type,'START');
    assert.equal(Object.hasOwn(continued,'startFromNumber'),false);
    assert.equal(await page.evaluate(()=>window.fixtureState.startFromNumber),12);
    await page.locator('#pause').click();
    await page.locator('#startFromNumber').fill('1');
    await page.locator('#startFrom').click();
    await page.locator('#pause').click();
  });

  await t.test('TXT unresolved export includes title/DOI with failure, missing and pending kept distinct', async () => {
    await page.evaluate(() => {
      window.fixtureState.papers = [
        { id: 's', sourceIndex: 1, title: 'SUCCESS SHOULD BE OMITTED', doi: '10.1234/success', status: 'success' },
        { id: 'f', sourceIndex: 2, title: 'Failed paper title', doi: '10.1234/failed', status: 'failed', reason: 'Article not found', attempts: 1 },
        { id: 'm', sourceIndex: 3, title: 'Missing DOI title', doi: '', status: 'missing_doi' },
        { id: 'p', sourceIndex: 4, title: 'Pending paper title', doi: '10.1234/pending', status: 'pending' },
      ];
      for (const listener of window.fixtureListeners) listener({}, 'local');
    });
    await page.waitForFunction(() => document.querySelector('#totalCount').textContent === '4');
    await page.locator('#exportUnresolved').click();
    await page.waitForFunction(() => window.fixtureReports.length === 1);
    const all = await page.evaluate(() => window.fixtureReports[0]);
    assert.match(all.filename, /^LiteratureBatch\/未获取全文_.*\.txt$/);
    assert.match(all.text, /题目：Failed paper title\r\nDOI：10\.1234\/failed/);
    assert.match(all.text, /尝试后失败（1 条）/);
    assert.match(all.text, /缺少 DOI \/ PDF 直链，未进行下载（1 条）/);
    assert.match(all.text, /尚未处理，不代表网站未收录（1 条）/);
    assert.match(all.text,/当前选定处理范围：第 1–4 条；起点之前未处理的记录仍列为尚未处理/);
    assert.doesNotMatch(all.text, /SUCCESS SHOULD BE OMITTED/);
    await page.locator('#exportFailed').click();
    await page.waitForFunction(() => window.fixtureReports.length === 2);
    const failed = await page.evaluate(() => window.fixtureReports[1].text);
    assert.match(failed, /Failed paper title/);
    assert.doesNotMatch(failed, /Missing DOI title|Pending paper title|SUCCESS SHOULD BE OMITTED/);
  });

  await t.test('a row that turns successful on screen is stamped once', async () => {
    await page.evaluate(() => {
      window.fixtureState.papers[3].status = 'success';
      for (const listener of window.fixtureListeners) listener({}, 'local');
    });
    await page.waitForFunction(() => document.querySelectorAll('#papersBody .pill.stamp').length === 1);
    await page.evaluate(() => {
      window.fixtureState.papers[3].status = 'pending';
      for (const listener of window.fixtureListeners) listener({}, 'local');
    });
    await page.waitForFunction(() => document.querySelectorAll('#papersBody .pill.stamp').length === 0);
  });

  await t.test('one-click retry has distinct scopes and retry CSV / true DOCX omit successful records', async () => {
    await page.locator('#retry').click();
    assert.equal(await page.evaluate(()=>window.fixtureCommands.at(-1).type), 'RETRY_UNFINISHED');
    assert.equal(await page.evaluate(()=>window.fixtureCommands.at(-1).scope), 'failed');
    await page.locator('#pause').click();
    await page.locator('#retryRemaining').click();
    assert.equal(await page.evaluate(()=>window.fixtureCommands.at(-1).scope), 'unfinished');
    await page.locator('#pause').click();
    const before = await page.evaluate(()=>window.fixtureReports.length);
    await page.locator('#exportRetryCsv').click();
    await page.locator('#exportWord').click();
    await page.waitForFunction(n=>window.fixtureReports.length===n+2,before);
    const [csv,docx] = await page.evaluate(n=>window.fixtureReports.slice(n),before);
    assert.match(csv.filename,/未获取全文_可重新导入_.*\.csv$/);
    assert.doesNotMatch(csv.text,/SUCCESS SHOULD BE OMITTED/);
    const parsed = parseBibliography(csv.text,'retry.csv');
    assert.deepEqual(parsed.papers.map(p=>p.title),['Failed paper title','Missing DOI title','Pending paper title']);
    assert.equal(parsed.stats.eligible,2);
    assert.match(docx.filename,/未获取全文_.*\.docx$/);
    assert.deepEqual(docx.bytes.slice(0,4),[80,75,3,4],'DOCX must be a real ZIP with no UTF-8 BOM prefix');
    assert.ok(docx.bytes.length>1000);
    await page.locator('.control-panel').screenshot({path:path.join(import.meta.dirname,'v1.4-retry-controls.png')});
  });

  await t.test('multi-file RIS and NBIB plus DOI paste preview preserves old queue until confirmed', async () => {
    await page.locator('#importFile').setInputFiles([
      {name:'sample.ris',mimeType:'text/plain',buffer:Buffer.from('TY  - JOUR\nTI  - RIS DOI paper\nDO  - 10.1234/ris\nER  -\nTY  - JOUR\nTI  - RIS without DOI\nER  -\n')},
      {name:'sample.nbib',mimeType:'text/plain',buffer:Buffer.from('PMID- 123456\nTI  - PubMed DOI paper\nLID - 10.1234/pubmed [doi]\n\n')},
    ]);
    assert.equal(await page.locator('#fileList li').count(), 2, 'Chosen files are listed in the drop zone');
    await page.locator('#doiText').fill('https://doi.org/10.1234/ris\n10.1234/pasted');
    await page.locator('#previewImport').click();
    await page.waitForFunction(()=>!document.getElementById('importPreview').hidden);
    assert.match(await page.locator('#importSummary').textContent(),/共解析 5 条；将导入 5 条，可处理 4 条，缺少 DOI \/ PDF 直链 1 条/);
    assert.equal(await page.locator('#totalCount').textContent(),'4');
    assert.equal(await page.evaluate(()=>window.fixtureCommands.filter(m=>m.type==='IMPORT').length),0);
    await page.locator('#importButton').click();
    await answerDialog(page, false);
    assert.equal(await page.locator('#totalCount').textContent(),'4');
    assert.equal(await page.evaluate(()=>window.fixtureCommands.filter(m=>m.type==='IMPORT').length),0);
    await page.locator('#dedupeImport').check();
    assert.match(await page.locator('#importSummary').textContent(),/将导入 5 条，可处理 4 条/);
    await page.locator('#importPanel').screenshot({path:path.join(import.meta.dirname,'import-preview.png')});
    await page.locator('#importAndRun').click();
    await answerDialog(page, true);
    await page.waitForFunction(()=>window.fixtureState.running&&window.fixtureCommands.some(m=>m.type==='IMPORT'));
    const imported=await page.evaluate(()=>window.fixtureCommands.find(m=>m.type==='IMPORT'));
    assert.equal(imported.papers.length,5);
    assert.equal(imported.papers.filter(p=>!p.doi).length,1);
    assert.equal(imported.papers.find(p=>!p.doi).title,'RIS without DOI');
    assert.equal(imported.papers.filter(p=>p.doi==='10.1234/ris').length,2,'An unnamed DOI cannot prove that a titled record is the same article');
    assert.deepEqual(imported.papers.map(p=>p.sourceIndex),['0001','0002','0003','0004','0005']);
    assert.equal(await page.locator('#startFromNumber').inputValue(),'1');
    assert.equal(await page.locator('#fileList li').count(), 0, 'The file list clears after a committed import');
    const lastCommands=await page.evaluate(()=>window.fixtureCommands.slice(-2).map(m=>({type:m.type,limit:m.limit})));
    assert.deepEqual(lastCommands,[{type:'IMPORT',limit:undefined},{type:'START',limit:0}]);
    await page.locator('#pause').click();
  });

  await t.test('plain DOI-only import supports preview invalidation and does not start unless selected', async () => {
    await page.locator('#importFile').setInputFiles([]);
    await page.locator('#doiText').fill('10.1234/one\nhttps://doi.org/10.1234/two');
    await page.locator('#previewImport').click();
    await page.waitForFunction(()=>!document.getElementById('importPreview').hidden);
    assert.match(await page.locator('#importSummary').textContent(),/将导入 2 条，可处理 2 条，缺少 DOI \/ PDF 直链 0 条/);
    await page.locator('#doiText').fill('10.1234/one');
    assert.equal(await page.locator('#importPreview').isHidden(),true);
    await page.locator('#previewImport').click();
    await page.locator('#importButton').click();
    await answerDialog(page, true);
    await page.waitForFunction(()=>document.getElementById('totalCount').textContent==='1');
    assert.equal(await page.evaluate(()=>window.fixtureState.running),false);
    assert.equal(await page.evaluate(()=>window.fixtureCommands.at(-1).type),'IMPORT');
  });

  await t.test('URL-only preview, title-aware deduplication, manual links and reports work in the browser',async()=>{
    const url='https://files.example/collection.pdf?token=CaseSensitive';
    await page.locator('#doiText').fill('');
    await page.locator('#importFile').setInputFiles({name:'links.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify([
      {title:'Abstract A',pdfUrl:url}, {title:'Abstract B',pdfUrl:url}, {title:'Abstract A',pdfUrl:url},
      {title:'Web entry',landingUrl:'https://journal.example/article/42'},
    ]))});
    await page.locator('#previewImport').click();
    await page.waitForFunction(()=>!document.getElementById('importPreview').hidden);
    assert.match(await page.locator('#importSummary').textContent(),/将导入 3 条，可处理 2 条/);
    assert.equal(await page.locator('#importAndRun').isEnabled(),true);
    assert.match(await page.locator('#importPanel').textContent(),/普通 HTML 全文入口需人工打开/);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.locator('#importButton').click();
    await answerDialog(page, true);
    await page.waitForFunction(()=>document.getElementById('totalCount').textContent==='3');
    assert.equal(await page.evaluate(()=>window.fixtureState.running),false);
    assert.equal(await page.locator('#missingCount').textContent(),'1');
    assert.match(await page.locator('#progressLabel').textContent(),/0 \/ 2 条有 DOI \/ PDF 直链/);
    const links=await page.locator('#papersBody a').evaluateAll(nodes=>nodes.map(node=>({href:node.href,target:node.target,rel:node.rel})));
    assert.equal(links.length,3);assert.equal(links[2].href,'https://journal.example/article/42');
    assert.ok(links.every(link=>link.target==='_blank'&&link.rel.includes('noopener')));
    await page.locator('#query').fill('CaseSensitive');assert.equal(await page.locator('#papersBody tr').count(),2);
    await page.locator('#query').fill('');
    await page.evaluate(()=>{
      Object.assign(window.fixtureState.papers[0],{status:'failed',reason:'文件已下载，但 MIME 为 text/html，不能确认是 PDF；请人工检查。',attempts:1});
      for(const listener of window.fixtureListeners)listener({},'local');
    });
    const before=await page.evaluate(()=>window.fixtureReports.length);
    await page.locator('#exportUnresolved').click();
    await page.locator('#exportCsv').click();
    await page.waitForFunction(n=>window.fixtureReports.length===n+2,before);
    const reports=await page.evaluate(n=>window.fixtureReports.slice(n),before);
    assert.match(reports[0].text,/PDF 直链：https:\/\/files.example\/collection.pdf\?token=CaseSensitive/);
    assert.match(reports[0].text,/网页入口（人工打开）：https:\/\/journal.example\/article\/42/);
    assert.match(reports[0].text,/text\/html，不能确认是 PDF；请人工检查/);
    assert.match(reports[1].text,/"DOI","pdfUrl","landingUrl"/);
    assert.match(reports[1].text,/Abstract A","","https:\/\/files.example/);
    await page.locator('#importPanel').screenshot({path:path.join(import.meta.dirname,'url-import-preview.png')});
  });

  await t.test('top navigation exposes import, records and local deduplication panels',async()=>{
    await page.locator('#showImport').click();
    assert.equal(await page.evaluate(()=>document.activeElement.id),'importHeading');
    assert.equal(await page.locator('#showImport').getAttribute('aria-current'),'true');
    await page.locator('#showRecords').click();
    assert.equal(await page.evaluate(()=>document.activeElement.id),'recordsHeading');
    await page.locator('#showDedup').click();
    assert.equal(await page.evaluate(()=>document.activeElement.id),'dedupHeading');
  });

  await t.test('local PDF cleanup previews exact copies and cancellation changes no files',async()=>{
    await page.locator('#chooseDedupFolder').click();
    await page.waitForFunction(()=>!document.getElementById('deleteDuplicates').disabled);
    assert.match(await page.locator('#dedupBody').textContent(),/paper \(1\)\.pdf/);
    assert.doesNotMatch(await page.locator('#dedupBody').textContent(),/paper \(2\)\.pdf/);
    assert.deepEqual(await page.evaluate(()=>window.fixtureDirectory.removed),[]);
    await page.locator('#dedupPanel').screenshot({path:path.join(import.meta.dirname,'dedup-preview.png')});
    await page.locator('#deleteDuplicates').click();
    assert.equal(await page.evaluate(()=>document.activeElement.id),'confirmCancel','A destructive confirmation starts on Cancel');
    assert.equal(await page.locator('#confirmDialog').evaluate(node=>node.classList.contains('danger')),true);
    await answerDialog(page, false);
    assert.deepEqual(await page.evaluate(()=>window.fixtureDirectory.removed),[]);
    assert.equal(await page.locator('#deleteDuplicates').isDisabled(),true);
    await page.locator('#rescanDedup').click();
    await page.waitForFunction(()=>!document.getElementById('deleteDuplicates').disabled);
  });

  await t.test('waiting state keeps Pause and Reopen available but blocks new runs and file deletion',async()=>{
    await page.evaluate(()=>{
      window.fixtureState.running=false;window.fixtureState.waitingForVerification=true;window.fixtureState.pauseKind='verification';
      window.fixtureState.activeId=window.fixtureState.papers[0].id;window.fixtureState.papers[0].status='searching';
      for(const listener of window.fixtureListeners)listener({},'local');
    });
    await page.waitForFunction(()=>document.getElementById('runBadge').textContent.includes('等待人工验证'));
    assert.equal(await page.locator('#nowCard').getAttribute('data-mode'),'waiting');
    assert.equal(await page.locator('#pause').isEnabled(),true);
    assert.equal(await page.locator('#reopenCurrent').isEnabled(),true);
    assert.equal(await page.locator('#startAll').isDisabled(),true);
    assert.equal(await page.locator('#startFrom').isDisabled(),true);
    assert.equal(await page.locator('#startFromNumber').isDisabled(),true);
    assert.equal(await page.locator('#deleteDuplicates').isDisabled(),true);
    await page.evaluate(()=>window.scrollTo(0,0));
    await page.screenshot({path:path.join(import.meta.dirname,'verification-wait-preview.png')});
    await page.locator('#reopenCurrent').click();
    assert.equal(await page.evaluate(()=>window.fixtureCommands.at(-1).type),'REOPEN_CURRENT');
    assert.equal(await page.locator('#deleteDuplicates').isDisabled(),true);
    await page.locator('#pause').click();
    await page.evaluate(()=>{
      window.fixtureState.activeId=null;window.fixtureState.papers[0].status='pending';
      for(const listener of window.fixtureListeners)listener({},'local');
    });
  });

  await t.test('confirmed cleanup removes only matching in-memory numbered copy',async()=>{
    await page.waitForFunction(()=>!document.getElementById('deleteDuplicates').disabled);
    await page.locator('#deleteDuplicates').click();
    await answerDialog(page, true);
    await page.waitForFunction(()=>window.fixtureDirectory.removed.length===1);
    assert.deepEqual(await page.evaluate(()=>window.fixtureDirectory.removed),['paper (1).pdf']);
    assert.deepEqual(await page.evaluate(()=>[...window.fixtureDirectory.data.keys()]),['paper.pdf','paper (2).pdf','notes.txt']);
  });

  await t.test('unsupported directory picker displays a useful message and disables file actions',async()=>{
    const unsupported=await context.newPage();
    await unsupported.addInitScript(()=>{window.showDirectoryPicker=undefined;});
    await unsupported.goto('https://fixture.example/dashboard.html');
    await unsupported.waitForFunction(()=>document.getElementById('totalCount').textContent==='2174');
    assert.match(await unsupported.locator('#dedupStatus').textContent(),/不支持选择本地文件夹/);
    assert.equal(await unsupported.locator('#chooseDedupFolder').isDisabled(),true);
    assert.equal(await unsupported.locator('#deleteDuplicates').isDisabled(),true);
    await unsupported.close();
  });

  await t.test('paused old search allows a 588-item CSV to replace the queue and start only that batch',async()=>{
    await page.evaluate(()=>{
      window.fixtureState.running=false;window.fixtureState.waitingForVerification=false;
      window.fixtureState.activeId=window.fixtureState.papers[0].id;
      window.fixtureState.papers[0].status='searching';window.fixtureState.pauseKind='tab_closed';
      for(const listener of window.fixtureListeners)listener({},'local');
    });
    await page.locator('#doiText').fill('');
    await page.locator('#importFile').setInputFiles({name:'未完成文献_588项_可导入.csv',mimeType:'text/csv',buffer:Buffer.from(retryCsv(588))});
    await page.locator('#previewImport').click();
    await page.waitForFunction(()=>!document.getElementById('importPreview').hidden);
    assert.equal(await page.locator('#importAndRun').isEnabled(),true);
    assert.match(await page.locator('#importStatus').textContent(),/588.*新清单/);
    await page.evaluate(()=>{
      window.fixtureState.papers[0].status='downloading';
      for(const listener of window.fixtureListeners)listener({},'local');
    });
    await page.waitForFunction(()=>document.getElementById('importAndRun').disabled);
    assert.match(await page.locator('#importStatus').textContent(),/下载.*跳过/);
    await page.evaluate(()=>{
      window.fixtureState.papers[0].status='searching';
      for(const listener of window.fixtureListeners)listener({},'local');
    });
    await page.waitForFunction(()=>!document.getElementById('importAndRun').disabled);
    await page.locator('#importPanel').screenshot({path:path.join(import.meta.dirname,'v1.4.1-paused-import.png')});
    await page.locator('#importAndRun').click();
    await answerDialog(page, true);
    await page.waitForFunction(()=>window.fixtureState.running&&window.fixtureState.papers.length===588);
    await page.waitForFunction(()=>document.getElementById('totalCount').textContent==='588');
    assert.equal(await page.locator('#missingCount').textContent(),'0');
    assert.deepEqual(await page.evaluate(()=>window.fixtureCommands.slice(-2).map(m=>m.type)),['IMPORT','START']);
  });
  assert.deepEqual(errors, []);
});

test('an empty queue shows the getting-started state instead of controls', async t => {
  const browser = await chromium.launch({ headless: true, executablePath: chromeExecutable() });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
  await serveExtension(context, extensionDir);
  await context.addInitScript(initialState => {
    window.fixtureState = initialState;
    window.chrome = {
      runtime: { async sendMessage() { return { ok: true, state: structuredClone(window.fixtureState) }; } },
      storage: { onChanged: { addListener() {} } },
      downloads: { async download() { return 1; } },
      tabs: { async create() {} },
    };
  }, createInitialState({ papers: [] }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('https://fixture.example/dashboard.html');
  await page.waitForFunction(() => document.getElementById('totalCount').textContent === '0');
  assert.equal(await page.locator('#emptyQueue').isVisible(), true);
  assert.equal(await page.locator('.queue-controls').isVisible(), false);
  assert.equal(await page.locator('#runBadge').textContent(), '尚未导入文献');
  assert.ok((await page.locator('#runBadge').boundingBox()).height < 60, 'The empty badge keeps its pill shape');
  assert.match(await page.locator('#papersBody').textContent(), /导入文献后/);
  await page.locator('#emptyImport').click();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'importHeading');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
});
