import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDoi, normalizePapers, sanitizeFilename, verifyDownload, matchDownloadIntent } from '../extension/core.js';

test('DOI links normalize, invalid/missing DOI remain actionable report records', () => {
  assert.equal(normalizeDoi(' https://doi.org/10.1234%2FExample.1 '), '10.1234/Example.1');
  assert.equal(normalizeDoi('DOI: 10.1234/example'), '10.1234/example');
  assert.equal(normalizeDoi('some title'), '');
  const papers = normalizePapers([{ title: 'No DOI', doi: '' }, { title: 'Valid title', doi: '10.1234/a' }]);
  assert.equal(papers[0].status, 'missing_doi');
  assert.equal(papers[0].title, 'No DOI');
  assert.equal(papers[1].status, 'pending');
});

test('identical source identifiers get unique queue IDs and safe Windows paths', () => {
  const papers = normalizePapers([
    { id: 'same', sourceIndex: 1, title: '../CON: a/b\\c?*', doi: '10.1234/a' },
    { id: 'same', sourceIndex: 2, title: 'second', doi: '10.1234/b' },
  ]);
  assert.equal(new Set(papers.map(p => p.id)).size, 2);
  const filename = sanitizeFilename(papers[0]);
  assert.match(filename, /^LiteratureBatch\/0001_/);
  assert.equal(filename.split('/').length, 2);
  assert.doesNotMatch(filename.split('/')[1], /[<>:"\\|?*]/);
  assert.doesNotMatch(filename, /\.\./);
});

test('download success requires completed PDF, sufficient size, and an existing file', () => {
  const valid = { state: 'complete', mime: 'application/pdf', fileSize: 2048, exists: true };
  assert.equal(verifyDownload(valid).ok, true);
  assert.equal(verifyDownload({ ...valid, state: 'in_progress' }).ok, false);
  assert.equal(verifyDownload({ ...valid, mime: 'text/html' }).ok, false);
  assert.equal(verifyDownload({ ...valid, mime: '' }).ok, false);
  assert.equal(verifyDownload({ ...valid, fileSize: 12 }).ok, false);
  assert.equal(verifyDownload({ ...valid, exists: false }).ok, false);
  assert.equal(verifyDownload(null).ok, false);
});

test('crash recovery binds download intent by extension, URL, and timestamp', () => {
  const paper = { downloadUrl: 'https://fixture.example/paper.pdf', downloadIntentAt: Date.parse('2026-10-05T12:00:00Z') };
  const item = { byExtensionId: 'extension', url: paper.downloadUrl, startTime: '2026-10-05T12:00:01Z' };
  assert.equal(matchDownloadIntent(item, paper, 'extension'), true);
  assert.equal(matchDownloadIntent({ ...item, byExtensionId: 'other' }, paper, 'extension'), false);
  assert.equal(matchDownloadIntent({ ...item, url: 'https://other.example/paper.pdf' }, paper, 'extension'), false);
  assert.equal(matchDownloadIntent({ ...item, startTime: '2026-10-04T12:00:00Z' }, paper, 'extension'), false);
});
