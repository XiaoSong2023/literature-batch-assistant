import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { inspectPage, submitDoi, clickRobotNo } from '../extension/content.js';
import { loadPlaywright, chromeExecutable } from './browser-env.mjs';

const { chromium } = loadPlaywright();

test('content scripts work against real Chromium DOM fixtures with all network intercepted', async t => {
  const browser = await chromium.launch({ headless: true, executablePath: chromeExecutable() });
  t.after(() => browser.close());
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('**/*', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body></body></html>' }));
  const page = await context.newPage();
  await page.goto('https://fixture.example/');

  await t.test('visible DOI form is recognized and native submission receives exact DOI', async () => {
    await page.setContent('<form action="https://sci-hub.box/"><input name="request"><button type="submit">Search</button></form>');
    assert.equal((await page.evaluate(inspectPage)).kind, 'home');
    await page.evaluate(() => {
      window.seen = [];
      document.querySelector('input').addEventListener('input', event => window.seen.push(['input', event.target.value]));
      document.querySelector('form').addEventListener('submit', event => { event.preventDefault(); window.seen.push(['submit', new FormData(event.target).get('request')]); });
    });
    assert.deepEqual(await page.evaluate(submitDoi, '10.1234/exact'), { ok: true });
    assert.deepEqual(await page.evaluate(() => window.seen), [['input', '10.1234/exact'], ['submit', '10.1234/exact']]);
  });

  await t.test('actual observed textarea form submits native value and challenge is recognized', async () => {
    const home = await fs.readFile(path.resolve(import.meta.dirname, '../data/site-home-observed.html'), 'utf8');
    await page.setContent(home.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ''));
    assert.equal((await page.evaluate(inspectPage)).kind, 'home');
    // The observed relative form action is valid at its actual origin; intercept all network.
    await page.goto('https://sci-hub.box/');
    await page.setContent(home.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ''));
    await page.evaluate(() => document.querySelector('form').addEventListener('submit', event => event.preventDefault()));
    assert.deepEqual(await page.evaluate(submitDoi, '10.1234/textarea'), { ok: true });
    assert.equal(await page.locator('textarea[name="request"]').inputValue(), '10.1234/textarea');
    const challenge = await fs.readFile(path.resolve(import.meta.dirname, '../data/site-first-result-observed.html'), 'utf8');
    await page.setContent(challenge.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ''));
    assert.equal((await page.evaluate(inspectPage)).kind, 'captcha');
    await page.goto('https://fixture.example/');
  });

  await t.test('embedded PDF URL resolves and unsafe URL schemes are rejected', async () => {
    await page.setContent('<iframe id="pdf" src="/files/article.pdf#page=3"></iframe>');
    const {readyState,...result}=await page.evaluate(inspectPage);
    assert.match(readyState,/loading|interactive|complete/);
    assert.deepEqual(result, { kind: 'pdf', url: 'https://fixture.example/files/article.pdf', pageUrl: 'https://fixture.example/', evidence: 'iframe' });
    await page.setContent('<iframe id="pdf" src="javascript:void(0)"></iframe><a href="http://127.0.0.1/internal.pdf">PDF</a>');
    assert.equal((await page.evaluate(inspectPage)).kind, 'unknown');
  });

  await t.test('CAPTCHA pauses ahead of apparent PDF and known not-found pages are classified', async () => {
    await page.setContent('<p>Verify you are human</p><a href="/paper.pdf">Download</a>');
    assert.equal((await page.evaluate(inspectPage)).kind, 'captcha');
    await page.setContent('<h1>Article not found</h1><footer><a href="/docs/SCI.pdf">Site documentation</a></footer>');
    assert.equal((await page.evaluate(inspectPage)).kind, 'not_found');
    await page.setContent('<h1>502 Bad Gateway</h1>');
    assert.equal((await page.evaluate(inspectPage)).kind, 'connection_error');
  });

  await t.test('off-site search action is not submitted', async () => {
    await page.setContent('<form action="https://other.example/"><input name="request"></form>');
    assert.equal((await page.evaluate(submitDoi, '10.1234/a')).ok, false);
  });

  await t.test('PDF and explicit absence can be inspected before a slow frame finishes loading', async () => {
    await page.route('**/hold-frame',()=>{});
    await page.route('**/slow-fixture',route=>route.fulfill({contentType:'text/html',body:'<iframe src="/hold-frame"></iframe><iframe id="pdf" src="/ready.pdf"></iframe>'}));
    await page.goto('https://fixture.example/slow-fixture',{waitUntil:'domcontentloaded'});
    assert.notEqual(await page.evaluate(()=>document.readyState),'complete');
    assert.equal((await page.evaluate(inspectPage)).kind,'pdf');
    await page.evaluate(()=>{document.getElementById('pdf').remove();document.body.insertAdjacentHTML('afterbegin','<h1>The requested article is not available in the database.</h1>');});
    assert.equal((await page.evaluate(inspectPage)).kind,'not_found');
    await page.unroute('**/hold-frame');
    await page.unroute('**/slow-fixture');
  });

  await t.test('exact known No button clicks once and unrelated No text is unsupported', async () => {
    await page.goto('https://sci-hub.box/');
    await page.setContent('<div class="question"><div class="ask">Are you a robot?</div><div class="answer">No</div><altcha-widget style="display:none"></altcha-widget></div>');
    await page.evaluate(()=>{window.noClicks=0;delete window.__literatureRobotClicked;document.querySelector('.answer').addEventListener('click',()=>window.noClicks++);});
    assert.equal((await page.evaluate(inspectPage)).robotNo,true);
    assert.deepEqual(await page.evaluate(clickRobotNo),{status:'clicked'});
    assert.deepEqual(await page.evaluate(clickRobotNo),{status:'already_clicked'});
    assert.equal(await page.evaluate(()=>window.noClicks),1);
    await page.setContent('<div class="question"><div class="ask">Are you a robot?</div><div class="answer">No thanks</div><altcha-widget style="display:none"></altcha-widget></div>');
    assert.deepEqual(await page.evaluate(clickRobotNo),{status:'unsupported'});
    await page.setContent('<h1>Complete the CAPTCHA</h1><button>No</button>');
    assert.equal((await page.evaluate(inspectPage)).robotNo,false);
    assert.deepEqual(await page.evaluate(clickRobotNo),{status:'unsupported'});
  });

  await t.test('captured sci-net.xyz sidebar and standard iframe expose the actual PDF URL',async()=>{
    await page.goto('https://sci-net.xyz/10.1111/scd.12848');
    const captured=await fs.readFile(path.resolve(import.meta.dirname,'../data/site-sci-net-observed.html'),'utf8');
    await page.setContent(captured.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,''));
    const result=await page.evaluate(inspectPage);
    assert.equal(result.kind,'pdf');
    assert.equal(result.evidence,'iframe');
    assert.match(result.url,/^https:\/\/sci-net\.xyz\/storage\/.*\/Oral-health-issues-of-late-Baby-Boomers-1956-1964\.pdf$/);
    assert.equal(result.url.includes('#'),false);
  });
});
