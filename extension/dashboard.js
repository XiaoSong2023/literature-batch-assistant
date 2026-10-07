import {parseBibliography} from './importers.js';
import {initCleanupPanel} from './cleanup-ui.js';
import {hasDownloadTarget, normalizeHttpUrl, paperImportKey, carryCompletedImports, importBlockedReason} from './core.js';
import {createRetryCsv} from './report-csv.js';
import {createUnobtainedDocx} from './report-docx.js';
import {initNavigation, initSpotlight, initDropZone, confirmAction} from './ui-effects.js';

const $ = id => document.getElementById(id);
const labels = { pending: '待处理', missing_doi: '缺少下载入口', searching: '正在搜索', downloading: '正在下载', success: '下载成功', failed: '尝试后失败' };
let state = null, page = 0, busy = false, settingsLoaded = false, toastTimer, parsedImport = null, rangeKey = '', seenImport = null;
const PAGE_SIZE = 50;
// Last rendered status per paper; a row that turns successful while on screen is stamped.
const seenStatus = new Map();
const cleanup = initCleanupPanel({getState:()=>state, notify, confirm:confirmAction});
const dropZone = initDropZone($('dropZone'), $('importFile'), $('fileList'));
const version = chrome.runtime.getManifest?.().version || '1.5.0';
$('versionLabel').textContent = `LITERATURE LIBRARY · V${version}`;

async function command(type, payload = {}) {
  let timer;
  const result = await Promise.race([
    chrome.runtime.sendMessage({ type, ...payload }),
    new Promise((_, reject) => {timer = setTimeout(() => reject(new Error('后台暂未响应。操作可能仍在处理中，请稍后刷新面板核对；不要重新导入整份清单。')), 30000);}),
  ]).finally(() => clearTimeout(timer));
  if (!result?.ok) throw new Error(result?.error || '扩展后台未响应，请在扩展管理页重新加载。');
  if (result.state) { state = result.state; render(); }
  return result;
}
function notify(message, error = false) {
  $('message').textContent = message;
  $('message').className = error ? 'error' : '';
  $('message').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('message').hidden = true; }, error ? 12000 : 6000);
}
function setCount(id, value) {
  const node = $(id);
  node.textContent = value;
  // The visible digits are a CSS counter easing toward --n; the text itself stays exact.
  node.classList.add('is-counting');
  node.style.setProperty('--n', value);
}
function percent(part, whole) {
  const value = whole ? part / whole * 100 : 0;
  return `${value === 0 || value === 100 ? value : value.toFixed(1)}%`;
}
async function action(task) {
  if (busy) return;
  busy = true;
  renderControls();
  try { await task(); } catch (error) { notify(error.message, true); }
  finally { busy = false; renderControls(); }
}
function renderControls() {
  const running = state?.running;
  const waiting = state?.waitingForVerification;
  for (const id of ['start3','startAll','retry','retryRemaining','saveSettings']) $(id).disabled = busy || !state || running || waiting;
  $('pause').disabled = busy || !(running || waiting);
  $('skipCurrent').disabled = busy || !state?.activeId;
  const active = state?.papers?.find(p=>p.id===state.activeId);
  $('reopenCurrent').disabled = busy || active?.status !== 'searching';
  const rangeBlocked = busy || !state || running || waiting || active?.status === 'downloading';
  $('startFrom').disabled = rangeBlocked;
  $('startFromNumber').disabled = rangeBlocked;
  $('retry').disabled ||= !state?.papers?.some(p => p.status === 'failed');
  $('retry').disabled ||= Boolean(state?.activeId);
  $('retryRemaining').disabled ||= !state?.papers?.some(p => p.status !== 'success' && hasDownloadTarget(p));
  const importReason = importBlockedReason(state);
  const importBlocked = busy || Boolean(importReason) || !parsedImport;
  $('importButton').disabled = importBlocked;
  $('importAndRun').disabled = importBlocked || !selectedImportPapers().some(hasDownloadTarget);
  $('importStatus').textContent = busy ? '正在处理，请稍候…' : importReason || (parsedImport ? `可以导入：将切换到这 ${selectedImportPapers().length} 条新清单，只处理本批文献；电脑上已下载的 PDF 不会删除，无需先清空旧清单。` : '请先解析并预览文献。');
  $('previewImport').disabled = busy;
  for (const id of ['importFile','doiText','dedupeImport']) $(id).disabled = busy;
  for (const id of ['exportUnresolved','exportFailed','exportRetryCsv','exportWord','exportCsv','exportJson']) $(id).disabled = busy || !state;
  cleanup.refreshControls();
}
function render() {
  if (!state) return;
  const papers = state.papers || [];
  const count = status => papers.filter(p => p.status === status).length;
  const success = count('success'), failed = count('failed'), missing = count('missing_doi');
  const unfinished = papers.length - success - failed - missing;
  const eligible = papers.length - missing, attempted = success + failed, empty = !papers.length;
  const selectedIds = state.runPaperIds ? new Set(state.runPaperIds) : null;
  const rangeUnfinished = papers.slice((state.startFromNumber || 1)-1).some(p=>(!selectedIds || selectedIds.has(p.id)) && ['pending','searching','downloading'].includes(p.status));
  setCount('totalCount', papers.length);
  setCount('successCount', success);
  setCount('failedCount', failed);
  setCount('missingCount', missing);
  setCount('pendingCount', unfinished);
  $('totalSub').textContent = empty ? '尚未导入' : `${eligible} 条可处理`;
  $('successSub').textContent = eligible ? `占可处理 ${percent(success, eligible)}` : '通过 PDF 核验';
  $('failedSub').textContent = failed ? '可一键重试' : '暂无失败';
  $('pendingSub').textContent = state.running ? '队列运行中' : unfinished ? '等待继续' : empty ? '等待导入' : '全部处理完毕';
  $('progress').max = Math.max(1, eligible);
  $('progress').value = attempted;
  $('progressLabel').textContent = `已尝试 ${attempted} / ${eligible} 条有 DOI / PDF 直链的记录`;
  $('progressPercent').textContent = $('navPercent').textContent = percent(attempted, eligible);
  $('meterOk').style.setProperty('--w', `${eligible ? success / eligible * 100 : 0}%`);
  $('meterFail').style.setProperty('--w', `${eligible ? failed / eligible * 100 : 0}%`);
  $('navMeterFill').style.setProperty('--p', `${eligible ? attempted / eligible * 100 : 0}%`);
  $('runBadge').textContent = empty ? '尚未导入文献' : state.waitingForVerification ? '等待人工验证 · 完成后自动继续' : state.running ? (selectedIds ? '仅重试失败项' : '队列运行中') : rangeUnfinished ? '已暂停 / 等待开始' : selectedIds ? '本轮失败项处理完成' : state.startFromNumber > 1 ? '当前范围处理完成' : '本轮处理完成';
  $('runBadge').className = `badge${state.running ? ' running' : state.waitingForVerification ? ' waiting' : empty ? ' is-empty' : rangeUnfinished ? '' : ' done'}`;
  $('queuePanel').classList.toggle('is-running', Boolean(state.running));
  $('queuePanel').classList.toggle('is-empty', empty);
  $('emptyQueue').hidden = !empty;
  $('nowCard').dataset.mode = state.waitingForVerification ? 'waiting' : state.running ? 'running' : rangeUnfinished || empty ? 'idle' : 'done';
  const active = papers.find(p => p.id === state.activeId);
  $('current').textContent = empty ? '还没有文献清单。导入题录、DOI 或 PDF 直链后即可开始。' : (state.pauseReason && !state.running ? state.pauseReason + ' ' : '') + (active ? `${labels[active.status] || active.status} · ${active.sourceIndex} · ${active.title}${active.reason ? ' — ' + active.reason : ''}` : state.running ? '正在准备下一条文献…' : rangeUnfinished ? '进度已保存在本机。可继续当前范围，或点击“继续所有未完成”补齐整个清单。' : '可导出未获取全文清单、继续所有未完成、重试失败项，或导入新一批文献。');
  $('sourceName').textContent = state.sourceName || '用户文献清单';
  const newRangeKey = `${state.importedAt}|${state.startFromNumber || 1}|${papers.length}`;
  $('startFromNumber').max = Math.max(1, papers.length);
  if (newRangeKey !== rangeKey) { $('startFromNumber').value = state.startFromNumber || 1; rangeKey = newRangeKey; }
  $('queueRange').textContent = selectedIds ? `当前仅重试 ${selectedIds.size} 条失败记录；成功项自动跳过` : `当前处理范围：第 ${state.startFromNumber || 1}–${papers.length} 条`;
  $('openSite').querySelector('.label').textContent = state.tabId != null ? '查看当前任务页' : '打开搜索网站';
  if (!settingsLoaded && state.settings) {
    for (const key of ['delaySeconds','timeoutSeconds','resultTimeoutSeconds','downloadTimeoutSeconds','verificationReopenSeconds']) if (state.settings[key] != null) $(key).value = state.settings[key];
    $('autoRobotNo').checked = state.settings.autoRobotNo !== false;
    $('autoReopenVerification').checked = state.settings.autoReopenVerification !== false;
    settingsLoaded = true;
  }
  if (state.importedAt !== seenImport) { seenStatus.clear(); seenImport = state.importedAt; }
  const counts = {all: papers.length, success, failed, missing_doi: missing, pending: count('pending'), active: count('searching') + count('downloading')};
  for (const node of document.querySelectorAll('[data-count]')) node.textContent = counts[node.dataset.count];
  renderControls(); renderTable(); renderActivity();
  for (const p of papers) seenStatus.set(p.id, p.status);
  const logNodes = (state.log || []).slice(-50).reverse().map(entry => {
    const li = document.createElement('li');
    const when = entry.at || entry.time || entry.timestamp;
    li.textContent = typeof entry === 'string' ? entry : `${when ? new Date(when).toLocaleString() + ' · ' : ''}${entry.message || entry.text || JSON.stringify(entry)}`;
    return li;
  });
  $('logs').replaceChildren(...logNodes);
}
function renderActivity() {
  if (!state) return;
  const message = state.progressMessage || (state.waitingForVerification ? '请在当前任务页完成验证；识别到结果后会自动继续。' : state.running ? '正在处理队列…' : state.papers?.length ? '队列已保存，可继续处理或导入新文献。' : '导入后会在这里显示每一步的处理进度。');
  const remaining = state.running && state.phaseDeadlineAt ? Math.max(0, Math.ceil((state.phaseDeadlineAt - Date.now()) / 1000)) : null;
  $('activity').textContent = message + (remaining === null ? '' : ` · 本阶段等待上限剩余 ${remaining} 秒`);
}
function renderTable() {
  if (!state) return;
  const query = $('query').value.trim().toLowerCase(), filter = document.querySelector('input[name="statusFilter"]:checked')?.value || 'all';
  const papers = state.papers.filter(p => (filter === 'all' || p.status === filter || filter === 'active' && ['searching','downloading'].includes(p.status)) && `${p.title} ${p.doi} ${p.pdfUrl || ''} ${p.landingUrl || ''} ${p.sourceIndex}`.toLowerCase().includes(query));
  const pages = Math.max(1, Math.ceil(papers.length / PAGE_SIZE));
  page = Math.min(page, pages - 1);
  const rows = papers.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(p => {
    const row = document.createElement('tr');
    const index = document.createElement('td'); index.textContent = p.sourceIndex || p.id;
    const title = document.createElement('td');
    const titleText = document.createElement('div'); titleText.className = 'paper-title'; titleText.textContent = p.title || '未提供题目';
    const doi = document.createElement('div'); doi.className = 'doi'; doi.textContent = p.doi || '— 未确认 DOI';
    title.append(titleText, doi);
    for (const [value, label] of [[p.pdfUrl, '手动打开 PDF 链接'], [p.landingUrl, '手动打开网页入口']]) {
      const url = normalizeHttpUrl(value);
      if (!url) continue;
      const line = document.createElement('div'); line.className = 'doi';
      const link = document.createElement('a'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = label; link.title = url;
      line.append(link); title.append(line);
    }
    if (p.sourceStatus) { const sourceStatus = document.createElement('div'); sourceStatus.className = 'source-status'; sourceStatus.textContent = p.sourceStatus; title.append(sourceStatus); }
    const stamped = p.status === 'success' && seenStatus.has(p.id) && seenStatus.get(p.id) !== 'success';
    const status = document.createElement('td'); const pill = document.createElement('span'); pill.className = `pill ${Object.hasOwn(labels,p.status) ? p.status : ''}${stamped ? ' stamp' : ''}`; pill.textContent = labels[p.status] || p.status; status.append(pill);
    const reason = document.createElement('td'); reason.className = 'reason'; reason.textContent = p.reason || (p.status === 'success' ? p.filename : '');
    row.append(index, title, status, reason); return row;
  });
  if (!rows.length) { const row = document.createElement('tr'); const td = document.createElement('td'); td.colSpan = 4; td.className = 'empty'; td.textContent = state.papers.length ? '没有符合条件的记录' : '导入文献后，在这里查看每条记录的处理状态。'; row.append(td); rows.push(row); }
  $('papersBody').replaceChildren(...rows);
  $('pageInfo').textContent = `共 ${papers.length} 条 · 第 ${page + 1} / ${pages} 页`;
  $('prevPage').disabled = page === 0;
  $('nextPage').disabled = page >= pages - 1;
}
function settings() {
  const result = {};
  for (const key of ['delaySeconds','timeoutSeconds','resultTimeoutSeconds','downloadTimeoutSeconds','verificationReopenSeconds']) {
    if (!$(key).reportValidity()) throw new Error('请检查设置范围。');
    result[key] = Number($(key).value);
  }
  result.autoRobotNo = $('autoRobotNo').checked;
  result.autoReopenVerification = $('autoReopenVerification').checked;
  return result;
}
function timestamp() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}_${String(d.getHours()).padStart(2,'0')}${String(d.getMinutes()).padStart(2,'0')}${String(d.getSeconds()).padStart(2,'0')}`; }
async function downloadReport(name, text, mime = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob(typeof text === 'string' ? ['\uFEFF',text] : [text], {type:mime}));
  try { await chrome.downloads.download({url,filename:`LiteratureBatch/${name}`,saveAs:false,conflictAction:'uniquify'}); }
  finally { setTimeout(() => URL.revokeObjectURL(url), 60000); }
  notify('报告已交给 Chrome 保存，可在下载记录中查看。');
}
function unresolvedText(failedOnly = false) {
  const lines = [failedOnly ? '尝试后仍未下载成功的文献' : '尚未获取全文的文献清单',`导出时间：${new Date().toLocaleString()}`,`来源：${state.sourceName || '用户文献清单'}`,`当前选定处理范围：第 ${state.startFromNumber || 1}–${state.papers.length} 条；起点之前未处理的记录仍列为尚未处理。`,'说明：只有完成下载并通过文件类型及大小检查才标记成功；报告不核对论文内容。',''];
  const groups = failedOnly ? [['failed','尝试后失败']] : [['failed','尝试后失败'],['missing_doi','缺少 DOI / PDF 直链，未进行下载'],['pending','尚未处理，不代表网站未收录'],['searching','仍在搜索，结果尚未确定'],['downloading','仍在下载，结果尚未确定']];
  for (const [status, heading] of groups) {
    const papers = state.papers.filter(p => p.status === status);
    lines.push(`===== ${heading}（${papers.length} 条） =====`,'');
    for (const p of papers) lines.push(`原编号：${p.sourceIndex}`,`题目：${p.title}`,`DOI：${p.doi || '未确认'}`,`PDF 直链：${p.pdfUrl || '未提供'}`,`网页入口（人工打开）：${p.landingUrl || '未提供'}`,`原因：${p.reason || heading}`,`尝试次数：${p.attempts || 0}`,'');
  }
  return lines.join('\r\n');
}
const csvCell = value => { let s = String(value ?? ''); if (/^[=+@\-\t\r]/.test(s)) s = "'" + s; return '"' + s.replaceAll('"','""') + '"'; };

$('start3').addEventListener('click', () => action(() => command('START',{limit:3,settings:settings()})));
$('startAll').addEventListener('click', () => action(() => command('START',{limit:0,settings:settings()})));
$('startFrom').addEventListener('click', () => action(async () => {
  if (!$('startFromNumber').reportValidity()) throw new Error('请输入本批文献范围内的起始序号。');
  const startFromNumber = Number($('startFromNumber').value);
  if (!Number.isInteger(startFromNumber)) throw new Error('起始序号必须是整数。');
  await command('START_FROM',{startFromNumber,settings:settings()});
  notify(`已从第 ${startFromNumber} 条开始处理；此前记录保留，已成功条目不会重复下载。`);
}));
$('pause').addEventListener('click', () => action(() => command('PAUSE')));
$('skipCurrent').addEventListener('click', () => action(() => command('SKIP_CURRENT')));
$('reopenCurrent').addEventListener('click', () => action(async () => { await command('REOPEN_CURRENT'); notify('已重建任务页，继续处理同一条 DOI。'); }));
initNavigation();
initSpotlight();
$('emptyImport').addEventListener('click', () => $('showImport').click());
$('retry').addEventListener('click', () => action(async () => { await command('RETRY_UNFINISHED',{scope:'failed',settings:settings()}); notify('已开始重试失败项，成功记录保持不变。'); }));
$('retryRemaining').addEventListener('click', () => action(async () => { await command('RETRY_UNFINISHED',{scope:'unfinished',settings:settings()}); notify('已继续全部未完成记录，包括起点之前的遗漏项；成功记录保持不变。'); }));
$('saveSettings').addEventListener('click', () => action(async () => { await command('UPDATE_SETTINGS',{settings:settings()}); notify('运行设置已保存。'); }));
$('openSite').addEventListener('click', () => action(async () => {
  if (state?.tabId != null) {
    try { await chrome.tabs.update(state.tabId,{active:true}); return; } catch { /* A closed task tab can be reopened. */ }
  }
  await chrome.tabs.create({url:state?.settings?.siteUrl || 'https://sci-hub.box/'});
}));
$('query').addEventListener('input', () => {page=0;renderTable();});
$('statusFilter').addEventListener('change', () => {page=0;renderTable();});
$('prevPage').addEventListener('click', () => {page--;renderTable();});
$('nextPage').addEventListener('click', () => {page++;renderTable();});
$('exportUnresolved').addEventListener('click', () => action(() => downloadReport(`未获取全文_${timestamp()}.txt`,unresolvedText())));
$('exportFailed').addEventListener('click', () => action(() => downloadReport(`尝试后失败_${timestamp()}.txt`,unresolvedText(true))));
$('exportRetryCsv').addEventListener('click', () => action(() => downloadReport(`未获取全文_可重新导入_${timestamp()}.csv`,createRetryCsv(state.papers),'text/csv;charset=utf-8')));
$('exportWord').addEventListener('click', () => action(() => downloadReport(`未获取全文_${timestamp()}.docx`,createUnobtainedDocx(state.papers,{sourceName:state.sourceName,exportedAt:new Date().toISOString()}),'application/vnd.openxmlformats-officedocument.wordprocessingml.document')));
$('exportCsv').addEventListener('click', () => action(() => {
  const fields=['sourceIndex','title','doi','pdfUrl','landingUrl','sourceStatus','status','attempts','reason','filename','downloadId'];
  const text=[['原编号','题目','DOI','pdfUrl','landingUrl','原始标注','处理状态','尝试次数','说明','文件名','下载编号'].map(csvCell).join(','),...state.papers.map(p=>fields.map(k=>csvCell(k==='status' ? labels[p[k]] || p[k] : p[k])).join(','))].join('\r\n');
  return downloadReport(`全部处理记录_${timestamp()}.csv`,text,'text/csv;charset=utf-8');
}));
$('exportJson').addEventListener('click', () => action(() => downloadReport(`全部处理记录_${timestamp()}.json`,JSON.stringify(state,null,2),'application/json;charset=utf-8')));
function selectedImportPapers() {
  if (!parsedImport) return [];
  if (!$('dedupeImport').checked) return parsedImport.papers;
  const seen = new Set();
  return parsedImport.papers.filter(p=>{
    const key=paperImportKey(p); if(!key) return true;
    if(seen.has(key)) return false; seen.add(key); return true;
  });
}
function invalidateImport() { parsedImport=null; $('importPreview').hidden=true; renderControls(); }
function renderImportPreview() {
  if(!parsedImport) return;
  const all=parsedImport.papers, selected=selectedImportPapers();
  const withDoi=selected.filter(p=>p.doi).length;
  const withPdfUrl=selected.filter(p=>p.pdfUrl).length, eligible=selected.filter(hasDownloadTarget).length;
  const keys=all.map(paperImportKey).filter(Boolean), duplicates=keys.length-new Set(keys).size;
  const completed=state ? carryCompletedImports(selected,state).restoredCount : 0;
  $('importSummary').textContent=`${parsedImport.formats.join(' + ')} · 共解析 ${all.length} 条；将导入 ${selected.length} 条，可处理 ${eligible} 条，缺少 DOI / PDF 直链 ${selected.length-eligible} 条。含 DOI ${withDoi} 条、PDF 直链 ${withPdfUrl} 条（可重叠）。相同题名及 DOI / URL 的重复记录 ${duplicates} 条。已有成功记录 ${completed} 条，本次自动保留并跳过。`;
  $('importPreviewBody').replaceChildren(...selected.slice(0,5).map(p=>{
    const tr=document.createElement('tr');const title=document.createElement('td'),doi=document.createElement('td');
    title.textContent=p.title;doi.textContent=[p.doi,p.pdfUrl].filter(Boolean).join(' · ')||(p.landingUrl ? '仅网页入口，需人工打开' : '未确认 DOI / PDF 直链');tr.append(title,doi);return tr;
  }));
  $('importWarningDetails').hidden=!parsedImport.warnings.length;
  $('importWarningSummary').textContent=`导入提示（${parsedImport.warnings.length} 条${parsedImport.warnings.length>100?'，显示前 100 条':''}）`;
  $('importWarnings').replaceChildren(...parsedImport.warnings.slice(0,100).map(w=>{const li=document.createElement('li');li.textContent=w;return li;}));
  $('importPreview').hidden=false;
  renderControls();
}
async function previewImport() {
  const files=[...$('importFile').files], pasted=$('doiText').value.trim();
  if(!files.length&&!pasted) throw new Error('请选择题录文件，或粘贴 DOI / PDF 直链。');
  const bytes=files.reduce((n,f)=>n+f.size,0)+new TextEncoder().encode(pasted).length;
  if(bytes>15*1024*1024) throw new Error('本批次合计超过 15 MB，请分批导入。');
  const sources=[];
  for(const file of files) sources.push({name:file.name,text:await file.text()});
  if(pasted) sources.push({name:'粘贴的DOI或PDF直链.txt',text:pasted});
  const papers=[],warnings=[],formats=[];
  for(const source of sources) {
    let result;
    try {result=parseBibliography(source.text,source.name);} catch(error) {throw new Error(`${source.name}：${error.message}`);}
    formats.push(result.format); warnings.push(...result.warnings.map(w=>`${source.name}：${w}`));
    for(const p of result.papers) {
      const index=String(papers.length+1).padStart(4,'0');
      papers.push({...p,id:`import-${index}`,sourceIndex:index,sourceStatus:`${p.sourceStatus||''} [来源：${source.name}；原编号：${p.sourceIndex}]`.trim()});
    }
  }
  if(!papers.length) throw new Error('没有解析到文献。请检查文件格式、DOI 或 PDF 直链。');
  if(papers.length>20000) throw new Error(`解析到 ${papers.length} 条，单批最多 20,000 条，请拆分文件。`);
  parsedImport={papers,warnings,formats:[...new Set(formats)],sourceName:sources.map(s=>s.name).join(' + ')};
  renderImportPreview();
}
async function commitImport(andRun) {
  const papers=selectedImportPapers();
  if(!papers.length) throw new Error('请先解析并预览文献。');
  const runSettings=andRun ? settings() : null;
  const completed=carryCompletedImports(papers,state).restoredCount;
  if(!await confirmAction({title:'用新清单替换当前队列',confirmLabel:andRun?'导入并开始':'导入清单',message:`将用本批 ${papers.length} 条文献替换当前队列，保留本扩展已有的 ${completed} 条匹配成功记录${andRun?'，并只开始本批其余可下载条目':''}。\n电脑上的 PDF 不会删除，无需先清空旧清单。旧队列中未导入的条目不在新队列中，请先导出需要保留的报告。`})) return;
  await command('IMPORT',{papers,sourceName:parsedImport.sourceName});
  page=0; render();
  parsedImport=null; $('importPreview').hidden=true;
  $('importFile').value=''; $('doiText').value=''; dropZone.refresh();
  if(andRun) await command('START',{limit:0,settings:runSettings});
  notify(andRun?'已导入并开始其余有 DOI / PDF 直链的记录，已有成功记录自动跳过。':'新清单已导入，已有成功记录保留，点击开始处理其余条目。');
}
$('importFile').addEventListener('change',invalidateImport);
$('doiText').addEventListener('input',invalidateImport);
$('dedupeImport').addEventListener('change',renderImportPreview);
$('previewImport').addEventListener('click',()=>action(previewImport));
$('importButton').addEventListener('click',()=>action(()=>commitImport(false)));
$('importAndRun').addEventListener('click',()=>action(()=>commitImport(true)));
setInterval(renderActivity,1000);
chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local') command('GET_STATE').catch(error=>notify(error.message,true));});
command('GET_STATE').catch(error=>{notify(error.message,true);$('current').textContent='后台加载失败，请在 chrome://extensions 检查扩展错误并重新加载。';});
