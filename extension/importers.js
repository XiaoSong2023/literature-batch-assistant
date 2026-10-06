// Text-only bibliography import: no requests and no execution of imported content.
// PubMed fields: https://pubmed.ncbi.nlm.nih.gov/help/#pubmed-format
// RIS tags/continuations: Thomson Reuters ResearchSoft, Direct Export (May 2009),
// https://www.knime.com/sites/default/files/direct_export_ris_documentation_0.pdf

import {normalizeHttpUrl} from './core.js';

const DOI_URL = /^https?:\/\/(?:dx\.)?doi\.org\//i;
const DOI = /^10\.\d{4,9}(?:\.\d+)*\/[^\s\u0000-\u001f\u007f]+$/i;
const RIS_TAG = /^([A-Z][A-Z0-9])\s{1,4}-\s?(.*)$/;
const MEDLINE_TAG = /^([A-Z][A-Z0-9]{1,4})\s{0,4}-\s?(.*)$/;
const cleanTitle = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const headerKey = value => String(value ?? '').trim().toLowerCase().replace(/[\s_\-]/g, '');
const TITLE_HEADERS = new Set(['title', 'articletitle', 'primarytitle', 'documenttitle', 'ti', 't1', '题目', '标题', '论文题目', '文献题目']);
const DOI_HEADERS = new Set(['doi', 'do', 'digitalobjectidentifier', 'doi链接', 'doi号']);
const URL_HEADERS = new Set(['url', 'ur', 'doiurl', 'link']);
const PDF_HEADERS = new Set(['pdfurl', 'fulltexturl', 'url']);
const pdfPriority = key => ['pdfurl', 'fulltexturl', 'url'].indexOf(headerKey(key));
const INDEX_HEADERS = new Set(['sourceindex', 'index', 'number', '序号', '原编号', '编号']);
const STATUS_HEADERS = new Set(['sourcestatus', '原始标注']);

function exactDoi(value) {
  let result = String(value ?? '').trim().replace(/^doi\s*:\s*/i, '');
  if (DOI_URL.test(result)) {
    result = result.replace(DOI_URL, '');
    try { result = decodeURIComponent(result); } catch { /* Keep malformed escapes for validation. */ }
  }
  return DOI.test(result) ? result : '';
}

function makeContext(format, filename) {
  const papers = [], warnings = [];
  const warn = (where, message) => warnings.push(`${where}：${message}`);
  function add({title, candidates = [], pdfCandidates = [], landingUrl = '', sourceIndex, sourceStatus = '', line, issue = ''}) {
    const index = papers.length + 1;
    const where = `第 ${index} 条${line ? `（第 ${line} 行）` : ''}`;
    const values = new Map();
    let invalid = false;
    for (const candidate of candidates) {
      let raw = String(candidate.value ?? '').trim();
      if (!raw) continue;
      if (candidate.urlOnly && !DOI_URL.test(raw)) continue;
      if (candidate.pubmed) {
        // AID/LID also contain pii and other identifiers. Only [doi] is a DOI.
        if (!/\[doi\]\s*$/i.test(raw)) continue;
        raw = raw.replace(/\s*\[doi\]\s*$/i, '');
      }
      // Split only delimiters immediately before another DOI, preserving the
      // semicolons, parentheses and angle brackets used by older DOI suffixes.
      const pieces = raw.split(/\s*[,;]\s*(?=(?:doi\s*:\s*|https?:\/\/(?:dx\.)?doi\.org\/)?10\.\d{4,9}\/)|\s+(?=(?:doi\s*:\s*|https?:\/\/(?:dx\.)?doi\.org\/)?10\.\d{4,9}\/)/i);
      for (const piece of pieces) {
        let doi = exactDoi(piece);
        // Tagged formats allow a long field to wrap at any character.
        if (!doi && candidate.wrapped && pieces.length === 1) doi = exactDoi(piece.replace(/\s+/g, ''));
        if (doi) values.set(doi.toLowerCase(), values.get(doi.toLowerCase()) || doi);
        else {
          invalid = true;
          warn(candidate.line ? `第 ${candidate.line} 行` : where, `DOI 字段无效，已保留文献供核对：${piece.slice(0, 160)}`);
        }
      }
    }
    const dois = [...values.values()];
    const notes = [String(sourceStatus).trim(), issue];
    const links = [];
    for (const candidate of pdfCandidates) {
      const raw = String(candidate.value ?? '').trim();
      if (!raw || DOI_URL.test(raw)) continue;
      const url = normalizeHttpUrl(raw);
      if (url) { if (!links.includes(url)) links.push(url); }
      else { warn(where, `PDF 直链字段无效，须为不含账号密码的 HTTP(S) 链接：${raw.slice(0, 160)}`); notes.push('含无效 PDF 直链，请核对'); }
    }
    if (links.length > 1) {
      const message = '多个不同 PDF 链接，按 pdfUrl、fullTextUrl、url 顺序暂取第一个；请核对';
      warn(where, message); notes.push(message);
    }
    if (dois.length > 1) {
      const message = `多个不同 DOI，暂取第一个；请核对：${dois.join(' | ')}`;
      warn(where, message);
      notes.push(message);
    }
    if (invalid) notes.push('含无效 DOI 字段，请核对');
    if (!dois.length && !links.length) notes.push('缺少可用 DOI / PDF 直链');
    papers.push({
      id: `import-${index}`,
      sourceIndex: String(sourceIndex || index),
      title: cleanTitle(title) || '未提供标题',
      doi: dois[0] || '',
      pdfUrl: links[0] || '', landingUrl: normalizeHttpUrl(landingUrl),
      sourceStatus: notes.filter(Boolean).join('；'),
      sourceFile: String(filename || ''),
    });
  }
  function finish() {
    if (!papers.length) throw new Error(`未识别到可导入的文献。${warnings[0] || '请使用 RIS、PubMed/NBIB、CSV/TSV、JSON 或每行一个 DOI / PDF 直链的 TXT。'}`);
    const withDoi = papers.filter(paper => paper.doi).length;
    const uniqueDoi = new Set(papers.filter(paper => paper.doi).map(paper => paper.doi.toLowerCase())).size;
    const withPdfUrl = papers.filter(paper => paper.pdfUrl).length;
    const eligible = papers.filter(paper => paper.doi || paper.pdfUrl).length;
    return {format, papers, warnings, stats: {total: papers.length, withDoi, missingDoi: papers.length - withDoi, uniqueDoi, duplicateDoiRecords: withDoi - uniqueDoi, withPdfUrl, eligible, missingDownloadTarget: papers.length - eligible}};
  }
  return {papers, warnings, warn, add, finish};
}

function parseTagged(text, format, filename) {
  const pubmed = format === 'PubMed/NBIB';
  const ctx = makeContext(format, filename);
  let fields = [], current = null, start = 0;
  const flush = (incomplete = false) => {
    if (!fields.length) return;
    const hasContent = fields.some(field => !['TY', 'ER'].includes(field.tag) && field.parts.join('').trim());
    if (!hasContent) {
      ctx.warn(`第 ${start} 行`, '空题录已忽略。');
      fields = []; current = null; return;
    }
    const titleTags = pubmed ? ['TI', 'BTI'] : ['TI', 'T1'];
    const title = titleTags.map(tag => fields.find(field => field.tag === tag)?.parts.join(' ')).find(Boolean);
    const candidates = fields.filter(field => pubmed ? ['AID', 'LID'].includes(field.tag) : ['DO', 'UR'].includes(field.tag))
      .map(field => ({value: field.parts.join(' '), line: field.line, wrapped: field.parts.length > 1, urlOnly: field.tag === 'UR', pubmed}));
    const issue = incomplete ? 'RIS 记录缺少 ER 结束标记，已按下一条或文件结尾收录' : '';
    if (issue) ctx.warn(`第 ${start} 行`, issue);
    const pdfCandidates = pubmed ? [] : fields.filter(field => field.tag === 'L1').map(field => ({value: field.parts.join('')}));
    const landingUrl = pubmed ? '' : fields.filter(field => field.tag === 'UR').map(field => field.parts.join('')).find(value => !DOI_URL.test(value)) || '';
    ctx.add({title, candidates, pdfCandidates, landingUrl, line: start, issue});
    fields = []; current = null;
  };
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) {
      if (pubmed) flush();
      continue;
    }
    const match = line.match(pubmed ? MEDLINE_TAG : RIS_TAG);
    if (match) {
      const [, tag, value] = match;
      if ((pubmed && tag === 'PMID' && fields.some(field => field.tag === 'PMID')) || (!pubmed && tag === 'TY' && fields.length)) flush(!pubmed);
      if (!pubmed && tag === 'ER') { flush(); continue; }
      if (!fields.length) start = index + 1;
      current = {tag, parts: [value.trim()], line: index + 1};
      fields.push(current);
    } else if (current && (!pubmed || /^\s/.test(line))) {
      current.parts.push(line.trim());
    } else {
      ctx.warn(`第 ${index + 1} 行`, '无法识别的题录行已忽略。');
    }
  }
  flush(!pubmed);
  return ctx.finish();
}

// RFC 4180 quoted cells can contain commas, escaped quotes and line breaks.
// https://www.rfc-editor.org/rfc/rfc4180#section-2
function delimitedRows(text, delimiter) {
  const rows = [];
  let row = [], cell = '', quoted = false, closed = false, line = 1, rowLine = 1;
  const pushCell = () => { row.push(cell); cell = ''; closed = false; };
  const pushRow = () => { pushCell(); if (row.some(value => value.trim())) rows.push({cells: row, line: rowLine}); row = []; rowLine = line + 1; };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { cell += '"'; index++; }
        else { quoted = false; closed = true; }
      } else { cell += char; if (char === '\n') line++; }
    } else if (char === delimiter) pushCell();
    else if (char === '\n') { pushRow(); line++; }
    else if (char === '"') {
      if (cell || closed) throw new Error(`第 ${line} 行：引号位置不正确；含引号的单元格须用双引号包围，并将内部引号写成两个双引号。`);
      quoted = true;
    } else if (closed) {
      if (!/[ \t]/.test(char)) throw new Error(`第 ${line} 行：引号关闭后有额外字符。`);
    } else cell += char;
  }
  if (quoted) throw new Error(`第 ${rowLine} 行起：引号未关闭，请检查 CSV/TSV 文件。`);
  if (row.length || cell || closed) pushRow();
  return rows;
}

function parseDelimited(text, delimiter, filename) {
  const format = delimiter === '\t' ? 'TSV' : 'CSV';
  const ctx = makeContext(format, filename);
  const rows = delimitedRows(text, delimiter);
  if (!rows.length) return ctx.finish();
  const headers = rows[0].cells.map(headerKey);
  const titleIndex = headers.findIndex(key => TITLE_HEADERS.has(key));
  const doiIndices = headers.flatMap((key, i) => DOI_HEADERS.has(key) ? [i] : []);
  const urlIndices = headers.flatMap((key, i) => URL_HEADERS.has(key) ? [i] : []);
  const pdfIndices = headers.flatMap((key, i) => PDF_HEADERS.has(key) ? [i] : []).sort((a, b) => pdfPriority(headers[a]) - pdfPriority(headers[b]));
  const indexIndex = headers.findIndex(key => INDEX_HEADERS.has(key));
  const statusIndex = headers.findIndex(key => STATUS_HEADERS.has(key));
  const hasHeader = titleIndex >= 0 || doiIndices.length || urlIndices.length || pdfIndices.length;
  if (!hasHeader) {
    // Headerless lists must identify the DOI without searching arbitrary text.
    for (const row of rows) {
      const valid = row.cells.flatMap((value, index) => exactDoi(value) ? [index] : []);
      if (row.cells.length > 2 || valid.length !== 1) {
        ctx.warn(`第 ${row.line} 行`, '无表头数据应为单个 DOI 或“题目、DOI”两列；本行已忽略。');
        continue;
      }
      const doiIndex = valid[0];
      ctx.add({title: row.cells.length === 2 ? row.cells[1 - doiIndex] : '', candidates: [{value: row.cells[doiIndex], line: row.line}], line: row.line});
    }
    return ctx.finish();
  }
  for (const row of rows.slice(1)) {
    if (row.cells.length !== headers.length) {
      throw new Error(`第 ${row.line} 行：列数为 ${row.cells.length}，表头为 ${headers.length} 列。为避免题目与 DOI 错配，请修正后重新导入。`);
    }
    const candidates = [...doiIndices.map(i => ({value: row.cells[i], line: row.line})), ...urlIndices.map(i => ({value: row.cells[i], line: row.line, urlOnly: true}))];
    const pdfCandidates = pdfIndices.map(i => ({value: row.cells[i], line: row.line}));
    // Explicit PDF fields containing a DOI resolver link still retain its DOI.
    candidates.push(...pdfCandidates.map(candidate => ({...candidate, urlOnly: true})));
    const landingIndex = headers.findIndex(key => ['landingurl', 'ur', 'link'].includes(key));
    ctx.add({title: row.cells[titleIndex], candidates, pdfCandidates, landingUrl: row.cells[landingIndex], sourceIndex: row.cells[indexIndex], sourceStatus: row.cells[statusIndex], line: row.line});
  }
  return ctx.finish();
}

function parseJson(text, filename) {
  let data;
  try { data = JSON.parse(text); } catch (error) { throw new Error(`JSON 格式错误：${error.message}`); }
  const items = Array.isArray(data) ? data : data?.papers ?? data?.records ?? data?.items;
  if (!Array.isArray(items)) throw new Error('JSON 须为文献数组，或包含 papers、records、items 数组的对象。');
  const ctx = makeContext('JSON', filename);
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`JSON 第 ${index + 1} 条须为含 title/doi 字段的对象。`);
    const keys = Object.keys(item);
    const titleKey = keys.find(key => TITLE_HEADERS.has(headerKey(key)));
    const doiKeys = keys.filter(key => DOI_HEADERS.has(headerKey(key)));
    const urlKeys = keys.filter(key => URL_HEADERS.has(headerKey(key)));
    const pdfKeys = keys.filter(key => PDF_HEADERS.has(headerKey(key))).sort((a, b) => pdfPriority(a) - pdfPriority(b));
    if (!titleKey && !doiKeys.length && !urlKeys.length && !pdfKeys.length) throw new Error(`JSON 第 ${index + 1} 条没有可识别的 title、doi 或 PDF 链接字段。`);
    const titleValue = item[titleKey];
    if (titleValue !== undefined && typeof titleValue !== 'string' && !(Array.isArray(titleValue) && titleValue.every(value => typeof value === 'string'))) throw new Error(`JSON 第 ${index + 1} 条的 title 必须是文本。`);
    const candidates = [];
    for (const key of new Set([...doiKeys, ...urlKeys, ...pdfKeys])) {
      const values = Array.isArray(item[key]) ? item[key] : [item[key]];
      for (const value of values) {
        if (value != null && typeof value !== 'string') throw new Error(`JSON 第 ${index + 1} 条的 ${key} 必须是文本。`);
        candidates.push({value, urlOnly: !doiKeys.includes(key)});
      }
    }
    const pdfCandidates = pdfKeys.flatMap(key => (Array.isArray(item[key]) ? item[key] : [item[key]]).map(value => ({value})));
    const indexKey = keys.find(key => INDEX_HEADERS.has(headerKey(key)));
    const landingKey = keys.find(key => ['landingurl', 'ur', 'link'].includes(headerKey(key)));
    ctx.add({title: Array.isArray(titleValue) ? titleValue.join(' ') : titleValue, candidates, pdfCandidates, landingUrl: item[landingKey], sourceIndex: item[indexKey], sourceStatus: item.sourceStatus});
  }
  return ctx.finish();
}

function parsePlain(text, filename) {
  const ctx = makeContext('TXT', filename);
  text.split('\n').forEach((line, index) => {
    if (!line.trim()) return;
    const doi = exactDoi(line);
    if (!doi && !normalizeHttpUrl(line)) {
      ctx.warn(`第 ${index + 1} 行`, '不是单独的 DOI 或 HTTP(S) PDF 直链，已忽略；题录请导出 RIS 或 PubMed 格式。');
      return;
    }
    ctx.add({candidates: doi ? [{value: line, line: index + 1}] : [], pdfCandidates: doi ? [] : [{value: line}], line: index + 1});
  });
  return ctx.finish();
}

function parseOwnReport(text, filename) {
  const ctx = makeContext('插件报告 TXT', filename);
  let item = null;
  const flush = () => {
    if (!item) return;
    const doi = exactDoi(item.doi);
    ctx.add({title: item.title, sourceIndex: item.sourceIndex, sourceStatus: item.reason ? `前次原因：${item.reason}` : '',
      candidates: doi ? [{value: doi}] : [], pdfCandidates: normalizeHttpUrl(item.pdfUrl) ? [{value: item.pdfUrl}] : [],
      landingUrl: item.landingUrl});
  };
  for (const line of text.split('\n')) {
    const match = line.match(/^(原编号|题目|DOI|PDF\s*直链|网页入口（人工打开）|原因)\s*[:：]\s*(.*)$/);
    if (!match) continue;
    if (match[1] === '原编号') { flush(); item = {sourceIndex: match[2]}; continue; }
    if (!item) continue;
    const key = match[1] === '题目' ? 'title' : match[1] === 'DOI' ? 'doi' : /^PDF/.test(match[1]) ? 'pdfUrl' : /^网页入口/.test(match[1]) ? 'landingUrl' : 'reason';
    item[key] = match[2];
  }
  flush();
  return ctx.finish();
}

export function parseBibliography(input, filename = '') {
  if (typeof input !== 'string') throw new Error('导入内容必须为文本。');
  const text = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!text.trim()) throw new Error('文件为空，请选择包含文献记录的文件。');
  if (text.includes('\u0000')) throw new Error('文件含二进制内容或使用 UTF-16 编码，请另存为 UTF-8 文本后导入。');
  const extension = String(filename).toLowerCase().split('.').pop();
  if (/^(?:尚未获取全文的文献清单|尝试后仍未下载成功的文献)/.test(text.trim()) && /^原编号\s*[:：]/m.test(text)) return parseOwnReport(text, filename);
  // Content takes precedence: many databases name RIS/NBIB exports .txt.
  if (/^PMID\s*-\s*\d+/m.test(text)) return parseTagged(text, 'PubMed/NBIB', filename);
  if (/^TY\s{1,4}-/m.test(text)) return parseTagged(text, 'RIS', filename);
  if (/^[\[{]/.test(text.trim()) || extension === 'json') return parseJson(text, filename);
  if (['nbib', 'medline'].includes(extension)) return parseTagged(text, 'PubMed/NBIB', filename);
  if (extension === 'ris') return parseTagged(text, 'RIS', filename);
  if (/^\s*</.test(text)) throw new Error('当前不支持 XML/HTML 题录，请导出 RIS、PubMed/NBIB 或 CSV。');
  if (extension === 'csv') return parseDelimited(text, ',', filename);
  if (text.includes('\t') || extension === 'tsv') return parseDelimited(text, '\t', filename);
  const firstLine = text.split('\n').find(line => line.trim()) || '';
  if (firstLine.includes(',') && firstLine.split(',').some(cell => [...TITLE_HEADERS, ...DOI_HEADERS, ...URL_HEADERS, ...PDF_HEADERS].includes(headerKey(cell.replace(/^"|"$/g, ''))))) return parseDelimited(text, ',', filename);
  return parsePlain(text, filename);
}
