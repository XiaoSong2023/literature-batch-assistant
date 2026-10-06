// Renders the dashboard with invented demo data and saves README screenshots.
//   node tools/capture_screenshots.mjs [outputDir]
// No extension backend runs: chrome.* is a small in-page stand-in, and nothing is downloaded.
import fs from 'node:fs/promises';
import path from 'node:path';
import {loadPlaywright, chromeExecutable, serveExtension} from '../tests/browser-env.mjs';
import {createDemoBibliography, decorateDemoProgress} from '../tests/fixtures/demo-papers.mjs';
import {createInitialState} from '../extension/core.js';

const root = path.resolve(import.meta.dirname, '..');
const extensionDir = path.join(root, 'extension');
const outDir = path.resolve(process.argv[2] || path.join(root, 'docs', 'screenshots'));
const manifest = JSON.parse(await fs.readFile(path.join(extensionDir, 'manifest.json'), 'utf8'));

export function demoState({count = 2174, done = 0.62, running = true, activeIndex = 1318} = {}) {
  const state = createInitialState({sourceName: '示例文献清单_2174条.ris', papers: createDemoBibliography(count)});
  state.papers = decorateDemoProgress(state.papers, {done, activeIndex: running ? activeIndex : null});
  state.running = running;
  state.activeId = running ? state.papers[activeIndex].id : null;
  state.tabId = running ? 7 : null;
  state.progressMessage = running ? '已提交 DOI，正在识别结果页…' : '';
  state.phaseDeadlineAt = running ? Date.now() + 9000 : 0;
  state.log = [
    {at: '2026-10-06T08:12:03Z', message: '开始本轮，数量：全部待处理。'},
    {at: '2026-10-06T08:12:05Z', message: '0001 已下载并通过 PDF 核验。'},
    {at: '2026-10-06T08:12:09Z', message: '0002 已下载并通过 PDF 核验。'},
    {at: '2026-10-06T08:12:14Z', message: '0003 网站明确提示未找到，已记录，可稍后重试。'},
  ];
  return state;
}

/** Fake extension APIs injected before the dashboard modules load. */
export function installFakeChrome({state, version}) {
  window.fixtureState = state;
  window.fixtureListeners = [];
  window.chrome = {
    runtime: {
      getManifest: () => ({version}),
      async sendMessage(message) {
        const s = window.fixtureState;
        if (message.type === 'START' || message.type === 'RETRY_UNFINISHED') s.running = true;
        if (message.type === 'PAUSE') { s.running = false; s.waitingForVerification = false; }
        if (message.type === 'IMPORT') {
          s.sourceName = message.sourceName;
          s.importedAt = new Date().toISOString();
          s.papers = message.papers.map(p => ({...p, status: p.doi || p.pdfUrl ? 'pending' : 'missing_doi', attempts: 0}));
          s.activeId = null;
        }
        return {ok: true, state: structuredClone(s)};
      },
    },
    storage: {onChanged: {addListener: callback => window.fixtureListeners.push(callback)}},
    downloads: {async download() { return 1; }},
    tabs: {async create() {}, async update() {}},
  };
  window.pushFixtureState = next => {
    window.fixtureState = next;
    for (const listener of window.fixtureListeners) listener({}, 'local');
  };
}

export async function openDashboard(browser, {state, colorScheme = 'light', width = 1440, height = 1000, reducedMotion = 'no-preference', recordVideo} = {}) {
  const context = await browser.newContext({viewport: {width, height}, colorScheme, reducedMotion, deviceScaleFactor: 1, serviceWorkers: 'block', recordVideo});
  await serveExtension(context, extensionDir);
  await context.addInitScript(installFakeChrome, {state, version: manifest.version});
  const page = await context.newPage();
  await page.goto('https://fixture.example/dashboard.html');
  await page.waitForFunction(count => document.getElementById('totalCount').textContent === String(count), state.papers.length);
  await page.evaluate(() => document.fonts.ready);
  return {context, page};
}

async function main() {
  const {chromium} = loadPlaywright();
  const browser = await chromium.launch({headless: true, executablePath: chromeExecutable()});
  await fs.mkdir(outDir, {recursive: true});
  const shots = [];
  async function capture(name, options, prepare) {
    const {context, page} = await openDashboard(browser, options);
    await page.waitForTimeout(1600);
    if (prepare) await prepare(page);
    // JPEG keeps the paper grain while staying small enough for a README.
    const file = path.join(outDir, `${name}.jpg`);
    await page.screenshot({path: file, type: 'jpeg', quality: 88, fullPage: Boolean(options.fullPage)});
    shots.push(path.relative(root, file));
    await context.close();
  }
  await capture('dashboard-light', {state: demoState()});
  await capture('dashboard-dark', {state: demoState(), colorScheme: 'dark'});
  await capture('empty-state', {state: createInitialState({papers: []})});
  await capture('records', {state: demoState()}, async page => {
    await page.locator('#showRecords').click();
    await page.waitForTimeout(900);
  });
  await capture('import-preview', {state: demoState({running: false})}, async page => {
    await page.locator('#showImport').click();
    await page.locator('#doiText').fill('10.5555/demo.2024.10001\nhttps://doi.org/10.5555/demo.2024.10002\nhttps://example.org/open-access/article.pdf');
    await page.locator('#previewImport').click();
    await page.waitForTimeout(900);
  });
  await browser.close();
  console.log(JSON.stringify({outDir: path.relative(root, outDir), shots}, null, 2));
}

if (import.meta.url === `file:///${process.argv[1].replaceAll('\\', '/')}` || process.argv[1]?.endsWith('capture_screenshots.mjs')) await main();
