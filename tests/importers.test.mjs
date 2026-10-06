import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseBibliography} from '../extension/importers.js';

const fixture = async name => readFile(new URL(`fixtures/${name}`, import.meta.url), 'utf8');

test('RIS handles UTF-8, titles, wrapping, exact punctuation and final record without ER', async () => {
  const result = parseBibliography('\uFEFF' + (await fixture('import-mixed.ris')).replace(/\n/g, '\r\n'), 'export.txt');
  assert.equal(result.format, 'RIS');
  assert.equal(result.papers[0].title, 'β-Catenin in 肿瘤: A Multicentre Study');
  assert.equal(result.papers[0].doi, '10.1002/(SICI)1097-0258(19981230)17:24<2747::AID-SIM953>3.0.CO;2-A');
  assert.equal(result.papers[1].doi, '');
  assert.equal(result.papers[2].doi, '10.1234/very-long-suffix-2026');
  assert.equal(result.papers[3].doi, '10.1234/first');
  assert.match(result.papers[3].sourceStatus, /多个不同 DOI/);
  assert.equal(result.papers[4].title, 'Last Record Lacking ER');
  assert.ok(result.warnings.some(warning => /ER/.test(warning)));
  assert.deepEqual(result.stats, {total: 5, withDoi: 4, missingDoi: 1, uniqueDoi: 3, duplicateDoiRecords: 1, withPdfUrl: 0, eligible: 4, missingDownloadTarget: 1});
  assert.deepEqual(result.papers.map(p => p.sourceIndex), ['1', '2', '3', '4', '5']);
  assert.equal(new Set(result.papers.map(p => p.id)).size, 5);
});

test('RIS title/abstract/notes are never used as DOI sources; next TY recovers a missing ER', () => {
  const result = parseBibliography('TY  - JOUR\nTI  - Title 10.1234/cited\nAB  - 10.1234/reference\nN1  - DOI: 10.1234/notes\nTY  - JOUR\nT1  - Next\nDO  - doi: 10.1234/correct\nER  -', 'sample.ris');
  assert.equal(result.papers.length, 2);
  assert.equal(result.papers[0].doi, '');
  assert.equal(result.papers[1].doi, '10.1234/correct');
  assert.match(result.warnings[0], /第 1 行.*ER/);
});

test('PubMed/NBIB recognizes TI and [doi] AID/LID only, excluding PMID/pii/AB', async () => {
  const result = parseBibliography(await fixture('import-pubmed.nbib'), 'pubmed.txt');
  assert.equal(result.format, 'PubMed/NBIB');
  assert.equal(result.papers[0].title, 'The Role of DOI Metadata in a Multicentre Randomised Study.');
  assert.equal(result.papers[0].doi, '10.1000/ABC.2026');
  assert.equal(result.papers[1].doi, '');
  assert.equal(result.papers[2].doi, '10.1000/abc.2026');
  assert.deepEqual(result.stats, {total: 3, withDoi: 2, missingDoi: 1, uniqueDoi: 1, duplicateDoiRecords: 1, withPdfUrl: 0, eligible: 2, missingDownloadTarget: 1});
  assert.deepEqual(result.warnings, []);
});

test('PubMed records remain separate when the blank separator is absent', () => {
  const result = parseBibliography('PMID- 1234\nTI  - First\nAID - 10.1234/one [doi]\nPMID- 5678\nTI  - Second\nLID - 10.1234/two [doi]', 'x.nbib');
  assert.equal(result.papers.length, 2);
  assert.equal(result.papers[1].doi, '10.1234/two');
});

test('CSV reads escaped quotes, embedded commas, multiline cells and Chinese headers', () => {
  const text = '\uFEFF原编号,题目,DOI,原始标注\r\n9,"A \"\"Quoted\"\" title,\r\nwith continuation",https://doi.org/10.1234%2FABC,核对过\r\n10,没有 DOI,,待核对';
  const result = parseBibliography(text, 'sample.csv');
  assert.equal(result.format, 'CSV');
  assert.equal(result.papers[0].title, 'A "Quoted" title, with continuation');
  assert.equal(result.papers[0].sourceIndex, '9');
  assert.equal(result.papers[0].doi, '10.1234/ABC');
  assert.equal(result.papers[0].sourceStatus, '核对过');
  assert.equal(result.papers[1].doi, '');
  assert.equal(result.stats.missingDoi, 1);
});

test('CSV supports PubMed title/DOI headings and does not extract from abstract', () => {
  const result = parseBibliography('PMID,Title,DOI,Abstract\n123,"Trial",,"Reference 10.1234/abc"\n456,Second,10.1234/actual,Text', 'pubmed.csv');
  assert.equal(result.papers.length, 2);
  assert.equal(result.papers[0].doi, '');
  assert.equal(result.papers[1].doi, '10.1234/actual');
});

test('CSV extension retains comma parsing when a quoted title contains a tab', () => {
  const result = parseBibliography('title,doi\n"Title\twith tab",10.1234/actual', 'pubmed.csv');
  assert.equal(result.format, 'CSV');
  assert.equal(result.papers[0].title, 'Title with tab');
  assert.equal(result.papers[0].doi, '10.1234/actual');
});

test('TSV supports quoted multiline titles and reports original row source index', () => {
  const result = parseBibliography('sourceIndex\ttitle\tdoi\n42\t"An embedded\ntitle"\t10.1234/abc\n43\tOther\t', 'example.tsv');
  assert.equal(result.format, 'TSV');
  assert.equal(result.papers[0].title, 'An embedded title');
  assert.equal(result.papers[0].sourceIndex, '42');
  assert.equal(result.papers.length, 2);
});

test('malformed CSV stops import with actionable line errors instead of misaligned DOI/title', () => {
  assert.throws(() => parseBibliography('title,doi\n"Broken title,10.1234/abc', 'x.csv'), /第 2 行.*引号未关闭/);
  assert.throws(() => parseBibliography('title,doi\nA,B,10.1234/abc', 'x.csv'), /第 2 行.*列数/);
  assert.throws(() => parseBibliography('title,doi\n"Title"bad,10.1234/abc', 'x.csv'), /第 2 行.*额外字符/);
});

test('headerless two-column TSV title + DOI works and preserves title case', () => {
  const result = parseBibliography('My mRNA Study\t10.1234/ABC\n10.1234/other\tNext Article', 'x.txt');
  assert.equal(result.papers[0].title, 'My mRNA Study');
  assert.equal(result.papers[1].title, 'Next Article');
  assert.equal(result.papers[1].doi, '10.1234/other');
});

test('JSON accepts exported/bundled papers objects and arrays; processing states are never resumed', () => {
  const input = [{id: 'old', sourceIndex: '27', title: 'Title', doi: '10.1234/one', status: 'success'}, {title: 'Missing', doi: '', sourceStatus: '原始待核对'}];
  const bundled = parseBibliography(JSON.stringify({papers: input, running: true}), 'backup.json');
  const array = parseBibliography(JSON.stringify(input), 'backup.txt');
  assert.deepEqual(bundled.stats, array.stats);
  assert.equal(bundled.papers[0].sourceIndex, '27');
  assert.equal(bundled.papers[0].status, undefined);
  assert.notEqual(bundled.papers[0].id, 'old');
  assert.match(bundled.papers[1].sourceStatus, /原始待核对.*缺少/);
});

test('JSON CSL-style title/DOI keys and arrays are accepted, malformed records are rejected', () => {
  const result = parseBibliography(JSON.stringify([{title: ['A Title'], DOI: '10.1234/doi', URL: 'https://publisher.example/10.1234/reference'}]), 'csl.json');
  assert.equal(result.papers[0].doi, '10.1234/doi');
  assert.throws(() => parseBibliography('[{"title":{},"doi":"10.1234/abc"}]', 'x.json'), /title.*文本/);
  assert.throws(() => parseBibliography('[{"abstract":"10.1234/abc"}]', 'x.json'), /没有可识别/);
  assert.throws(() => parseBibliography('{"papers":[null]}', 'x.json'), /第 1 条/);
});

test('different DOI fields and multi-DOI fields are warned, punctuation is not destructively stripped', () => {
  const result = parseBibliography(JSON.stringify([
    {title: 'Conflict', doi: '10.1234/one; 10.1234/two'},
    {title: 'Punctuation', doi: '10.1002/(SICI)12<99::AID-A>3.0.CO;2-X'},
    {title: 'Period', doi: '10.1234/trailing-period.'},
  ]), 'x.json');
  assert.equal(result.papers[0].doi, '10.1234/one');
  assert.match(result.warnings[0], /多个不同 DOI/);
  assert.equal(result.papers[1].doi, '10.1002/(SICI)12<99::AID-A>3.0.CO;2-X');
  assert.equal(result.papers[2].doi, '10.1234/trailing-period.');
});

test('TXT accepts only standalone DOIs/DOI URLs and reports invalid line numbers', () => {
  const result = parseBibliography('10.1234/ABC\r\nhttps://doi.org/10.1234%2Fdef\r\nThis paper cites 10.1234/no\r\n12345678\r\ndoi: 10.1234/ghi', 'dois.txt');
  assert.equal(result.format, 'TXT');
  assert.equal(result.papers.length, 3);
  assert.equal(result.papers[1].doi, '10.1234/def');
  assert.match(result.warnings[0], /第 3 行/);
  assert.match(result.warnings[1], /第 4 行/);
  assert.throws(() => parseBibliography('A long abstract\ncontaining 10.1234/not-a-list\nPMID 12345678', 'abstract.txt'), /未识别到/);
});

test('empty, binary/UTF16, XML and unsupported JSON structures have clear errors', () => {
  assert.throws(() => parseBibliography(' \r\n ', 'x.txt'), /文件为空/);
  assert.throws(() => parseBibliography('t\u0000i\u0000', 'x.txt'), /UTF-16/);
  assert.throws(() => parseBibliography('<PubmedArticleSet/>', 'x.xml'), /不支持 XML/);
  assert.throws(() => parseBibliography('{"title":"only object"}', 'x.json'), /数组/);
});

test('thousands of tagged records preserve all missing DOI records and duplicate counts', () => {
  const count = 5000;
  const text = Array.from({length: count}, (_, i) => `TY  - JOUR\nTI  - Article ${i}\n${i % 5 ? `DO  - 10.1234/${i % 100}\n` : ''}ER  -`).join('\n\n');
  const result = parseBibliography(text, 'bulk.ris');
  assert.equal(result.stats.total, count);
  assert.equal(result.stats.missingDoi, 1000);
  assert.equal(result.stats.withDoi, 4000);
  assert.equal(result.stats.uniqueDoi, 80);
  assert.equal(result.stats.duplicateDoiRecords, 3920);
  assert.equal(result.papers.at(-1).sourceIndex, '5000');
});
