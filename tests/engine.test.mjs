import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState } from '../extension/core.js';
import { createChromeFixture } from './chrome-fixture.mjs';

const paper = (n, doi = `10.1234/paper-${n}`) => ({ id: `p${n}`, sourceIndex: n, title: `Paper ${n}`, doi });
const settings = { delaySeconds: 3, timeoutSeconds: 20, downloadTimeoutSeconds: 30 };

function siteFixture(outcomes = {}) {
  let navigationCount = 0;
  let doi;
  return ({ func, args, calls }) => {
    if (navigationCount !== calls.navigation.length) { navigationCount = calls.navigation.length; doi = null; }
    if (func.name === 'submitDoi') { doi = args[0]; return { ok: true }; }
    if (func.name === 'installPageWatcher') return {ok:true};
    if (func.name !== 'inspectPage') throw Error(`Unexpected injected function ${func.name}`);
    if (!doi) return { kind: 'home', url: 'https://sci-hub.box/', readyState:'complete' };
    return {readyState:'complete',...(outcomes[doi] ?? { kind: 'pdf', url: `https://files.fixture.example/${encodeURIComponent(doi)}.pdf` })};
  };
}

async function stateOf(fixture) {
  const result = await fixture.send({ type: 'GET_STATE' });
  assert.equal(result.ok, true, result.error);
  return result.state;
}

async function driveUntil(fixture, predicate, description, limit = 40) {
  for (let i = 0; i < limit; i++) {
    const state = await stateOf(fixture);
    if (predicate(state)) return state;
    await fixture.advance(2000);
  }
  assert.fail(`Fixture did not reach ${description}: ${JSON.stringify(await stateOf(fixture))}`);
}

async function make(papers, outcomes = {}, extra = {}) {
  return createChromeFixture({ bundle: { sourceName: 'Offline fixture', papers }, scriptHandler: siteFixture(outcomes), ...extra });
}

test('sequential queue confirms actual completion; rejects HTML and continues after not-found', async () => {
  const f = await make([paper(0, ''), paper(1), paper(2), paper(3), paper(4)], {
    '10.1234/paper-3': { kind: 'not_found', message: 'Article not found' },
  });
  assert.equal((await f.send({ type: 'START', limit: 0, settings })).ok, true);
  let state = await driveUntil(f, state => state.papers[1].status === 'downloading', 'first pending PDF');
  assert.equal(state.papers[0].status, 'missing_doi');
  assert.equal(state.papers[1].status, 'downloading');
  assert.equal(state.papers[2].status, 'pending');
  assert.equal(f.calls.downloads.length, 1);
  const firstId = state.papers[1].downloadId;
  await f.completeDownload(firstId);
  state = await driveUntil(f, state => state.papers[2].status === 'downloading', 'second PDF');
  assert.equal(state.papers[1].status, 'success');
  await f.completeDownload(state.papers[2].downloadId, { mime: 'text/html', fileSize: 4096 });
  state = await driveUntil(f, state => state.papers[4].status === 'downloading', 'fourth PDF after failures');
  assert.equal(state.papers[2].status, 'failed');
  assert.equal(state.papers[2].reasonCode, 'unverified_file_type');
  assert.equal(state.papers[3].status, 'failed');
  assert.equal(state.papers[3].reasonCode, 'not_found');
  await f.completeDownload(state.papers[4].downloadId);
  state = await driveUntil(f, state => !state.running, 'completed queue');
  assert.deepEqual(state.papers.map(p => p.status), ['missing_doi','success','failed','failed','success']);
  assert.equal(f.calls.downloads.length, 3);
  assert.equal(f.calls.navigation.filter(n => n.url === 'https://sci-hub.box/').length, 4);
  // Late duplicate completion events cannot credit the next paper.
  await f.chrome.downloads.onChanged.emit({ id: firstId, state: { current: 'complete' } });
  await f.settle();
  assert.equal((await stateOf(f)).processedThisRun, 4);
});

test('trial stops after three attempts and missing DOI does not consume an attempt', async () => {
  const f = await make([paper(0, ''), paper(1), paper(2), paper(3), paper(4)]);
  await f.send({ type: 'START', limit: 3, settings });
  for (let i = 1; i <= 3; i++) {
    const state = await driveUntil(f, s => s.papers[i].status === 'downloading', `trial paper ${i}`);
    await f.completeDownload(state.papers[i].downloadId);
  }
  const state = await stateOf(f);
  assert.equal(state.running, false);
  assert.equal(state.processedThisRun, 3);
  assert.equal(state.papers[4].status, 'pending');
  assert.equal(f.calls.downloads.length, 3);
});

test('pause accepts completion of in-flight download and resumes without redownloading it', async () => {
  const f = await make([paper(1), paper(2)]);
  await f.send({ type: 'START', limit: 0, settings });
  let state = await driveUntil(f, s => s.papers[0].status === 'downloading', 'in-flight PDF');
  await f.send({ type: 'PAUSE' });
  await f.completeDownload(state.papers[0].downloadId);
  await f.advance(6000);
  state = await stateOf(f);
  assert.equal(state.running, false);
  assert.equal(state.papers[0].status, 'success');
  assert.equal(state.papers[1].status, 'pending');
  assert.equal(f.calls.downloads.length, 1);
  await f.send({ type: 'START', limit: 0 });
  state = await driveUntil(f, s => s.papers[1].status === 'downloading', 'resume next PDF');
  assert.equal(f.calls.downloads.length, 2);
  assert.equal(state.papers[0].attempts, 1);
});

test('unrecognized result times out, records reason, and proceeds to next DOI', async () => {
  const f = await make([paper(1), paper(2)], { '10.1234/paper-1': { kind: 'unknown' } });
  await f.send({ type: 'START', limit: 0, settings });
  const state = await driveUntil(f, s => s.papers[1].status === 'downloading', 'next DOI after timeout');
  assert.equal(state.papers[0].status, 'failed');
  assert.equal(state.papers[0].reasonCode, 'detection_timeout');
  assert.equal(f.calls.downloads.length, 1);
});

test('download timeout cancels uncompleted transfer and proceeds', async () => {
  const f = await make([paper(1), paper(2)]);
  await f.send({ type: 'START', limit: 0, settings });
  const first = await driveUntil(f, s => s.papers[0].status === 'downloading', 'in-flight PDF');
  const state = await driveUntil(f, s => s.papers[1].status === 'downloading', 'next DOI after stalled transfer');
  assert.equal(state.papers[0].status, 'failed');
  assert.equal(state.papers[0].reasonCode, 'download_timeout');
  assert.deepEqual(f.calls.cancelled, [first.papers[0].downloadId]);
});

test('timeout cancellation race recognizes a completed PDF instead of reporting failure', async () => {
  const f = await make([paper(1), paper(2)]);
  f.chrome.downloads.cancel = async id => Object.assign(f.downloads.get(id), { state: 'complete', mime: 'application/pdf', fileSize: 2048, bytesReceived: 2048 });
  await f.send({ type: 'START', limit: 0, settings });
  const state = await driveUntil(f, s => s.papers[1].status === 'downloading', 'next DOI after completion/cancel race');
  assert.equal(state.papers[0].status, 'success');
});

test('failed cancellation pauses while retaining the live transfer and does not start next DOI', async () => {
  const f = await make([paper(1), paper(2)]);
  f.chrome.downloads.cancel = async () => { throw Error('Cancellation unavailable'); };
  await f.send({ type: 'START', limit: 0, settings });
  const state = await driveUntil(f, s => !s.running, 'pause after failed cancellation');
  assert.equal(state.papers[0].status, 'downloading');
  assert.equal(state.papers[1].status, 'pending');
  assert.equal(state.activeId, 'p1');
  assert.equal(f.calls.downloads.length, 1);
});

test('CAPTCHA pauses same DOI for manual action and resumes after it is resolved', async () => {
  const outcomes = { '10.1234/paper-1': { kind: 'captcha', message: 'Please verify you are human' } };
  const f = await make([paper(1), paper(2)], outcomes);
  await f.send({ type: 'START', limit: 0, settings });
  let state = await driveUntil(f, s => !s.running, 'CAPTCHA pause');
  assert.equal(state.papers[0].status, 'searching');
  assert.equal(state.papers[0].attempts, 1);
  assert.equal(f.calls.downloads.length, 0);
  await f.advance(120000);
  assert.equal((await stateOf(f)).papers[1].status, 'pending');
  outcomes['10.1234/paper-1'] = { kind: 'pdf', url: 'https://files.fixture.example/resolved.pdf' };
  await f.send({ type: 'START', limit: 0 });
  state = await driveUntil(f, s => s.papers[0].status === 'downloading', 'resolved CAPTCHA PDF');
  assert.equal(state.papers[0].attempts, 1);
});

test('closed task tab pauses and continuing reopens the same DOI without counting failure', async () => {
  const f = await make([paper(1), paper(2)]);
  await f.send({ type: 'START', limit: 0, settings });
  const initial = await stateOf(f);
  await f.chrome.tabs.remove(initial.tabId);
  await f.settle();
  let state = await stateOf(f);
  assert.equal(state.running, false);
  assert.equal(state.papers[0].status, 'searching');
  await f.send({ type: 'START', limit: 0 });
  state = await driveUntil(f, s => s.papers[0].status === 'downloading', 'reopened task tab');
  assert.notEqual(state.tabId, initial.tabId);
  assert.equal(state.papers[0].attempts, 1);
});

test('worker recovery finds persisted download intent and does not duplicate download', async () => {
  const state = createInitialState({ sourceName: 'Recovery fixture', papers: [paper(1), paper(2)] });
  const intentAt = Date.parse('2026-10-05T11:59:58Z');
  Object.assign(state, { running: true, activeId: 'p1', phase: 'download_starting', phaseStartedAt: intentAt });
  Object.assign(state.papers[0], { status: 'downloading', attempts: 1, downloadUrl: 'https://files.fixture.example/recovery.pdf', downloadIntentAt: intentAt, downloadId: null });
  const f = await make([], {}, {
    persisted: { literatureBatchState: state },
    session: { literatureBatchSession: intentAt - 10000 },
    downloadItems: [
      { id: 7, url: state.papers[0].downloadUrl, startTime: '2026-10-05T11:59:59Z', byExtensionId: 'other-extension', state: 'complete', mime: 'application/pdf', fileSize: 2048 },
      { id: 8, url: state.papers[0].downloadUrl, startTime: '2026-10-05T11:59:59Z', byExtensionId: 'offline-fixture-extension', state: 'complete', mime: 'application/pdf', fileSize: 2048 },
    ],
  });
  const recovered = await stateOf(f);
  assert.equal(recovered.papers[0].status, 'success');
  assert.equal(recovered.papers[0].downloadId, 8);
  assert.equal(f.calls.downloads.length, 0);
});

test('full browser restart pauses queue while reconciling in-flight completed download', async () => {
  const state = createInitialState({ sourceName: 'Restart fixture', papers: [paper(1), paper(2)] });
  Object.assign(state, { running: true, activeId: 'p1', phase: 'downloading' });
  Object.assign(state.papers[0], { status: 'downloading', attempts: 1, downloadId: 5, downloadIntentAt: Date.parse('2026-10-05T11:59:00Z') });
  const f = await make([], {}, {
    persisted: { literatureBatchState: state },
    downloadItems: [{ id: 5, state: 'complete', mime: 'application/pdf', fileSize: 2048 }],
  });
  const recovered = await stateOf(f);
  assert.equal(recovered.running, false);
  assert.equal(recovered.papers[0].status, 'success');
  assert.equal(recovered.papers[1].status, 'pending');
  assert.equal(f.calls.downloads.length, 0);
});

test('retry failed records keeps success and missing DOI intact', async () => {
  const state = createInitialState({ papers: [paper(0, ''), paper(1), paper(2)] });
  Object.assign(state.papers[1], { status: 'failed', reasonCode: 'not_found', reason: 'Article not found', attempts: 1 });
  Object.assign(state.papers[2], { status: 'success', attempts: 1 });
  const f = await make([], {}, { persisted: { literatureBatchState: state } });
  const result = await f.send({ type: 'RETRY_FAILED' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.state.papers.map(p => p.status), ['missing_doi','pending','success']);
  assert.equal(result.state.papers[1].lastFailure.reasonCode, 'not_found');
});

test('repeated idle dashboard reads do not save state or trigger a storage refresh loop', async () => {
  const f = await make([paper(1)]);
  const before = f.calls.storageWrites;
  await stateOf(f);
  await stateOf(f);
  await stateOf(f);
  assert.equal(f.calls.storageWrites, before);
});

test('three consecutive connection failures retain reasons and continue to the next pending record', async () => {
  const failure = { kind: 'connection_error', message: 'Server unavailable' };
  const f = await make([paper(1), paper(2), paper(3), paper(4)], {
    '10.1234/paper-1': failure, '10.1234/paper-2': failure, '10.1234/paper-3': failure,
  });
  await f.send({ type: 'START', limit: 0, settings });
  const state = await driveUntil(f, s => s.papers[3].status === 'downloading', 'next record after connection failures');
  assert.deepEqual(state.papers.map(p => p.status), ['failed','failed','failed','downloading']);
  assert.equal(state.consecutiveConnectionFailures, 3);
  assert.equal(f.calls.downloads.length, 1);
});
