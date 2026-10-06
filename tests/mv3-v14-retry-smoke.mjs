// Real MV3 acceptance on an isolated temporary profile, with synthetic loopback files only.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {loadPlaywright, loadModule} from './browser-env.mjs';
import {parseBibliography} from '../extension/importers.js';
import {normalizePapers} from '../extension/core.js';

const {chromium} = loadPlaywright();
const {PDFDocument, StandardFonts} = loadModule('pdf-lib');
const extensionDir = path.resolve(import.meta.dirname, '../extension');
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'literature-v14-retry-test-'));
const downloadDir = path.join(work, 'downloads'), profileDir = path.join(work, 'profile');
await fs.mkdir(downloadDir);
await fs.mkdir(path.join(profileDir, 'Default'), {recursive: true});
await fs.writeFile(path.join(profileDir, 'Default', 'Preferences'), JSON.stringify({download: {default_directory: downloadDir, prompt_for_download: false, directory_upgrade: true}, savefile: {default_directory: downloadDir}}));
const pdfDoc = await PDFDocument.create(), font = await pdfDoc.embedFont(StandardFonts.Helvetica), pdfPage = pdfDoc.addPage();
pdfPage.drawText('V1.4 LOCAL TEST - SYNTHETIC PDF, NOT A RESEARCH ARTICLE', {x: 35, y: 750, size: 12, font});
for (let i = 0; i < 42; i++) pdfPage.drawText(`Line ${i + 1}: ${'abcdefghijklmnopqrstuvwxyz'.repeat(2)}`, {x: 35, y: 725 - i * 15, size: 8, font});
const pdf = Buffer.from(await pdfDoc.save({useObjectStreams: false}));
const requests = [], externalBlocked = [], pageErrors = [];
let bIsPdf = false, interruptHealthy = false;
const server = http.createServer((req, res) => {
  requests.push({path: req.url, range: req.headers.range || '', time: Date.now()});
  if (req.url === '/interrupt' && !interruptHealthy) {
    // A truncated transfer, with no range machinery: keep failing until Chrome reports interruption.
    res.writeHead(200, {'content-type': 'application/pdf', 'content-length': pdf.length});
    res.write(pdf.subarray(0, 1536));
    setTimeout(() => res.destroy(), 100);
    return;
  }
  const html = req.url === '/b' && !bIsPdf;
  const body = html ? Buffer.from(`<html><body>${'Synthetic login page, not PDF. '.repeat(150)}</body></html>`) : pdf;
  res.writeHead(200, {'content-type': html ? 'text/html' : 'application/pdf', 'content-length': body.length, 'cache-control': 'no-store'});
  res.end(body);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://fixture-v14.test:${server.address().port}`;
const records = [
  {id: 'c', sourceIndex: '0101', title: 'C_PENDING_SENTINEL', pdfUrl: `${base}/c`},
  {id: 'a', sourceIndex: '0102', title: 'A_SUCCESS_SENTINEL', pdfUrl: `${base}/a`},
  {id: 'b', sourceIndex: '0103', title: 'B_RETRY_HTML_SENTINEL', pdfUrl: `${base}/b`},
  {id: 'manual', sourceIndex: '0104', title: 'MANUAL_HTML_SENTINEL', landingUrl: `${base}/manual`},
];
const count = endpoint => requests.filter(r => r.path === endpoint).length;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = {ok: false, date: '2026-10-06', version: '1.4.0', profile: work, externalArticleDownloads: false, checks: {}, requests, externalBlocked};
let context, page, message;
async function poll(check, description, timeout = 30000) {
  const end = Date.now() + timeout;
  do { const value = await check(); if (value) return value; await delay(100); } while (Date.now() < end);
  throw Error(`Timed out: ${description}`);
}
async function idle() {
  return poll(async () => {const state = (await message({type: 'GET_STATE'})).state; return !state.running && !state.activeId && state;}, 'queue idle');
}
async function downloadViaButton(id, suffix) {
  const before = new Set((await page.evaluate(() => chrome.downloads.search({}))).map(i => i.id));
  await page.locator(`#${id}`).click();
  const item = await poll(async () => (await page.evaluate(() => chrome.downloads.search({}))).find(i => !before.has(i.id) && i.filename?.endsWith(suffix) && i.state === 'complete'), `${suffix} export saved`);
  return {item, bytes: await fs.readFile(item.filename)};
}
function unzipStored(bytes) {
  assert.equal(bytes.readUInt32LE(0), 0x04034b50, 'DOCX must begin with PK, without a text BOM');
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  let offset = bytes.readUInt32LE(end + 16);
  const files = new Map();
  for (let n = 0; n < bytes.readUInt16LE(end + 10); n++) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const nameLength = bytes.readUInt16LE(offset + 28), extraLength = bytes.readUInt16LE(offset + 30), commentLength = bytes.readUInt16LE(offset + 32);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const local = bytes.readUInt32LE(offset + 42), size = bytes.readUInt32LE(offset + 24);
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    assert.equal(bytes.readUInt16LE(local + 8), 0);
    const data = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    files.set(name, bytes.subarray(data, data + size).toString('utf8'));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(offset, end);
  return files;
}
try {
  context = await chromium.launchPersistentContext(profileDir, {
    executablePath: process.env.CHROMIUM_EXE || undefined,
    headless: true, acceptDownloads: true, viewport: {width: 1440, height: 1000},
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, '--no-proxy-server', '--disable-background-networking', '--host-resolver-rules=MAP fixture-v14.test 127.0.0.1, MAP * ~NOTFOUND'],
  });
  await context.route(/^https?:\/\//, route => {
    const url = route.request().url();
    if (new URL(url).hostname === 'fixture-v14.test') return route.continue();
    externalBlocked.push(url); return route.abort();
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', {timeout: 15000});
  const extensionId = new URL(worker.url()).hostname;
  page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  const cdp = await context.newCDPSession(page);
  await cdp.send('Browser.setDownloadBehavior', {behavior: 'default', eventsEnabled: true});
  await page.goto(`chrome-extension://${extensionId}/dashboard.html`);
  await page.waitForFunction(() => /^\d+$/.test(document.getElementById('totalCount').textContent));
  message = payload => page.evaluate(value => chrome.runtime.sendMessage(value), payload);
  assert.equal(await page.evaluate(() => chrome.runtime.getManifest().version), JSON.parse(await fs.readFile(path.join(extensionDir, 'manifest.json'), 'utf8')).version);
  await page.evaluate(() => {globalThis.testDownloadEvents = []; chrome.downloads.onChanged.addListener(delta => globalThis.testDownloadEvents.push(delta));});
  assert.equal((await message({type: 'IMPORT', papers: records, sourceName: 'V14 LOCAL SYNTHETIC ACCEPTANCE'})).ok, true);
  assert.equal(requests.length, 0);
  assert.equal((await message({type: 'START_FROM', startFromNumber: 2, settings: {delaySeconds: 0.25, downloadTimeoutSeconds: 30}})).ok, true);
  const initial = await idle();
  assert.deepEqual(initial.papers.map(p => p.status), ['pending', 'success', 'failed', 'missing_doi']);
  assert.equal(initial.papers[2].reasonCode, 'unverified_file_type');
  assert.deepEqual([count('/a'), count('/b'), count('/c'), count('/manual')], [1, 1, 0, 0]);
  report.checks.initial = initial.papers.map(p => ({sourceIndex: p.sourceIndex, status: p.status, reasonCode: p.reasonCode}));
  assert.equal(await page.locator('#retry').textContent(), '重试失败项');
  assert.equal(await page.locator('#retryRemaining').textContent(), '继续所有未完成');
  await page.screenshot({path: path.join(import.meta.dirname, 'mv3-v14-retry-before.png'), fullPage: true});

  const word = await downloadViaButton('exportWord', '.docx'), zip = unzipStored(word.bytes);
  assert.ok(zip.has('[Content_Types].xml') && zip.has('word/document.xml'));
  const xml = zip.get('word/document.xml');
  for (const marker of ['C_PENDING_SENTINEL', 'B_RETRY_HTML_SENTINEL', 'MANUAL_HTML_SENTINEL']) assert.ok(xml.includes(marker));
  assert.equal(xml.includes('A_SUCCESS_SENTINEL'), false);
  report.checks.word = {saved: true, filename: path.basename(word.item.filename), bytes: word.bytes.length, header: word.bytes.subarray(0, 4).toString('hex'), zipEntries: [...zip.keys()], excludesSuccess: true};
  const csv = await downloadViaButton('exportRetryCsv', '.csv');
  const parsed = parseBibliography(csv.bytes.toString('utf8'), 'retry.csv'), normalized = normalizePapers(parsed.papers);
  assert.equal(parsed.warnings.length, 0);
  assert.deepEqual(normalized.map(p => p.sourceIndex), ['0101', '0103', '0104']);
  assert.deepEqual(normalized.map(p => p.status), ['pending', 'pending', 'missing_doi']);
  assert.equal(normalized[2].landingUrl, `${base}/manual`);
  assert.equal(normalized[2].pdfUrl, '');
  await page.locator('#importFile').setInputFiles(csv.item.filename);
  await page.locator('#previewImport').click();
  await page.waitForFunction(() => document.getElementById('importSummary').textContent.includes('共解析 3 条'));
  assert.equal(await page.locator('#importPreview').isVisible(), true);
  assert.equal(await page.locator('#importWarningDetails').isVisible(), false);
  assert.equal((await message({type: 'GET_STATE'})).state.papers.length, 4, 'Preview must not replace the active queue');
  report.checks.retryCsv = {saved: true, records: normalized.length, warnings: parsed.warnings, excludesSuccess: true, manualNotDownloaded: true, realDashboardPreview: true};

  bIsPdf = true;
  await page.locator('#retry').click();
  const failedRetry = await idle();
  assert.deepEqual(failedRetry.papers.map(p => p.status), ['pending', 'success', 'success', 'missing_doi']);
  assert.deepEqual([count('/a'), count('/b'), count('/c')], [1, 2, 0]);
  assert.equal(failedRetry.papers[1].downloadId, initial.papers[1].downloadId);
  report.checks.failedOnly = {requestsA: count('/a'), requestsB: count('/b'), requestsC: count('/c'), successIdRetained: true};
  await page.locator('#retryRemaining').click();
  const all = await idle();
  assert.deepEqual(all.papers.map(p => p.status), ['success', 'success', 'success', 'missing_doi']);
  assert.deepEqual([count('/a'), count('/b'), count('/c'), count('/manual')], [1, 2, 1, 0]);
  report.checks.unfinished = {earlierPendingCompleted: true, requestsA: count('/a'), requestsB: count('/b'), requestsC: count('/c')};
  const saved = [];
  for (const p of all.papers.filter(p => p.status === 'success')) {
    const item = await page.evaluate(async id => (await chrome.downloads.search({id}))[0], p.downloadId);
    const bytes = await fs.readFile(item.filename);
    assert.equal(item.byExtensionId, extensionId); assert.equal(item.state, 'complete');
    assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
    saved.push({title: p.title, downloadId: p.downloadId, filename: path.basename(item.filename), bytes: bytes.length});
  }
  const beforeReimport = requests.length;
  const imported = await message({type: 'IMPORT', papers: records.map((p, i) => ({...p, id: `new-${i}`, sourceIndex: String(i + 201)})), sourceName: 'REIMPORTED'});
  assert.equal(imported.ok, true);
  assert.deepEqual(imported.state.papers.map(p => p.status), ['success', 'success', 'success', 'missing_doi']);
  for (let i = 0; i < 3; i++) {
    assert.equal(imported.state.papers[i].downloadId, all.papers[i].downloadId);
    assert.equal(imported.state.papers[i].filename, all.papers[i].filename);
    assert.equal(imported.state.papers[i].id, `new-${i}`);
  }
  assert.equal((await message({type: 'START', limit: 0})).ok, true); await idle();
  assert.equal(requests.length, beforeReimport);
  report.checks.reimport = {retainsSuccess: true, retainsRealFilesAndIds: true, newRequests: requests.length - beforeReimport};
  report.savedFiles = saved;
  await page.screenshot({path: path.join(import.meta.dirname, 'mv3-v14-retry-after.png'), fullPage: true});

  // Optional real interrupted-transfer exercise: record Chrome's own event before enabling a healthy response.
  await worker.evaluate(() => {
    globalThis.testResumeCalls = [];
    const original = chrome.downloads.resume.bind(chrome.downloads);
    chrome.downloads.resume = async (...args) => {
      const entry = {id: args[0], startedAt: Date.now()};
      globalThis.testResumeCalls.push(entry);
      try {const value = await original(...args); entry.resolved = true; return value;}
      catch (error) {entry.error = error.message || String(error); throw error;}
    };
  });
  const startEvents = await page.evaluate(() => globalThis.testDownloadEvents.length);
  assert.equal((await message({type: 'IMPORT', sourceName: 'LOCAL TRUNCATED TRANSFER', papers: [{id: 'network', sourceIndex: '0301', title: 'NETWORK_INTERRUPTION_SENTINEL', pdfUrl: `${base}/interrupt`}]})).ok, true);
  assert.equal((await message({type: 'START', limit: 0, settings: {delaySeconds: 0.25, downloadTimeoutSeconds: 30}})).ok, true);
  const interrupted = await poll(async () => (await page.evaluate(offset => globalThis.testDownloadEvents.slice(offset), startEvents)).find(e => e.state?.current === 'interrupted'), 'Chrome interrupted transfer event', 20000);
  interruptHealthy = true;
  const recovered = await idle(), item = recovered.papers[0];
  const events = await page.evaluate(offset => globalThis.testDownloadEvents.slice(offset), startEvents);
  report.checks.network = {chromeInterrupted: interrupted, events, resumeCalls: await worker.evaluate(() => globalThis.testResumeCalls), finalStatus: item.status, reasonCode: item.reasonCode, retryCount: item.downloadRetryCount || 0, lastError: item.lastDownloadError || '', requests: count('/interrupt')};
  assert.equal(item.status, 'success', JSON.stringify(report.checks.network));
  assert.ok(count('/interrupt') >= 2);
  assert.ok(item.downloadRetryCount >= 1, 'Extension should perform a real recovery after Chrome interruption');
  const networkDownload = await page.evaluate(async id => (await chrome.downloads.search({id}))[0], item.downloadId);
  const recoveredBytes = await fs.readFile(networkDownload.filename);
  assert.ok(recoveredBytes.equals(pdf), 'Recovered file must exactly match the complete synthetic PDF');
  report.checks.network.finalFileMatchesSource = true;
  report.checks.network.finalBytes = recoveredBytes.length;
  assert.equal(pageErrors.length, 0, pageErrors.join('\n'));
  report.pageErrors = pageErrors;
  report.realExtensionLoaded = true;
  report.ok = true;
} catch (error) {
  report.error = error.stack || String(error);
  if (message) report.finalState = (await message({type: 'GET_STATE'}).catch(() => null))?.state;
  if (page) await page.screenshot({path: path.join(import.meta.dirname, 'mv3-v14-retry-failure.png'), fullPage: true}).catch(() => {});
  throw error;
} finally {
  await fs.writeFile(path.join(import.meta.dirname, 'mv3-v14-retry-result.json'), JSON.stringify(report, null, 2));
  if (context) await context.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  console.log(JSON.stringify(report, null, 2));
}
