import test from 'node:test';
import assert from 'node:assert/strict';
import {carryCompletedImports, normalizePapers} from '../extension/core.js';
import {parseBibliography} from '../extension/importers.js';
import {createRetryCsv} from '../extension/report-csv.js';
import {createChromeFixture} from './chrome-fixture.mjs';

const pdfUrl = 'https://files.example/collection.pdf?key=CaseSensitive';
const landingUrl = 'https://journal.example/article/42';
const paper = (extra = {}) => ({id: 'new-row', sourceIndex: '0017', title: 'Original study', doi: '10.1234/original', ...extra});
const successful = (extra = {}) => ({
  ...normalizePapers([paper(extra)])[0], status: 'success', attempts: 2,
  downloadId: 781, filename: 'C:\\Downloads\\LiteratureBatch\\actual saved name.pdf',
  downloadUrl: pdfUrl, finishedAt: '2026-10-05T12:01:00Z', ...extra,
});
const roundTrip = (papers, options) => {
  const text = createRetryCsv(papers, options);
  const parsed = parseBibliography('\uFEFF' + text, 'retry.csv');
  return {text, parsed, papers: normalizePapers(parsed.papers)};
};

test('core: reimport preserves trusted success and actual download details without replacing new row identity', () => {
  const previous = successful({id: 'old-id', sourceIndex: '2099'});
  const fresh = normalizePapers([paper({id: 'import-new-1', sourceIndex: '0006', doi: '10.1234/ORIGINAL', sourceStatus: '原156序号：6；原2174编号：0050'})]);
  const current = {papers: [previous]};
  const before = structuredClone({fresh, current});
  const result = carryCompletedImports(fresh, current);
  assert.equal(result.restoredCount, 1);
  assert.equal(result.papers[0].status, 'success');
  assert.equal(result.papers[0].filename, previous.filename);
  assert.equal(result.papers[0].downloadId, previous.downloadId);
  assert.equal(result.papers[0].downloadUrl, previous.downloadUrl);
  assert.equal(result.papers[0].finishedAt, previous.finishedAt);
  assert.equal(result.papers[0].attempts, 2);
  assert.equal(result.papers[0].id, 'import-new-1');
  assert.equal(result.papers[0].sourceIndex, '0006');
  assert.equal(result.papers[0].doi, '10.1234/ORIGINAL');
  assert.equal(result.papers[0].sourceStatus, fresh[0].sourceStatus);
  assert.deepEqual({fresh, current}, before, 'carryover must not mutate either input');
});

test('core: success survives importing another list and returning, while failure is never archived as success', () => {
  const previous = successful();
  const failed = {...successful({title: 'Failed study', doi: '10.1234/failed'}), status: 'failed'};
  const elsewhere = carryCompletedImports(normalizePapers([paper({title: 'Other list', doi: '10.1234/other'})]), {papers: [previous, failed]});
  assert.equal(elsewhere.restoredCount, 0);
  assert.equal(elsewhere.completedPapers.length, 1);
  const returned = carryCompletedImports(normalizePapers([paper({id: 'return-1', sourceIndex: '0099'}), paper({title: failed.title, doi: failed.doi})]), elsewhere);
  assert.equal(returned.restoredCount, 1);
  assert.deepEqual(returned.papers.map(p => p.status), ['success', 'pending']);
  assert.equal(returned.papers[0].filename, previous.filename);
  assert.equal(returned.papers[0].downloadId, previous.downloadId);
  assert.equal(returned.papers[0].sourceIndex, '0099');
});

test('core: different abstracts sharing a book DOI and PDF must not inherit one another\'s success', () => {
  const previous = successful({title: 'Abstract A', doi: '10.1234/book', pdfUrl});
  const fresh = normalizePapers([
    paper({title: 'Abstract B', doi: '10.1234/book', pdfUrl}),
    paper({title: 'Abstract C', doi: '', pdfUrl}),
    paper({title: '  ABSTRACT   A ', doi: '10.1234/BOOK', pdfUrl}),
  ]);
  const result = carryCompletedImports(fresh, {papers: [previous]});
  assert.equal(result.restoredCount, 1);
  assert.deepEqual(result.papers.map(p => p.status), ['pending', 'pending', 'success']);
});

test('core: matching only a title or only a target never restores a success', () => {
  const old = successful({pdfUrl});
  const fresh = normalizePapers([
    paper({doi: '10.1234/different', pdfUrl: 'https://files.example/different.pdf'}),
    paper({title: 'Different title', pdfUrl}),
  ]);
  const result = carryCompletedImports(fresh, {papers: [old]});
  assert.equal(result.restoredCount, 0);
  assert.ok(result.papers.every(p => p.status === 'pending' && p.downloadId === null));
});

test('core: a known PDF remains completed when metadata gains a DOI, and DOI success survives adding a PDF', () => {
  const fromPdf = carryCompletedImports(normalizePapers([paper({pdfUrl})]), {papers: [successful({doi: '', pdfUrl})]});
  assert.equal(fromPdf.restoredCount, 1);
  assert.equal(fromPdf.papers[0].doi, '10.1234/original');
  const fromDoi = carryCompletedImports(normalizePapers([paper({pdfUrl})]), {papers: [successful()]});
  assert.equal(fromDoi.restoredCount, 1);
  assert.equal(fromDoi.papers[0].pdfUrl, pdfUrl);
});

test('core: forged success in imported data does not survive parsing or normalization', () => {
  const forged = paper({status: 'success', filename: 'forged.pdf', downloadId: 999, attempts: 8});
  for (const raw of [[forged], parseBibliography(JSON.stringify({papers: [forged], completedPapers: [forged]}), 'forged.json').papers]) {
    const normalized = normalizePapers(raw);
    const result = carryCompletedImports(normalized, {papers: [], completedPapers: []});
    assert.equal(result.restoredCount, 0);
    assert.equal(result.papers[0].status, 'pending');
    assert.equal(result.papers[0].downloadId, null);
    assert.equal(result.papers[0].filename, '');
    assert.equal(result.papers[0].attempts, 0);
  }
});

test('CSV: retry export excludes success and round-trips DOI, PDF, manual webpage and original indices', () => {
  const rows = [
    successful(),
    paper({id: 'doi', sourceIndex: '0050', title: '引文, "DOI" 题名', status: 'failed', reason: '查找失败；参考文献 10.9876/irrelevant'}),
    paper({id: 'pdf', sourceIndex: '1305', title: 'PDF study', doi: '', pdfUrl, status: 'pending', sourceStatus: '原156序号：95；原2174编号：1305'}),
    paper({id: 'html', sourceIndex: '0407', title: 'Manual full text', doi: '', landingUrl, status: 'missing_doi'}),
    paper({id: 'search', sourceIndex: '0100', title: 'Still searching', doi: '10.1234/searching', status: 'searching'}),
    paper({id: 'download', sourceIndex: '0101', title: 'Still downloading', doi: '', pdfUrl: 'https://files.example/in-progress.pdf', status: 'downloading'}),
  ];
  const before = structuredClone(rows);
  const result = roundTrip(rows);
  assert.equal(result.parsed.warnings.length, 0);
  assert.deepEqual(result.papers.map(p => p.sourceIndex), ['0050', '1305', '0407', '0100', '0101']);
  assert.equal(result.papers[0].title, rows[1].title);
  assert.equal(result.papers[0].doi, rows[1].doi);
  assert.equal(result.papers[1].pdfUrl, pdfUrl);
  assert.equal(result.papers[1].sourceStatus.includes('原156序号：95；原2174编号：1305'), true);
  assert.equal(result.papers[2].landingUrl, landingUrl);
  assert.equal(result.papers[2].pdfUrl, '');
  assert.equal(result.papers[2].doi, '');
  assert.deepEqual(result.papers.map(p => p.status), ['pending', 'pending', 'missing_doi', 'pending', 'pending']);
  assert.ok(result.papers.every(p => p.downloadId === null && p.filename === ''));
  assert.deepEqual(rows, before);
});

test('CSV: failed-only export contains only attempted failures and preserves URL-only failures', () => {
  const result = roundTrip([
    successful(),
    paper({status: 'failed', sourceIndex: '0012', reason: '浏览器下载中断'}),
    paper({title: 'PDF failed', status: 'failed', sourceIndex: '0013', doi: '', pdfUrl, reason: 'HTTP403'}),
    paper({title: 'Pending', status: 'pending'}),
    paper({title: 'Missing', doi: '', status: 'missing_doi', landingUrl}),
  ], {failedOnly: true});
  assert.equal(result.papers.length, 2);
  assert.deepEqual(result.papers.map(p => p.sourceIndex), ['0012', '0013']);
  assert.deepEqual(result.papers.map(p => p.status), ['pending', 'pending']);
  assert.equal(result.papers[1].pdfUrl, pdfUrl);
  assert.match(result.papers[1].sourceStatus, /前次状态：failed.*HTTP403/);
});

test('TXT: legacy Chinese failure reports read explicit title/DOI fields and never DOIs quoted in reasons', () => {
  for (const heading of ['尚未获取全文的文献清单', '尝试后仍未下载成功的文献']) {
    const text = [heading, '导出时间：2026-10-05', '===== 尝试后失败（2 条） =====', '',
      '原编号：0050', '题目：原文题名（含参考号 10.8888/in-title）', 'DOI：https://doi.org/10.1234/Correct',
      '原因：未获得全文；网页提及另一论文 DOI: 10.9999/wrong', '尝试次数：1', '',
      '原编号：0161', '题目：尚未确认标识符的原文', 'DOI：未确认',
      '原因：相近文献为 https://doi.org/10.9999/other，不是本篇', '尝试次数：0', ''].join('\r\n');
    const parsed = parseBibliography('\uFEFF' + text, '未获取全文.txt');
    assert.equal(parsed.format, '插件报告 TXT');
    assert.equal(parsed.papers.length, 2);
    assert.deepEqual(parsed.papers.map(p => p.sourceIndex), ['0050', '0161']);
    assert.equal(parsed.papers[0].title, '原文题名（含参考号 10.8888/in-title）');
    assert.deepEqual(parsed.papers.map(p => p.doi), ['10.1234/Correct', '']);
    assert.deepEqual(normalizePapers(parsed.papers).map(p => p.status), ['pending', 'missing_doi']);
  }
});

test('TXT: report PDF and manual landing fields stay distinct when reimported', () => {
  const text = ['尚未获取全文的文献清单', '原编号: 1305', '题目: PDF only', 'DOI: 未确认',
    `PDF 直链: ${pdfUrl}`, '网页入口（人工打开）: 未提供', '原因: 网络超时', '',
    '原编号：0407', '题目：HTML only', 'DOI：未确认', 'PDF 直链：未提供',
    `网页入口（人工打开）：${landingUrl}`, '原因：缺少 DOI / PDF 直链'].join('\n');
  const result = normalizePapers(parseBibliography(text, 'report.txt').papers);
  assert.equal(result.length, 2);
  assert.equal(result[0].pdfUrl, pdfUrl);
  assert.equal(result[0].status, 'pending');
  assert.equal(result[1].landingUrl, landingUrl);
  assert.equal(result[1].pdfUrl, '');
  assert.equal(result[1].status, 'missing_doi');
});

test('engine: IMPORT retains a real successful download after changing lists and returning, without downloading it again', async () => {
  const original = paper({id: 'original', sourceIndex: '1305', doi: '', pdfUrl});
  const f = await createChromeFixture({bundle: {papers: [original]}});
  assert.equal((await f.send({type: 'START', limit: 0, settings: {delaySeconds: 0.25}})).ok, true);
  const running = (await f.send({type: 'GET_STATE'})).state;
  await f.completeDownload(running.papers[0].downloadId, {filename: 'C:\\Downloads\\actual-original.pdf'});
  await f.advance(500);
  const completed = (await f.send({type: 'GET_STATE'})).state.papers[0];
  assert.equal(completed.status, 'success');
  const other = paper({id: 'other', title: 'Other list', sourceIndex: '0001', doi: '', pdfUrl: 'https://files.example/other.pdf'});
  assert.equal((await f.send({type: 'IMPORT', papers: [other], sourceName: 'Other'})).ok, true);
  const imported = await f.send({type: 'IMPORT', papers: [{...original, id: 'returned-id', sourceIndex: '0029'}], sourceName: 'Returned'});
  assert.equal(imported.ok, true);
  const returned = imported.state.papers[0];
  assert.equal(returned.status, 'success');
  assert.equal(returned.id, 'returned-id');
  assert.equal(returned.sourceIndex, '0029');
  assert.equal(returned.filename, completed.filename);
  assert.equal(returned.downloadId, completed.downloadId);
  assert.equal((await f.send({type: 'START', limit: 0})).ok, true);
  await f.advance(500);
  assert.equal(f.calls.downloads.length, 1);
  assert.equal(f.calls.navigation.length, 0);
});

test('engine: IMPORT does not trust an incoming success flag absent local completion evidence', async () => {
  const f = await createChromeFixture({bundle: {papers: [paper({title: 'Existing list'})]}});
  const forged = successful({id: 'forged', sourceIndex: '0088', title: 'Never downloaded', doi: '', pdfUrl});
  const result = await f.send({type: 'IMPORT', papers: [forged], sourceName: 'Untrusted file'});
  assert.equal(result.ok, true);
  assert.equal(result.state.papers[0].status, 'pending');
  assert.equal(result.state.papers[0].downloadId, null);
  assert.equal(result.state.papers[0].filename, '');
  assert.equal(f.calls.downloads.length, 0);
});
