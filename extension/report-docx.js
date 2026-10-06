// Offline Word export: an OOXML package, stored in a standards-compliant ZIP.
// STORE avoids a compression dependency and handles thousands of records in one pass.
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_R = 'http://schemas.openxmlformats.org/package/2006/relationships';
const encoder = new TextEncoder();
const STATUS = Object.freeze({pending: '尚未处理', missing_doi: '缺少下载入口', searching: '正在搜索', downloading: '正在下载', failed: '尝试后失败'});

function cleanText(value) {
  // XML 1.0 excludes control characters and isolated UTF-16 surrogates.
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '\ufffd');
}

function xml(value) {
  return cleanText(value).replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'}[char]));
}

function textRun(value, properties = '') {
  const text = cleanText(value).replace(/\r\n?/g, '\n');
  const body = text.split(/([\n\t])/).map(part => part === '\n' ? '<w:br/>' : part === '\t' ? '<w:tab/>' : `<w:t xml:space="preserve">${xml(part)}</w:t>`).join('');
  return `<w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ''}${body}</w:r>`;
}

function paragraph(content, style = 'Normal', properties = '') {
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/>${properties}</w:pPr>${content}</w:p>`;
}

function safeLink(value) {
  const text = cleanText(value).trim();
  if (!text || /[\s\u007f]/.test(text)) return '';
  try {
    const url = new URL(text);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? text : '';
  } catch { return ''; }
}

const CRC_TABLE = Uint32Array.from({length: 256}, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(files) {
  const entries = Object.entries(files).map(([name, contents]) => ({name: encoder.encode(name), data: encoder.encode(contents)}));
  let length = 22;
  for (const entry of entries) length += 76 + 2 * entry.name.length + entry.data.length;
  if (length >= 0xffffffff) throw new Error('Word 导出文件过大，请分批导出。');
  const output = new Uint8Array(length);
  const view = new DataView(output.buffer);
  let offset = 0;
  const u16 = value => { view.setUint16(offset, value, true); offset += 2; };
  const u32 = value => { view.setUint32(offset, value, true); offset += 4; };
  const bytes = value => { output.set(value, offset); offset += value.length; };
  for (const entry of entries) {
    entry.offset = offset;
    entry.crc = crc32(entry.data);
    u32(0x04034b50); u16(20); u16(0x0800); u16(0); u16(0); u16(0x21);
    u32(entry.crc); u32(entry.data.length); u32(entry.data.length); u16(entry.name.length); u16(0);
    bytes(entry.name); bytes(entry.data);
  }
  const centralOffset = offset;
  for (const entry of entries) {
    u32(0x02014b50); u16(20); u16(20); u16(0x0800); u16(0); u16(0); u16(0x21);
    u32(entry.crc); u32(entry.data.length); u32(entry.data.length); u16(entry.name.length);
    u16(0); u16(0); u16(0); u16(0); u32(0); u32(entry.offset); bytes(entry.name);
  }
  const centralLength = offset - centralOffset;
  u32(0x06054b50); u16(0); u16(0); u16(entries.length); u16(entries.length);
  u32(centralLength); u32(centralOffset); u16(0);
  return output;
}

const STYLES = `${XML}<w:styles xmlns:w="${W}">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="宋体" w:cs="Arial"/><w:color w:val="000000"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:widowControl/><w:spacing w:after="80" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:after="200"/></w:pPr><w:rPr><w:rFonts w:eastAsia="微软雅黑"/><w:b/><w:color w:val="000000"/><w:sz w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Metadata"><w:name w:val="Metadata"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="60"/></w:pPr><w:rPr><w:sz w:val="20"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="EntryHeading"><w:name w:val="Entry Heading"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="220" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:color w:val="000000"/><w:sz w:val="23"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="LinkLine"><w:name w:val="Link Line"/><w:basedOn w:val="Normal"/><w:pPr><w:wordWrap w:val="0"/></w:pPr><w:rPr><w:sz w:val="20"/></w:rPr></w:style>
</w:styles>`;

/**
 * Create a real .docx as Uint8Array; no DOM, Chrome APIs, or network access.
 * options: title, sourceName, exportedAt (Date / ISO string / epoch milliseconds).
 * Only status === 'success' is excluded; other statuses remain visible verbatim.
 */
export function createUnobtainedDocx(papers, options = {}) {
  if (!Array.isArray(papers) || papers.length > 20000 || papers.some(p => !p || typeof p !== 'object' || Array.isArray(p))) {
    throw new Error('Word 导出需要有效文献数组，最多 20000 条。');
  }
  if (!options || typeof options !== 'object') throw new Error('Word 导出选项格式不正确。');
  const exportedAt = new Date(options.exportedAt ?? Date.now());
  if (!Number.isFinite(exportedAt.getTime())) throw new Error('Word 导出日期无效。');
  const timestamp = exportedAt.toISOString();
  const title = cleanText(options.title).trim() || '未获取全文文献清单';
  const sourceName = cleanText(options.sourceName).trim();
  const records = papers.map((paper, index) => ({paper, sourceIndex: cleanText(paper.sourceIndex).trim() || String(index + 1)})).filter(({paper}) => paper.status !== 'success');
  const count = status => records.filter(({paper}) => paper.status === status).length;
  const counts = {failed: count('failed'), pending: count('pending'), missing: count('missing_doi'), active: count('searching') + count('downloading')};
  const other = records.length - counts.failed - counts.pending - counts.missing - counts.active;
  const relationships = [
    `<Relationship Id="rStyles" Type="${R}/styles" Target="styles.xml"/>`,
    `<Relationship Id="rFooter" Type="${R}/footer" Target="footer1.xml"/>`,
  ];
  const links = new Map();
  const linkRun = (text, target) => {
    const url = safeLink(target);
    if (!url) return textRun(text);
    if (!links.has(url)) {
      const id = `rLink${links.size + 1}`;
      links.set(url, id);
      relationships.push(`<Relationship Id="${id}" Type="${R}/hyperlink" Target="${xml(url)}" TargetMode="External"/>`);
    }
    return `<w:hyperlink r:id="${links.get(url)}" w:history="1">${textRun(text, '<w:color w:val="0563C1"/><w:u w:val="single"/>')}</w:hyperlink>`;
  };
  const field = (label, value, target = '') => paragraph(textRun(`${label}：`, '<w:b/>') + (target ? linkRun(value, target) : textRun(value || '未提供')), target ? 'LinkLine' : 'Normal');
  const body = [
    paragraph(textRun(title), 'Title'),
    paragraph(textRun('本清单列出当前未标记为下载成功的文献，可用于补充全文或继续处理。尚未处理和处理中记录不代表下载失败。')),
    paragraph(textRun(`导出日期：${timestamp.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')}`), 'Metadata'),
    ...(sourceName ? [paragraph(textRun(`文献来源：${sourceName}`), 'Metadata')] : []),
    paragraph(textRun(`未获取全文 ${records.length} 条；尝试后失败 ${counts.failed} 条；尚未处理 ${counts.pending} 条；缺少下载入口 ${counts.missing} 条；处理中 ${counts.active} 条${other ? `；其他状态 ${other} 条` : ''}。`)),
    paragraph(textRun('记录依据当前下载任务状态；下载成功表示浏览器下载及文件检查通过，不代表已经核对论文内容。'), 'Metadata'),
  ];
  if (!records.length) body.push(paragraph(textRun('当前没有未获取全文的文献记录。')));
  for (const {paper, sourceIndex} of records) {
    const status = cleanText(paper.status).trim() || '未记录状态';
    const doi = cleanText(paper.doi || paper.originalDoi).trim();
    const pdfUrl = cleanText(paper.pdfUrl).trim();
    const landingUrl = cleanText(paper.landingUrl).trim();
    const reason = cleanText(paper.reason).trim() || ({pending: '尚未尝试下载。', missing_doi: '缺少可用 DOI 或 PDF 直链，尚未尝试下载。', searching: '仍在搜索，结果尚未确定。', downloading: '仍在下载，结果尚未确定。'}[status] || '未记录原因。');
    body.push(
      paragraph(textRun(`原编号 ${sourceIndex}`), 'EntryHeading'),
      paragraph(textRun(cleanText(paper.title).trim() || '未提供题名', '<w:b/>'), 'Normal', '<w:keepNext/>'),
      field('DOI', doi, /^10\.\d{4,9}(?:\.\d+)*\/\S+$/i.test(doi) ? `https://doi.org/${encodeURIComponent(doi).replace(/%2F/gi, '/')}` : ''),
      field('PDF 直链', pdfUrl, safeLink(pdfUrl)),
      field('全文网页入口', landingUrl, safeLink(landingUrl)),
      field('当前状态', STATUS[status] || status),
      field('失败原因或处理说明', reason),
    );
  }
  body.push('<w:sectPr><w:footerReference w:type="default" r:id="rFooter"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr>');
  return zip({
    '[Content_Types].xml': `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
    '_rels/.rels': `${XML}<Relationships xmlns="${PKG_R}"><Relationship Id="rDocument" Type="${R}/officeDocument" Target="word/document.xml"/><Relationship Id="rCore" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rApp" Type="${R}/extended-properties" Target="docProps/app.xml"/></Relationships>`,
    'word/document.xml': `${XML}<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${body.join('')}</w:body></w:document>`,
    'word/_rels/document.xml.rels': `${XML}<Relationships xmlns="${PKG_R}">${relationships.join('')}</Relationships>`,
    'word/styles.xml': STYLES,
    'word/footer1.xml': `${XML}<w:ftr xmlns:w="${W}">${paragraph(textRun('第 ') + '<w:fldSimple w:instr="PAGE"><w:r><w:t>1</w:t></w:r></w:fldSimple>' + textRun(' 页'), 'Metadata', '<w:jc w:val="center"/>')}</w:ftr>`,
    'docProps/core.xml': `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(title)}</dc:title><dc:creator>文献获取助手</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:modified></cp:coreProperties>`,
    'docProps/app.xml': `${XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>文献获取助手</Application></Properties>`,
  });
}
