import {scanDuplicatePdfs, deleteDuplicatePdfs, MAX_DEDUP_FILE_BYTES} from './file-dedup.js';

const PREVIEW_LIMIT = 100;

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function permissionMessage(error) {
  if (error?.name === 'NotAllowedError') return '没有获得文件夹读写权限，请重新选择文件夹，并在 Chrome 提示中允许访问。';
  if (error?.name === 'SecurityError') return 'Chrome 未允许访问此文件夹，请在已加载的扩展页面直接点击“选择文件夹并扫描”，选择存放 PDF 的普通文件夹。';
  return error?.message || '本地文件操作失败，请重新选择文件夹后重试。';
}

/** All handles stay in this page; only a user-selected directory is accessed. */
export function initCleanupPanel({getState, notify, confirm = ({message}) => Promise.resolve(window.confirm(message))}) {
  const ids = ['chooseDedupFolder', 'rescanDedup', 'cancelDedup', 'deleteDuplicates',
    'dedupFolder', 'dedupStatus', 'dedupSummary', 'dedupBody', 'dedupDetails'];
  const ui = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
  if (ids.some(id => !ui[id])) throw new Error('本地文件去重面板缺少必要元素。');
  const supported = typeof window.showDirectoryPicker === 'function';
  let directoryHandle = null, snapshot = null, operation = '', controller = null;
  let statusMessage = supported ? '选择下载文件夹，先扫描并核对重复副本。' :
    '此页面不支持选择本地文件夹。请在 Chrome 中加载新版扩展，并打开扩展的完整控制面板。';
  let lastProgressAt = 0;

  function queueBlocked() {
    const state = getState();
    return !state || state.running || state.waitingForVerification ||
      state.papers?.some(paper => paper.status === 'downloading');
  }

  function refreshControls() {
    const blocked = queueBlocked();
    if (operation === 'deleting' && blocked && !controller?.signal.aborted) {
      controller?.abort();
      statusMessage = '下载队列已开始或正在等待验证，正在停止清理；已删除的副本不会撤销。';
    }
    ui.chooseDedupFolder.disabled = !supported || Boolean(operation);
    ui.rescanDedup.disabled = !supported || !directoryHandle || Boolean(operation);
    ui.cancelDedup.disabled = !['scanning', 'deleting'].includes(operation) || Boolean(controller?.signal.aborted);
    ui.deleteDuplicates.disabled = !supported || Boolean(operation) || blocked || !snapshot?.candidates.length;
    ui.deleteDuplicates.title = blocked ? '请先暂停下载队列，并等待下载结束、人工验证状态退出后清理。' :
      !snapshot?.candidates.length ? '请先扫描并核对内容完全相同的 PDF 副本。' : '保留原文件，永久删除校验通过的编号副本。';
    ui.dedupStatus.textContent = statusMessage + (!operation && snapshot && blocked ?
      ' 下载队列仍在运行、下载或等待验证；请先暂停并等待下载结束，再删除副本。' : '');
  }

  function setStatus(message) {
    statusMessage = message;
    refreshControls();
  }

  function renderCandidates(candidates = []) {
    const rows = candidates.slice(0, PREVIEW_LIMIT).map(candidate => {
      const row = document.createElement('tr');
      for (const value of [candidate.name, candidate.originalName, formatBytes(candidate.size)]) {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.append(cell);
      }
      return row;
    });
    if (!rows.length) {
      const row = document.createElement('tr'), cell = document.createElement('td');
      cell.colSpan = 3;
      cell.className = 'empty';
      cell.textContent = '暂无可清理副本；先选择文件夹并扫描。';
      row.append(cell);
      rows.push(row);
    }
    ui.dedupBody.replaceChildren(...rows);
  }

  function renderDetails(records = []) {
    const rows = records.slice(0, PREVIEW_LIMIT).map(record => {
      const row = document.createElement('li');
      row.textContent = `${record.name || '文件夹'}：${record.reason || '已保留'}`;
      return row;
    });
    if (records.length > PREVIEW_LIMIT) {
      const row = document.createElement('li');
      row.textContent = `共 ${records.length} 条保留或失败记录，此处显示前 ${PREVIEW_LIMIT} 条。`;
      rows.push(row);
    }
    ui.dedupDetails.replaceChildren(...rows);
    ui.dedupDetails.hidden = rows.length === 0;
  }

  function scanSummary(result, partial = false) {
    const candidates = result?.candidates || [];
    ui.dedupSummary.textContent = `${partial ? '未完成的扫描' : '扫描完成'}：检查 ${result?.scanned || 0} 个 PDF，` +
      `发现 ${result?.numberedCopies || 0} 个编号副本；${candidates.length} 个内容完全一致，共 ${formatBytes(result?.totalBytes || 0)}。` +
      `保留 ${result?.skipped?.length || 0} 个需注意的文件。` +
      (candidates.length > PREVIEW_LIMIT ? `下方仅预览前 ${PREVIEW_LIMIT} 个，删除操作将处理全部 ${candidates.length} 个候选。` : '') +
      (partial ? '请重新扫描后再清理。' : '');
    renderCandidates(candidates);
    renderDetails(result?.skipped);
  }

  function progress(value) {
    // Run the queue guard on every callback, even when visual progress is throttled.
    if (operation === 'deleting' && queueBlocked()) {
      controller?.abort();
      setStatus('下载队列已开始或正在等待验证，正在停止清理。');
      return;
    }
    const now = Date.now();
    if (now - lastProgressAt < 120 && !value.phase.endsWith('complete')) return;
    lastProgressAt = now;
    if (value.phase === 'listing') setStatus(`正在读取文件夹第一层：已检查 ${value.entries} 个项目…`);
    else if (value.phase === 'hashing') setStatus(`正在逐字节校验：${value.name}；已确认 ${value.candidates || 0} 个重复副本…`);
    else if (value.phase === 'scanning') setStatus(`已检查 ${value.scanned} 个 PDF，已确认 ${value.candidates} 个重复副本…`);
    else if (value.phase === 'verifying') setStatus(`删除前重新校验 ${value.completed + 1}/${value.total}：${value.name}…`);
    else if (value.phase === 'deleting') setStatus(`已处理 ${value.completed}/${value.total}，删除 ${value.deleted} 个副本，释放 ${formatBytes(value.bytesFreed || 0)}。`);
  }

  async function runScan() {
    snapshot = null;
    operation = 'scanning';
    controller = new AbortController();
    lastProgressAt = 0;
    renderCandidates();
    renderDetails();
    ui.dedupSummary.textContent = '仅扫描所选文件夹第一层；子文件夹及未下载完成的文件不参与清理。';
    setStatus('正在扫描并校验 PDF 内容…');
    try {
      const result = await scanDuplicatePdfs(directoryHandle, {signal: controller.signal, onProgress: progress});
      snapshot = result;
      scanSummary(result);
      statusMessage = result.candidates.length ? '扫描完成。核对下方副本和保留原件，点击删除后会再次校验内容。' :
        '没有发现可安全删除的重复 PDF；未找到原件或内容不同的文件均已保留。';
    } catch (error) {
      snapshot = null;
      if (error.name === 'AbortError') {
        scanSummary(error.result, true);
        statusMessage = '扫描已停止，没有删除任何文件；需要重新扫描。';
      } else {
        statusMessage = permissionMessage(error);
        ui.dedupSummary.textContent = '扫描未完成，没有删除任何文件；请重新扫描。';
        notify(statusMessage, true);
      }
    } finally {
      operation = '';
      controller = null;
      refreshControls();
    }
  }

  ui.chooseDedupFolder.addEventListener('click', async () => {
    if (operation || !supported) return;
    operation = 'picking';
    snapshot = null;
    refreshControls();
    try {
      // Must be called directly from this click, before awaiting other work.
      const selection = await window.showDirectoryPicker({mode: 'readwrite', startIn: 'downloads', id: 'literature-dedup'});
      directoryHandle = selection;
      ui.dedupFolder.textContent = `已选择：${directoryHandle.name}（仅此文件夹第一层）`;
      await runScan();
    } catch (error) {
      statusMessage = error.name === 'AbortError' ? '已取消选择文件夹；清理前需要重新扫描。' : permissionMessage(error);
      ui.dedupSummary.textContent = '尚未取得新的扫描结果。';
      renderCandidates();
      renderDetails();
      if (error.name !== 'AbortError') notify(statusMessage, true);
    } finally {
      operation = '';
      refreshControls();
    }
  });

  ui.rescanDedup.addEventListener('click', async () => {
    if (operation || !directoryHandle) return;
    await runScan();
  });

  ui.cancelDedup.addEventListener('click', () => {
    if (!controller) return;
    controller.abort();
    setStatus(operation === 'deleting' ? '正在停止清理，已删除的副本不会撤销…' : '正在停止扫描，没有删除文件…');
  });

  ui.deleteDuplicates.addEventListener('click', async () => {
    if (operation || !snapshot?.candidates.length || !directoryHandle) return;
    if (queueBlocked()) {
      setStatus('请先暂停下载队列，并等待下载结束、人工验证状态退出后，再删除重复副本。');
      return;
    }
    const approved = snapshot;
    // Every attempted delete consumes the snapshot, even a cancelled confirmation.
    snapshot = null;
    const confirmation = `将清理文件夹“${directoryHandle.name}”中的 ${approved.candidates.length} 个重复 PDF 副本（${formatBytes(approved.totalBytes)}）。\n\n` +
      '无编号原文件会保留。每个文件删除前会重新核对两份内容。\n删除为永久删除，不会进入回收站。清理期间请勿移动或修改这些文件。\n\n确认删除这些副本？';
    if (!await confirm({title: '永久删除重复副本', message: confirmation, confirmLabel: '删除副本', danger: true})) {
      renderCandidates();
      ui.dedupSummary.textContent = '已取消删除，没有更改任何文件。';
      setStatus('已取消删除；如需清理，请重新扫描。');
      return;
    }
    if (queueBlocked()) {
      renderCandidates();
      setStatus('下载队列状态已改变，未开始删除；请暂停下载并重新扫描。');
      return;
    }
    operation = 'deleting';
    controller = new AbortController();
    lastProgressAt = 0;
    setStatus('正在确认文件夹权限并重新校验副本…');
    let result = null, aborted = false;
    try {
      // Re-request directly within the same button gesture. No hashing precedes it.
      if (typeof directoryHandle.requestPermission === 'function') {
        const permission = await directoryHandle.requestPermission({mode: 'readwrite'});
        if (permission !== 'granted') throw new DOMException('未授予文件夹读写权限。', 'NotAllowedError');
      } else if (typeof directoryHandle.queryPermission === 'function') {
        if (await directoryHandle.queryPermission({mode: 'readwrite'}) !== 'granted') {
          throw new DOMException('请重新选择文件夹并授权。', 'NotAllowedError');
        }
      }
      if (queueBlocked()) controller.abort();
      result = await deleteDuplicatePdfs(directoryHandle, approved.candidates,
        {signal: controller.signal, onProgress: progress});
      statusMessage = '清理完成，所有无编号原件均保留；再次清理前请重新扫描。';
    } catch (error) {
      aborted = error.name === 'AbortError';
      result = error.result || null;
      statusMessage = aborted ? '清理已停止；已完成的删除不会撤销，继续清理前请重新扫描。' :
        `${permissionMessage(error)} 继续清理前请重新扫描。`;
      if (!aborted) notify(statusMessage, true);
    } finally {
      operation = '';
      controller = null;
      snapshot = null;
      renderCandidates();
      const deleted = result?.deleted?.length || 0;
      const skipped = result?.skipped || [], failed = result?.failed || [];
      ui.dedupSummary.textContent = `${aborted ? '清理已停止' : '本次清理'}：删除 ${deleted} 个副本，` +
        `释放 ${formatBytes(result?.bytesFreed || 0)}；跳过 ${skipped.length} 个，失败 ${failed.length} 个。` +
        `剩余 ${Math.max(0, approved.candidates.length - deleted)} 个候选需重新扫描。`;
      renderDetails([...skipped, ...failed, ...(approved.skipped || [])]);
      refreshControls();
    }
  });

  ui.dedupFolder.textContent = '尚未选择文件夹';
  ui.dedupSummary.textContent = `只处理内容完全一致的编号 PDF 副本；超过 ${MAX_DEDUP_FILE_BYTES / (1024 * 1024)} MB 的文件保留。`;
  renderCandidates();
  renderDetails();
  refreshControls();
  return {refreshControls};
}
