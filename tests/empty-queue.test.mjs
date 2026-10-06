import test from 'node:test';
import assert from 'node:assert/strict';
import {createChromeFixture} from './chrome-fixture.mjs';
import {createInitialState} from '../extension/core.js';

const stateOf = async f => (await f.send({type: 'GET_STATE'})).state;

test('a build without a bundled list starts with an empty, usable queue', async () => {
  const f = await createChromeFixture({bundle: {papers: []}});
  const state = await stateOf(f);
  assert.deepEqual(state.papers, []);
  assert.equal(state.running, false);
  assert.equal(state.startFromNumber, 1);
  const started = await f.send({type: 'START', limit: 0});
  assert.equal(started.ok, true, started.error);
  await f.advance(1000);
  const after = await stateOf(f);
  assert.equal(after.running, false, 'Nothing to process ends the run immediately');
  assert.equal(f.calls.navigation.length, 0, 'An empty queue never opens a search tab');
  assert.equal(f.calls.downloads.length, 0);
});

test('an empty queue accepts the first import', async () => {
  const f = await createChromeFixture({bundle: {papers: []}});
  const imported = await f.send({type: 'IMPORT', sourceName: 'first.ris', papers: [{title: 'First paper', doi: '10.5555/first'}]});
  assert.equal(imported.ok, true, imported.error);
  assert.equal(imported.state.papers.length, 1);
  assert.equal(imported.state.papers[0].status, 'pending');
});

test('createInitialState tolerates an empty bundle but imports still require records', async () => {
  assert.deepEqual(createInitialState({papers: []}).papers, []);
  assert.deepEqual(createInitialState({}).papers, []);
  const f = await createChromeFixture({bundle: {papers: []}});
  const rejected = await f.send({type: 'IMPORT', papers: []});
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /1–20000/);
});
