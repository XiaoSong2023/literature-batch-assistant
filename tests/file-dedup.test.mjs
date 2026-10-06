import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {scanDuplicatePdfs, deleteDuplicatePdfs, MAX_DEDUP_FILE_BYTES} from '../extension/file-dedup.js';

const pdf = '%PDF-1.7\n1 0 obj <</Type/Catalog>> endobj\n%%EOF\n';
const otherPdf = pdf.replace('Catalog', 'Changed'); // Same size, different contents.
const digest = text => createHash('sha256').update(text).digest('hex');

// No real user files are read or removed. This implements the browser handle
// contract and allows content/permission changes between scan and deletion.
function directory(entries = {}) {
  const data = new Map(Object.entries(entries).map(([name, value]) => [name,
    typeof value === 'string' ? {text: value, modified: 1} : value]));
  return {
    kind: 'directory', name: 'test-only', data, removed: [], reads: new Map(),
    async *entries() {
      if (this.listError) throw this.listError;
      for (const [name, value] of data) yield [name, {kind: value.kind || 'file', name}];
    },
    async getFileHandle(name, options) {
      assert.equal(options, undefined, 'must never create an original');
      const dir = this;
      if (!data.has(name)) throw new DOMException('gone', 'NotFoundError');
      if (data.get(name).kind === 'directory') throw new DOMException('folder', 'TypeMismatchError');
      return {kind: 'file', name, async getFile() {
        dir.reads.set(name, (dir.reads.get(name) || 0) + 1);
        dir.onGetFile?.(name, dir.reads.get(name));
        const value = data.get(name);
        if (!value) throw new DOMException('gone', 'NotFoundError');
        if (value.error) throw value.error;
        if (value.fakeFile) return value.fakeFile;
        return new File([value.text], name, {lastModified: value.modified || 1});
      }};
    },
    async removeEntry(name, options) {
      assert.equal(options, undefined, 'must never recurse');
      if (this.removeError) throw this.removeError;
      assert.equal(data.get(name)?.kind, undefined, 'must never remove a folder');
      assert.ok(data.has(name));
      this.removed.push(name);
      data.delete(name);
    },
  };
}

test('scan is read-only and finds exact SHA-256 duplicates with numbered suffixes', async () => {
  const dir = directory({'paper.pdf': pdf, 'paper (1).pdf': pdf, 'paper(2).PDF': pdf,
    'paper (3) (1).pdf': pdf, 'other.pdf': pdf, 'notes.txt': 'notes',
    'folder (1).pdf': {kind: 'directory'}, 'paper (4).pdf.crdownload': pdf});
  const result = await scanDuplicatePdfs(dir);
  assert.equal(result.scanned, 5);
  assert.equal(result.numberedCopies, 3);
  assert.equal(result.candidates.length, 3);
  assert.equal(result.ignoredFiles, 2);
  assert.equal(result.ignoredDirectories, 1);
  assert.equal(result.totalBytes, pdf.length * 3);
  assert.deepEqual(dir.removed, []);
  for (const c of result.candidates) assert.deepEqual({...c, name: ''},
    {name: '', originalName: 'paper.pdf', hash: digest(pdf), size: pdf.length});
  assert.doesNotThrow(() => JSON.stringify(result));
});

test('different content of the same size, orphan copies, empty and HTML files are retained', async () => {
  const dir = directory({'paper.pdf': pdf, 'paper (1).pdf': otherPdf,
    'orphan (1).pdf': pdf, 'empty.pdf': '', 'empty (1).pdf': '',
    'html.pdf': '<html>oops</html>', 'html (1).pdf': '<html>oops</html>'});
  const result = await scanDuplicatePdfs(dir);
  assert.equal(result.candidates.length, 0);
  assert.deepEqual(new Set(result.skipped.map(item => item.code)),
    new Set(['DIFFERENT_CONTENT', 'NO_ORIGINAL', 'EMPTY_FILE', 'NOT_PDF']));
  assert.deepEqual(dir.removed, []);
});

test('case-insensitive matching requires an unambiguous original and copy', async () => {
  const dir = directory({'Paper.PDF': pdf, 'paper (1).pdf': pdf});
  assert.equal((await scanDuplicatePdfs(dir)).candidates[0].originalName, 'Paper.PDF');
  dir.data.set('paper.pdf', {text: pdf});
  assert.equal((await scanDuplicatePdfs(dir)).skipped[0].code, 'AMBIGUOUS_NAME');
  dir.data.delete('paper.pdf');
  dir.data.set('PAPER (1).PDF', {text: pdf});
  assert.equal((await scanDuplicatePdfs(dir)).candidates.length, 0);
});

test('nested numbered copies never become retained originals for a deletion chain', async () => {
  const dir = directory({'paper (1).pdf': pdf, 'paper (1) (1).pdf': pdf, 'paper (0).pdf': pdf});
  const result = await scanDuplicatePdfs(dir);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.skipped.length, 2);
  assert.ok(result.skipped.every(item => item.code === 'NO_ORIGINAL'));
});

test('PDF headers tolerate only leading whitespace and files over the memory cap are retained', async () => {
  const padded = '\n \t' + pdf;
  const dir = directory({'pad.pdf': padded, 'pad (1).pdf': padded,
    'big.pdf': {fakeFile: {size: MAX_DEDUP_FILE_BYTES + 1,
      async arrayBuffer() { assert.fail('oversized file must not be loaded'); }}}, 'big (1).pdf': pdf});
  const result = await scanDuplicatePdfs(dir);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.skipped[0].code, 'TOO_LARGE');
});

test('deletion removes only exact numbered copies and preserves every original', async () => {
  const dir = directory({'paper.pdf': pdf, 'paper (1).pdf': pdf, 'paper (2).pdf': pdf});
  const scan = await scanDuplicatePdfs(dir);
  dir.reads.clear();
  const progress = [];
  const result = await deleteDuplicatePdfs(dir, scan.candidates, {onProgress: p => progress.push(p)});
  assert.equal(result.deleted.length, 2);
  assert.equal(result.bytesFreed, 2 * pdf.length);
  assert.equal(result.skipped.length + result.failed.length, 0);
  assert.deepEqual(Array.from(dir.data.keys()), ['paper.pdf']);
  assert.equal(dir.reads.get('paper.pdf'), 6, 'original re-read, re-hashed and checked for each copy');
  assert.equal(progress.at(-1).completed, 2);
});

test('a copy edited after scan is retained even when its size and lastModified are unchanged', async () => {
  const dir = directory({'paper.pdf': pdf, 'paper (1).pdf': pdf});
  const scan = await scanDuplicatePdfs(dir);
  dir.data.set('paper (1).pdf', {text: otherPdf, modified: 1});
  const result = await deleteDuplicatePdfs(dir, scan.candidates);
  assert.equal(result.skipped[0].code, 'FILE_CHANGED');
  assert.deepEqual(dir.removed, []);
});

test('a replaced original is never used to approve deletion, even with unchanged metadata', async () => {
  const dir = directory({'paper.pdf': pdf, 'paper (1).pdf': pdf});
  const scan = await scanDuplicatePdfs(dir);
  dir.data.set('paper.pdf', {text: otherPdf, modified: 1});
  const result = await deleteDuplicatePdfs(dir, scan.candidates);
  assert.equal(result.skipped[0].code, 'FILE_CHANGED');
  assert.deepEqual(dir.removed, []);
});

test('original disappearance or folder replacement after scan leaves the copy untouched', async () => {
  for (const replacement of [undefined, {kind: 'directory'}]) {
    const dir = directory({'paper.pdf': pdf, 'paper (1).pdf': pdf});
    const scan = await scanDuplicatePdfs(dir);
    if (replacement) dir.data.set('paper.pdf', replacement);
    else dir.data.delete('paper.pdf');
    const result = await deleteDuplicatePdfs(dir, scan.candidates);
    assert.equal(result.skipped.length, 1);
    assert.deepEqual(dir.removed, []);
  }
});

test('content or disappearance detected immediately before removeEntry prevents deletion', async () => {
  for (const change of ['modified', 'removed']) {
    const dir = directory({'paper.pdf': pdf, 'paper (1).pdf': pdf});
    const scan = await scanDuplicatePdfs(dir);
    dir.reads.clear();
    dir.onGetFile = (name, count) => {
      if (name === 'paper.pdf' && count === 3) {
        if (change === 'modified') dir.data.set(name, {text: otherPdf, modified: 2});
        else dir.data.delete(name);
      }
    };
    const result = await deleteDuplicatePdfs(dir, scan.candidates);
    assert.equal(result.skipped.length, 1);
    assert.deepEqual(dir.removed, []);
  }
});

test('unsafe names, non-copies, forged relationships, invalid hashes and duplicates cannot be removed', async () => {
  const dir = directory({'paper.pdf': pdf, 'paper (1).pdf': pdf, 'other.pdf': pdf});
  const [good] = (await scanDuplicatePdfs(dir)).candidates;
  const bad = [null, {...good, name: '../paper (1).pdf'}, {...good, name: 'x\\paper (1).pdf'},
    {...good, name: 'C:paper (1).pdf'}, {...good, originalName: '../paper.pdf'},
    {...good, name: 'paper.pdf'}, {...good, originalName: 'other.pdf'},
    {...good, originalName: 'paper (1).pdf'}, {...good, hash: 'abc'}, {...good, size: 0}];
  const result = await deleteDuplicatePdfs(dir, [...bad, good, good]);
  assert.equal(result.deleted.length, 1);
  assert.equal(result.skipped.length, bad.length + 1);
  assert.equal(result.skipped.at(-1).code, 'DUPLICATE_REQUEST');
  assert.deepEqual(dir.removed, ['paper (1).pdf']);
  assert.ok(dir.data.has('paper.pdf') && dir.data.has('other.pdf'));
});

test('permissions and disk errors are reported as failures without claiming success', async () => {
  for (const error of [new DOMException('denied', 'NotAllowedError'), new Error('disk busy')]) {
    const dir = directory({'paper.pdf': pdf, 'paper (1).pdf': pdf});
    const scan = await scanDuplicatePdfs(dir);
    dir.removeError = error;
    const result = await deleteDuplicatePdfs(dir, scan.candidates);
    assert.equal(result.deleted.length, 0);
    assert.equal(result.bytesFreed, 0);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].code, error.name);
    assert.deepEqual(dir.removed, []);
  }
});

test('read errors are recorded per file; directory enumeration errors propagate', async () => {
  const dir = directory({'paper.pdf': pdf, 'paper (1).pdf': {error: new DOMException('locked', 'NotReadableError')}});
  const result = await scanDuplicatePdfs(dir);
  assert.equal(result.skipped[0].code, 'NotReadableError');
  dir.listError = new DOMException('denied', 'NotAllowedError');
  await assert.rejects(scanDuplicatePdfs(dir), {name: 'NotAllowedError'});
});

test('an aborted scan returns its partial snapshot on AbortError and never removes files', async () => {
  const dir = directory({'paper.pdf': pdf, 'paper (1).pdf': pdf});
  const controller = new AbortController();
  await assert.rejects(scanDuplicatePdfs(dir, {signal: controller.signal,
    onProgress: p => { if (p.phase === 'hashing') controller.abort(); }}), error => {
    assert.equal(error.name, 'AbortError');
    assert.deepEqual(error.result.candidates, []);
    return true;
  });
  assert.deepEqual(dir.removed, []);
});

test('deletion cancellation before removal is respected and reports partial deletions accurately', async () => {
  const dir = directory({'paper.pdf': pdf, 'paper (1).pdf': pdf, 'paper (2).pdf': pdf});
  const scan = await scanDuplicatePdfs(dir);
  const controller = new AbortController();
  await assert.rejects(deleteDuplicatePdfs(dir, scan.candidates, {signal: controller.signal,
    onProgress: p => { if (p.phase === 'deleting' && p.completed === 1) controller.abort(); }}), error => {
    assert.equal(error.name, 'AbortError');
    assert.equal(error.result.deleted.length, 1);
    assert.equal(error.result.bytesFreed, pdf.length);
    return true;
  });
  assert.equal(dir.removed.length, 1);
  assert.ok(dir.data.has('paper.pdf'));
  const remaining = await scanDuplicatePdfs(dir);
  assert.equal((await deleteDuplicatePdfs(dir, remaining.candidates)).deleted.length, 1);
});

test('abort during final recheck prevents delete and concurrent cleanup is rejected', async () => {
  const dir = directory({'paper.pdf': pdf, 'paper (1).pdf': pdf});
  const scan = await scanDuplicatePdfs(dir);
  const controller = new AbortController();
  dir.reads.clear();
  dir.onGetFile = (name, count) => { if (name === 'paper (1).pdf' && count === 3) controller.abort(); };
  await assert.rejects(deleteDuplicatePdfs(dir, scan.candidates, {signal: controller.signal}), {name: 'AbortError'});
  assert.deepEqual(dir.removed, []);
  delete dir.onGetFile;
  const first = deleteDuplicatePdfs(dir, scan.candidates);
  await assert.rejects(deleteDuplicatePdfs(dir, scan.candidates), /正在清理/);
  assert.equal((await first).deleted.length, 1);
});

test('invalid directory handles are rejected before reading or deleting', async () => {
  await assert.rejects(scanDuplicatePdfs(null), /选择本地/);
  await assert.rejects(deleteDuplicatePdfs(directory(), null), /先扫描/);
});
