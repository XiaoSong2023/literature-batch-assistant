import test from 'node:test';
import assert from 'node:assert/strict';
import {createInitialState} from '../extension/core.js';
import {createChromeFixture} from './chrome-fixture.mjs';

const entry = (id, extra = {}) => ({id, title: `Paper ${id}`, doi: `10.1234/${id}`, ...extra});
async function fixture(extra = {}, activeStatus = 'searching') {
  const saved = createInitialState({papers: [entry('complete'), entry('old-search')]});
  Object.assign(saved.papers[0], {status: 'success', filename: 'saved.pdf', downloadId: 17});
  Object.assign(saved.papers[1], {status: activeStatus});
  Object.assign(saved, {running: false, activeId: 'old-search', pauseKind: 'tab_closed', phase: 'result', ...extra});
  return createChromeFixture({persisted: {literatureBatchState: saved}, session: {literatureBatchSession: 1}});
}

test('paused search can be replaced by a missing-only import while retaining completed history', async () => {
  const f = await fixture();
  const result = await f.send({type: 'IMPORT', papers: [entry('new-missing')], sourceName: 'Missing only.csv'});
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.state.papers.map(p => p.id), ['new-missing']);
  assert.equal(result.state.activeId, null);
  assert.equal(result.state.running, false);
  assert.equal(result.state.completedPapers[0].filename, 'saved.pdf');
  assert.deepEqual(f.calls.cancelled, []);
  assert.equal(f.calls.downloads.length, 0);
  await f.advance(60000);
  assert.deepEqual((await f.send({type:'GET_STATE'})).state.papers.map(p=>p.id), ['new-missing']);
  assert.equal(f.calls.downloads.length, 0, 'Old timers must not restart the old queue');
});

test('paused invalid import leaves the previous search and success records intact', async () => {
  const f = await fixture();
  const before = (await f.send({type: 'GET_STATE'})).state;
  assert.equal((await f.send({type: 'IMPORT', papers: []})).ok, false);
  const after = (await f.send({type: 'GET_STATE'})).state;
  assert.deepEqual(after.papers, before.papers);
  assert.equal(after.activeId, before.activeId);
});

test('running, verification-waiting and unfinished downloads still block replacement', async () => {
  for (const [extra, status] of [[{running:true},'searching'], [{waitingForVerification:true},'searching'], [{},'downloading'], [{activeId:null},'downloading']]) {
    const f = await fixture(extra, status);
    const result = await f.send({type:'IMPORT', papers:[entry('new-missing')]});
    assert.equal(result.ok, false, JSON.stringify({extra,status}));
    assert.deepEqual(f.calls.cancelled, []);
    assert.equal(f.calls.downloads.length, 0);
  }
});
