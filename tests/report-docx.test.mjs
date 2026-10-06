import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync, mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {createUnobtainedDocx} from '../extension/report-docx.js';

const OPTIONS = {sourceName: '中英文文献导出样本', exportedAt: '2026-10-06T09:08:07Z'};
const SAMPLE = [
  {sourceIndex: '0012', title: '老年人口腔健康与生活质量的纵向研究 Chinese and English title <A&B>', doi: '10.1234/example.2026', pdfUrl: 'https://example.org/articles/paper.pdf?download=1&source=archive', landingUrl: 'https://example.org/article/12', status: 'failed', reason: '网页未检索到全文。\n需核对 DOI 后重试；保留原编号。'},
  {sourceIndex: '0042', title: 'A longitudinal investigation of oral health and dental treatment in children living in multiple communities over ten years', doi: '10.9999/long-title', pdfUrl: 'https://example.org/archive/' + 'abcdefghijklmnopqrstuvwxyz0123456789'.repeat(6) + '/research.pdf?token=ABCdef%2F123&source=author', landingUrl: 'https://example.org/论文/儿童口腔健康?year=2026&lang=zh', status: 'pending', reason: ''},
  {sourceIndex: '0219', title: '未提供 DOI 但保留全文网页入口的研究', doi: '', pdfUrl: '', landingUrl: 'https://example.org/login/article/219', status: 'missing_doi', reason: '只有出版社网页入口；请人工打开查看是否有权限下载。'},
  {sourceIndex: '1024', title: '正在下载的研究 Download still in progress', doi: '10.6789/study', pdfUrl: '', landingUrl: '', status: 'downloading', reason: ''},
  {sourceIndex: '2174', title: '已完成记录不得出现在报告中 SUCCESS_SENTINEL', doi: '10.1234/completed', status: 'success'},
];

// Parse the ZIP central directory independently, then check its local entries.
function unzip(bytes) {
  assert.ok(bytes instanceof Uint8Array);
  const buffer = Buffer.from(bytes);
  const end = buffer.length - 22;
  assert.equal(buffer.readUInt32LE(end), 0x06054b50);
  assert.equal(buffer.readUInt16LE(end + 4), 0);
  assert.equal(buffer.readUInt16LE(end + 6), 0);
  const count = buffer.readUInt16LE(end + 10);
  const centralStart = buffer.readUInt32LE(end + 16);
  assert.equal(centralStart + buffer.readUInt32LE(end + 12), end);
  const files = new Map();
  let offset = centralStart;
  for (let i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const start = buffer.readUInt32LE(offset + 42);
    const size = buffer.readUInt32LE(offset + 24);
    assert.equal(buffer.readUInt32LE(start), 0x04034b50);
    assert.equal(buffer.readUInt16LE(start + 8), 0, 'STORE compression');
    assert.equal(buffer.readUInt16LE(start + 6), 0x800, 'UTF-8 flag');
    assert.equal(buffer.readUInt32LE(start + 18), size);
    const dataStart = start + 30 + buffer.readUInt16LE(start + 26) + buffer.readUInt16LE(start + 28);
    const data = buffer.subarray(dataStart, dataStart + size);
    let crc = -1;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    assert.equal((crc ^ -1) >>> 0, buffer.readUInt32LE(offset + 16), name + ' CRC');
    assert.equal(buffer.readUInt32LE(start + 14), buffer.readUInt32LE(offset + 16));
    assert.ok(!files.has(name));
    files.set(name, data.toString('utf8'));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(offset, end);
  return files;
}

test('exports a genuine OOXML ZIP with all unresolved records and accurate status counts', () => {
  const input = structuredClone(SAMPLE);
  const files = unzip(createUnobtainedDocx(input, OPTIONS));
  assert.deepEqual(input, SAMPLE, 'export must not change queue records');
  const doc = files.get('word/document.xml');
  assert.ok(files.has('[Content_Types].xml'));
  assert.ok(files.has('_rels/.rels'));
  assert.ok(files.has('word/styles.xml'));
  assert.ok(files.has('word/footer1.xml'));
  assert.match(doc, /未获取全文 4 条；尝试后失败 1 条；尚未处理 1 条；缺少下载入口 1 条；处理中 1 条/);
  assert.doesNotMatch(doc, /SUCCESS_SENTINEL|10\.1234\/completed|原编号 2174/);
  for (const index of ['0012', '0042', '0219', '1024']) assert.ok(doc.includes('原编号 ' + index));
  assert.match(doc, /2026-10-06 09:08:07 UTC/);
  assert.match(doc, /正在下载/);
  assert.match(doc, /仍在下载，结果尚未确定/);
  assert.match(doc, /未提供/);
  assert.match(doc, /w:pgSz w:w="11906" w:h="16838"/);
  assert.match(files.get('word/styles.xml'), /w:eastAsia="宋体"/);
});

test('escapes imported XML and preserves Unicode, newlines, and full signed URLs safely', () => {
  const url = 'https://example.org/Paper%2FPart.PDF?Token=AbC%2bDEF&name=%E4%B8%AD%E6%96%87';
  const files = unzip(createUnobtainedDocx([{sourceIndex: '<3>', title: '<w:evil/> & "quoted"\u0001中文𝛼\ud800', doi: '10.1234/<A&B>', pdfUrl: url, landingUrl: 'javascript:alert(1)', status: 'failed', reason: 'line1\r\nline2\ttab <&>'}], OPTIONS));
  const doc = files.get('word/document.xml');
  const rels = files.get('word/_rels/document.xml.rels');
  assert.match(doc, /&lt;w:evil\/&gt; &amp; &quot;quoted&quot;中文𝛼�/);
  assert.doesNotMatch(doc, /<w:evil|\u0001/);
  assert.match(doc, /<w:br\/>/);
  assert.match(doc, /<w:tab\/>/);
  assert.ok(rels.includes(url.replaceAll('&', '&amp;')));
  assert.ok(doc.includes(url.replaceAll('&', '&amp;')));
  assert.doesNotMatch(rels, /javascript:/);
  assert.match(doc, /javascript:alert\(1\)/, 'unusable source remains visible as text');
  assert.match(files.get('word/styles.xml'), /w:wordWrap w:val="0"/, 'long URLs wrap without changing their text');
});

test('empty, successful-only, missing status, and source number fallbacks remain truthful', () => {
  for (const input of [[], [{status: 'success'}]]) {
    const doc = unzip(createUnobtainedDocx(input, OPTIONS)).get('word/document.xml');
    assert.match(doc, /当前没有未获取全文的文献记录/);
    assert.match(doc, /未获取全文 0 条/);
  }
  const doc = unzip(createUnobtainedDocx([{status: 'success'}, {title: 'unknown'}, {status: 'custom_status'}], OPTIONS)).get('word/document.xml');
  assert.match(doc, /原编号 2/);
  assert.match(doc, /原编号 3/);
  assert.match(doc, /其他状态 2 条/);
  assert.match(doc, /custom_status/);
  assert.match(doc, /未记录状态/);
});

test('several thousand records export without truncation or one huge table', () => {
  const papers = Array.from({length: 5000}, (_, i) => ({sourceIndex: String(i + 1), title: '研究记录 ' + (i + 1), doi: '10.1234/item' + i, status: i % 2 ? 'pending' : 'failed', reason: '示例原因'}));
  const doc = unzip(createUnobtainedDocx(papers, OPTIONS)).get('word/document.xml');
  assert.equal((doc.match(/<w:pStyle w:val="EntryHeading"\/>/g) || []).length, 5000);
  assert.match(doc, /研究记录 5000/);
  assert.doesNotMatch(doc, /<w:tbl/);
  assert.match(doc, /尝试后失败 2500 条；尚未处理 2500 条/);
});

test('rejects malformed inputs and invalid dates before constructing a document', () => {
  for (const input of [null, {}, [null], [false], [[]], new Array(20001).fill({})]) assert.throws(() => createUnobtainedDocx(input), /文献数组/);
  assert.throws(() => createUnobtainedDocx([], {exportedAt: 'invalid'}), /日期无效/);
  assert.throws(() => createUnobtainedDocx([], null), /选项格式/);
});

// Explicitly opt in to writing a small visual-QA fixture; ordinary tests are read-only.
if (process.env.DOCX_SAMPLE_OUTPUT) {
  mkdirSync(dirname(process.env.DOCX_SAMPLE_OUTPUT), {recursive: true});
  writeFileSync(process.env.DOCX_SAMPLE_OUTPUT, createUnobtainedDocx(SAMPLE, OPTIONS));
}
