// Re-importable bibliography: successful records never enter a retry file.
const cell = value => {
  let text = String(value ?? '');
  if (/^[=+@\-\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
};

export function createRetryCsv(papers, {failedOnly = false} = {}) {
  const fields = ['sourceIndex', 'title', 'doi', 'pdfUrl', 'landingUrl', 'sourceStatus', 'retryStatus', 'retryReason'];
  const selected = papers.filter(p => failedOnly ? p.status === 'failed' : p.status !== 'success');
  return [fields.map(cell).join(','), ...selected.map(p => fields.map(key => cell(
    key === 'retryStatus' ? p.status : key === 'retryReason' ? p.reason : key === 'sourceStatus'
      ? [p.sourceStatus, `前次状态：${p.status || 'pending'}`, p.reason ? `前次原因：${p.reason}` : ''].filter(Boolean).join('；')
      : p[key]
  )).join(','))].join('\r\n');
}
