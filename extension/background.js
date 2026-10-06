import {createInitialState, migrateState, normalizePapers, normalizeSettings, sanitizeFilename, verifyDownload, matchDownloadIntent, isConnectionFailure, hasDownloadTarget, carryCompletedImports, importBlockedReason} from "./core.js";
import {inspectPage, submitDoi, clickRobotNo, installPageWatcher} from "./content.js";

const STORAGE_KEY = "literatureBatchState";
const SESSION_KEY = "literatureBatchSession";
const WATCHDOG = "literature-batch-watchdog";
const WAKE = "literature-batch-next";
const ALLOWED_PAGE_ORIGINS = new Set(["https://sci-hub.box", "https://sci-net.xyz"]);
function isAllowedPageUrl(value) {
  try { return ALLOWED_PAGE_ORIGINS.has(new URL(value).origin); } catch { return false; }
}
let state;
let serial = Promise.resolve();
let wakeTimer;
const closedTaskTabs = new Set();
const API_WAIT_MS = 5000;
const MAX_DOWNLOAD_RECOVERIES = 2;
const DOWNLOAD_STALL_MS = 45000;

// A renderer/API promise may never settle. Bound the wait without pretending to
// cancel the underlying operation; side effects provide explicit late handlers.
function boundedCall(operation, label, milliseconds = API_WAIT_MS, onLate = null) {
  return new Promise((resolve, reject) => {
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      const error = new Error(`${label} 超过 ${Math.ceil(milliseconds / 1000)} 秒未响应`);
      error.code = "browser_api_timeout";
      reject(error);
    }, milliseconds);
    Promise.resolve().then(operation).then(value => {
      clearTimeout(timer);
      if (expired) { if (onLate) Promise.resolve().then(() => onLate(value)).catch(() => {}); }
      else resolve(value);
    }, error => { clearTimeout(timer); if (!expired) reject(error); });
  });
}

function browserApi(domain, method, ...args) {
  const remaining = domain === "scripting" && state?.running && !state.waitingForVerification && state.phaseDeadlineAt
    ? Math.max(250, state.phaseDeadlineAt - Date.now()) : API_WAIT_MS;
  return boundedCall(() => chrome[domain][method](...args), `${domain}.${method}`, Math.min(API_WAIT_MS, remaining));
}

function createTaskTab(options) {
  return boundedCall(() => chrome.tabs.create(options), "打开任务页", API_WAIT_MS,
    tab => browserApi("tabs", "remove", tab.id));
}

function downloadDeadline(paper) {
  return (paper.downloadBudgetStartedAt || paper.downloadIntentAt) + state.settings.downloadTimeoutSeconds * 1000;
}

function log(message, level = "info") {
  state.log.push({at: new Date().toISOString(), level, message});
  state.log = state.log.slice(-200);
}

async function persist() {
  state.updatedAt = new Date().toISOString();
  await chrome.storage.local.set({[STORAGE_KEY]: state});
}

// A private build may bundle a starting list; the public build starts with an empty queue.
async function readBundledPapers() {
  let response;
  try { response = await fetch(chrome.runtime.getURL("bundled-papers.json")); } catch { return {papers: []}; }
  return response.ok ? response.json() : {papers: []};
}

async function ensureLoaded() {
  if (state) return;
  const saved = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  if (saved?.schemaVersion === 1 && Array.isArray(saved.papers)) state = saved;
  else state = createInitialState(await readBundledPapers());
  migrateState(state);
  const session = (await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY];
  if (!session) {
    await chrome.storage.session.set({[SESSION_KEY]: Date.now()});
    // Chrome tab IDs can be reused after a browser restart. Never close or navigate
    // a saved numeric ID from an earlier session, even after the user clicks START.
    state.tabId = null;
    state.currentDocumentId = null;
    state.blockedDocumentId = null;
    state.watchedDocumentId = null;
    if (state.recoveryIntent) {
      state.recoveryIntent.oldTabId = null;
      state.recoveryIntent.oldClosed = true;
    }
    if (state.running || state.waitingForVerification) {
      state.running = false;
      state.waitingForVerification = false;
      state.verification = null;
      state.pauseKind = "browser_restart";
      state.phaseDeadlineAt = 0;
      state.pauseReason = "浏览器或扩展已重新启动，请点击继续。已开始的下载会继续核对结果。";
      state.progressMessage = state.pauseReason;
      log(state.pauseReason, "warning");
    }
  }
  await persist();
  if (!await chrome.alarms.get(WATCHDOG)) await chrome.alarms.create(WATCHDOG, {periodInMinutes: 0.5});
}

// Every state mutation, including browser callbacks, goes through one promise chain.
function enqueue(task) {
  const result = serial.then(async () => { await ensureLoaded(); return task(); });
  serial = result.catch(() => {});
  return result;
}

function runEvent(task) {
  enqueue(async () => {
    try { await task(); }
    catch (error) {
      state.running = false;
      state.waitingForVerification = false;
      state.verification = null;
      state.pauseKind = "error";
      state.pauseReason = `程序已暂停：${error?.message || error}`;
      state.lastError = state.pauseReason;
      log(state.pauseReason, "error");
      await persist();
    }
  }).catch(error => console.error("Literature batch storage/initialization error", error));
}

function activePaper() { return state.papers.find(paper => paper.id === state.activeId); }

async function schedule(milliseconds) {
  clearTimeout(wakeTimer);
  const wait = Math.max(250, milliseconds);
  // A timer gives a responsive page loop; a durable alarm recovers after suspension.
  wakeTimer = setTimeout(() => runEvent(pump), wait);
  await chrome.alarms.create(WAKE, {when: Date.now() + wait});
}

async function pause(reason, kind = "automatic") {
  state.running = false;
  state.waitingForVerification = false;
  state.verification = null;
  state.pauseKind = kind;
  if (["user", "tab_closed"].includes(kind)) state.recoveryIntent = null;
  state.pauseReason = reason;
  state.progressMessage = reason;
  state.phaseDeadlineAt = 0;
  clearTimeout(wakeTimer);
  await chrome.alarms.clear(WAKE);
  log(reason, "warning");
  await persist();
}

async function waitForVerification(reason, documentId = state.currentDocumentId) {
  const changed = !state.waitingForVerification || state.pauseReason !== reason;
  if (!state.waitingForVerification) {
    state.verification = {phase: state.phase, documentId, startedAt: Date.now()};
    log("检索页要求验证：保留当前文献，验证完成后自动继续。", "warning");
  }
  state.running = false;
  state.waitingForVerification = true;
  state.pauseKind = "verification";
  state.pauseReason = reason;
  state.progressMessage = reason;
  state.phaseDeadlineAt = 0;
  if (changed) await persist();
  await schedule(1000);
}

async function finishPaper(paper, success, code, reason, item = null) {
  // Ignore stale events from an earlier attempt or another download.
  if (!paper || paper.id !== state.activeId || !["searching", "downloading"].includes(paper.status)) return;
  if (state.recoveryIntent?.paperId === paper.id) state.recoveryIntent = null;
  if (state.waitingForVerification && state.pauseKind === "verification") state.running = true;
  state.waitingForVerification = false;
  state.verification = null;
  state.pauseKind = "";
  paper.status = success ? "success" : "failed";
  paper.reasonCode = code || "";
  paper.reason = reason || "";
  paper.finishedAt = new Date().toISOString();
  if (item) {
    paper.filename = item.filename || paper.filename;
    paper.mime = item.mime || "";
    paper.fileSize = item.fileSize >= 0 ? item.fileSize : item.bytesReceived;
  }
  state.processedThisRun += 1;
  state.consecutiveConnectionFailures = !success && isConnectionFailure(code) ? state.consecutiveConnectionFailures + 1 : 0;
  state.activeId = null;
  state.phase = "idle";
  state.phaseStartedAt = 0;
  state.phaseDeadlineAt = 0;
  state.resultReadyAt = 0;
  state.progressMessage = success ? "本条已下载完成，正在准备下一条。" : "本条已记录未获取原因，正在准备下一条。";
  state.nextAt = Date.now() + state.settings.delaySeconds * 1000;
  log(`${String(paper.sourceIndex).padStart(4, "0")} ${success ? "下载完成" : "未获取"} · ${paper.doi || paper.pdfUrl} · ${reason}`, success ? "success" : "warning");
  if (state.consecutiveConnectionFailures >= 3) log("连续网络错误已逐条记录；队列仍会处理后续文献，可手动暂停并检查网络。", "warning");
  if (state.limit > 0 && state.processedThisRun >= state.limit) {
    state.running = false;
    state.pauseReason = `本轮已处理 ${state.processedThisRun} 条，已按试跑数量停止。`;
    log(state.pauseReason);
  }
  await persist();
  if (state.running) await schedule(state.settings.delaySeconds * 1000);
}

async function getTaskTab() {
  if (state.tabId === null) return null;
  try { return await browserApi("tabs", "get", state.tabId); } catch (error) { if (error.code === "browser_api_timeout") throw error; return null; }
}

async function completePageRecovery() {
  const intent = state.recoveryIntent;
  const paper = activePaper();
  if (!intent || !paper || paper.id !== intent.paperId || !state.running) return;
  try {
    if (!intent.oldClosed && intent.oldTabId !== null) {
      try { await browserApi("tabs", "remove", intent.oldTabId); }
      catch (error) {
        const existing = await browserApi("tabs", "get", intent.oldTabId).catch(() => null);
        if (existing) {
          state.tabId = intent.oldTabId;
          await pause(`未能关闭当前任务标签页，已停止重开：${error.message || error}`, "error");
          return;
        }
      }
    }
    intent.oldClosed = true;
    await persist();
    const targetUrl = `${state.settings.siteUrl}#literature-batch-recovery=${encodeURIComponent(intent.token)}`;
    let tab = state.tabId !== null ? await getTaskTab() : null;
    if (!tab) {
      // A persisted marker recovers a tab created just before the worker was suspended.
      const candidates = await browserApi("tabs", "query", {url: "https://sci-hub.box/*"});
      tab = candidates.find(item => item.url === targetUrl || item.pendingUrl === targetUrl);
    }
    if (!tab) tab = await createTaskTab({url: targetUrl, active: true});
    state.tabId = tab.id;
    state.phase = "home";
    state.phaseStartedAt = Date.now();
    state.phaseDeadlineAt = Date.now() + state.settings.timeoutSeconds * 1000;
    state.currentDocumentId = null;
    state.blockedDocumentId = null;
    state.watchedDocumentId = null;
    state.resultReadyAt = 0;
    state.recoveryIntent = null;
    state.progressMessage = "已重开任务标签页，继续检索同一条 DOI。";
    await persist();
    await schedule(350);
  } catch (error) {
    await pause(`重新打开任务页失败，当前文献已保留：${error.message || error}`, "error");
  }
}

async function reopenCurrent(automatic = false) {
  const paper = activePaper();
  if (!paper || paper.status !== "searching") throw new Error("只能重开正在搜索或等待验证的当前文献；正在下载的文件不能重开。");
  if (automatic && (!state.waitingForVerification || (paper.automaticPageRecoveries || 0) >= 1)) return;
  if (state.recoveryIntent && state.recoveryIntent.paperId !== paper.id) state.recoveryIntent = null;
  state.running = true;
  state.waitingForVerification = false;
  state.verification = null;
  state.pauseKind = "";
  state.pauseReason = "";
  if (!state.recoveryIntent) {
    paper.pageRecoveryCount = (paper.pageRecoveryCount || 0) + 1;
    if (automatic) paper.automaticPageRecoveries = (paper.automaticPageRecoveries || 0) + 1;
    state.recoveryIntent = {
      paperId: paper.id, oldTabId: state.tabId, oldClosed: false, startedAt: Date.now(), automatic,
      token: `${state.runId}-${paper.id}-${paper.pageRecoveryCount}-${Date.now()}`,
    };
    // Unbind first: the old tab's onRemoved event must not pause the replacement tab.
    state.tabId = null;
    state.phase = "reopening";
    state.phaseDeadlineAt = 0;
    state.watchId = `${paper.id}:${paper.attempts}:${paper.startedAt}:recovery-${paper.pageRecoveryCount}`;
    state.progressMessage = automatic ? "验证等待较久，正在自动关闭并重开当前任务页（每篇最多一次）。" : "正在关闭并重开当前任务页，保留同一条 DOI 和处理进度。";
    log(state.progressMessage);
  }
  await persist();
  await completePageRecovery();
}

async function navigateHome(paper) {
  let tab;
  try {
    tab = await getTaskTab();
    let previousDocument = state.currentDocumentId;
    if (tab && chrome.webNavigation?.getFrame) {
      try { previousDocument = (await browserApi("webNavigation", "getFrame", {tabId: tab.id, frameId: 0}))?.documentId || previousDocument; } catch { /* Use the last observed document. */ }
    }
    state.blockedDocumentId = tab ? previousDocument : null;
    state.currentDocumentId = null;
    state.watchedDocumentId = null;
    state.phase = "home";
    state.phaseStartedAt = Date.now();
    state.phaseDeadlineAt = Date.now() + state.settings.timeoutSeconds * 1000;
    state.resultReadyAt = 0;
    state.progressMessage = "正在打开 DOI 检索输入页。";
    state.watchId = `${paper.id}:${paper.attempts}:${paper.startedAt}`;
    await persist();
    if (tab) await browserApi("tabs", "update", tab.id, {url: state.settings.siteUrl});
    else {
      const created = await createTaskTab({url: state.settings.siteUrl, active: true});
      state.tabId = created.id;
      await persist();
    }
    await schedule(350);
  } catch (error) {
    if (tab && closedTaskTabs.has(tab.id)) {
      state.tabId = null;
      await pause("任务页已关闭，保留当前文献；点击继续会重新打开同一条。", "tab_closed");
      return;
    }
    if (error.code === "browser_api_timeout" && tab) {
      // Never reuse a tab whose navigation can still finish late.
      state.tabId = null;
      await browserApi("tabs", "remove", tab.id).catch(() => {});
    }
    await finishPaper(paper, false, "navigation_error", `无法打开检索网站：${error.message || error}`);
  }
}

async function startNext() {
  if (!state.running || state.activeId) return;
  if (state.limit > 0 && state.processedThisRun >= state.limit) {
    await pause(`本轮已处理 ${state.processedThisRun} 条。`);
    return;
  }
  const paper = state.papers.slice((state.startFromNumber || 1) - 1).find(record => record.status === "pending" && (!state.runPaperIds || state.runPaperIds.includes(record.id)));
  if (!paper) {
    state.running = false;
    state.pauseReason = (state.startFromNumber || 1) > 1 ? `从列表第 ${state.startFromNumber} 条至末尾已无待处理项；起点之前的记录保持原状态。可导出报告或修改起点。` : "本轮队列已处理完毕。可导出失败清单或重试失败项。";
    log(state.pauseReason);
    await persist();
    return;
  }
  paper.status = "searching";
  paper.attempts += 1;
  paper.startedAt = new Date().toISOString();
  paper.reason = "";
  paper.reasonCode = "";
  paper.downloadId = null;
  paper.downloadUrl = "";
  paper.downloadIntentAt = 0;
  paper.downloadBudgetStartedAt = 0;
  paper.downloadRetryCount = 0;
  paper.downloadRetryAt = 0;
  paper.downloadStartUncertain = false;
  paper.downloadResumePending = false;
  paper.resumedDownloadId = null;
  paper.resumeProbeUntil = 0;
  paper.previousDownloadIds = [];
  paper.filename = "";
  paper.robotClicks = 0;
  paper.robotDocumentId = null;
  paper.robotClickedAt = 0;
  paper.robotResolvedAt = 0;
  paper.verificationHomeResubmits = 0;
  paper.pageRecoveryCount = 0;
  paper.automaticPageRecoveries = 0;
  state.activeId = paper.id;
  log(`开始 ${String(paper.sourceIndex).padStart(4, "0")} · ${paper.doi || paper.pdfUrl}`);
  if (paper.pdfUrl) await startDownload(paper, paper.pdfUrl);
  else await navigateHome(paper);
}

async function startDownload(paper, url) {
  const target = new URL(url);
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) {
    await finishPaper(paper, false, "invalid_pdf_url", "页面提供的下载地址格式不受支持。");
    return;
  }
  paper.status = "downloading";
  paper.downloadUrl = target.href;
  paper.downloadIntentAt = Date.now();
  paper.downloadBudgetStartedAt ||= paper.downloadIntentAt;
  paper.downloadStartUncertain = false;
  paper.resumeProbeUntil = 0;
  paper.downloadProgressAt = Date.now();
  paper.downloadBytesSeen = 0;
  paper.downloadStallCancelledId = null;
  paper.filename = sanitizeFilename(paper);
  state.phase = "download_starting";
  state.phaseStartedAt = Date.now();
  state.phaseDeadlineAt = downloadDeadline(paper);
  state.progressMessage = "已发现全文地址，正在交给 Chrome 下载并核对完成状态。";
  // Persist intent before the side effect. Recovery searches Chrome history instead of downloading again.
  await persist();
  try {
    const intentAt = paper.downloadIntentAt;
    paper.downloadId = await boundedCall(() => chrome.downloads.download({url: target.href, filename: paper.filename, conflictAction: "uniquify", saveAs: false}), "开始下载", API_WAIT_MS,
      id => runEvent(async () => {
        if (activePaper() === paper && paper.status === "downloading" && paper.downloadIntentAt === intentAt) {
          paper.downloadId = id; paper.downloadStartUncertain = false;
          await persist(); await reconcileDownload(paper);
        } else await browserApi("downloads", "cancel", id).catch(() => {});
      }));
    if (!Number.isInteger(paper.downloadId)) throw new Error("Chrome 未返回下载编号。");
    state.phase = "downloading";
    await persist();
    await reconcileDownload(paper);
  } catch (error) {
    // A completed browser download can precede the API promise; try to recover it first.
    const recovered = await findIntentDownload(paper).catch(() => null);
    if (recovered) {
      paper.downloadId = recovered.id;
      state.phase = "downloading";
      await persist();
      await inspectDownloadItem(paper, recovered);
    } else if (error.code === "browser_api_timeout") {
      paper.downloadStartUncertain = true;
      await setProgress("Chrome 尚未返回下载编号，正在核对下载记录，避免重复发起。", downloadDeadline(paper));
    } else await finishPaper(paper, false, "download_start_error", `浏览器无法开始下载：${error.message || error}`);
  }
  if (state.activeId === paper.id) await schedule(2000);
}

async function findIntentDownload(paper) {
  const items = await browserApi("downloads", "search", {startedAfter: new Date(paper.downloadIntentAt - 1000).toISOString(), orderBy: ["-startTime"], limit: 100});
  return items.find(item => matchesUnclaimedIntent(item, paper)) || null;
}

function matchesUnclaimedIntent(item, paper) {
  // Several titles can share a PDF URL. A previous entry's download, including
  // a failed attempt being retried, must not satisfy a new download intent.
  return matchDownloadIntent(item, paper, chrome.runtime.id) && !state.papers.some(record =>
    (record.id !== paper.id && record.downloadId === item.id) || record.lastFailure?.downloadId === item.id || record.previousDownloadIds?.includes(item.id));
}

async function restartInterruptedDownload(paper, item) {
  if (paper.resumedDownloadId === item.id) {
    // resume() can resolve without restarting a transfer. Cancel that old ID
    // before replacing it so a delayed resume cannot overlap the new download.
    await browserApi("downloads", "cancel", item.id).catch(() => {});
    const latest = (await browserApi("downloads", "search", {id: item.id}))[0];
    if (latest?.state !== "interrupted") {
      if (latest) await inspectDownloadItem(paper, latest);
      return;
    }
  }
  paper.previousDownloadIds ??= [];
  paper.previousDownloadIds.push(item.id);
  paper.downloadId = null;
  await startDownload(paper, paper.downloadUrl);
}

async function recoverInterruptedDownload(paper, item) {
  if (!/^(?:NETWORK_|SERVER_(?:FAILED|UNREACHABLE|CONTENT_LENGTH_MISMATCH))/.test(item.error || "")) return false;
  if (!state.running) {
    await setProgress(`下载因 ${item.error} 中断，当前文献已保留；点击继续后重试。`, 0);
    return true;
  }
  if (Date.now() >= downloadDeadline(paper)) return false;
  if (paper.downloadResumePending) { await schedule(1000); return true; }
  if (Date.now() < (paper.resumeProbeUntil || 0)) { await schedule(1000); return true; }
  if ((paper.downloadRetryCount || 0) >= MAX_DOWNLOAD_RECOVERIES) return false;
  if (!paper.downloadRetryAt) {
    paper.downloadRetryAt = Date.now() + 2000 * (1 + (paper.downloadRetryCount || 0));
    await setProgress(`网络中断 ${item.error}；将自动重试当前文献（最多 ${MAX_DOWNLOAD_RECOVERIES} 次）。`, downloadDeadline(paper));
    await persist();
  }
  if (Date.now() < paper.downloadRetryAt) { await schedule(Math.min(1000, paper.downloadRetryAt - Date.now())); return true; }
  paper.downloadRetryCount = (paper.downloadRetryCount || 0) + 1;
  paper.downloadRetryAt = 0;
  paper.lastDownloadError = item.error;
  await persist();
  if (item.canResume && chrome.downloads.resume && paper.resumedDownloadId !== item.id) {
    const intentAt = paper.downloadIntentAt;
    paper.downloadResumePending = true;
    paper.resumedDownloadId = item.id;
    await persist();
    try {
      await boundedCall(() => chrome.downloads.resume(item.id), "恢复下载", API_WAIT_MS, () => runEvent(async () => {
        if (activePaper() === paper && paper.downloadIntentAt === intentAt) { paper.downloadResumePending = false; paper.resumeProbeUntil = Date.now() + 2000; await persist(); await reconcileDownload(paper); }
        else await browserApi("downloads", "cancel", item.id).catch(() => {});
      }));
      paper.downloadResumePending = false;
      paper.resumeProbeUntil = Date.now() + 2000;
      paper.downloadProgressAt = Date.now();
      paper.downloadBytesSeen = Math.max(0, Number(item.bytesReceived) || 0);
      await persist();
    } catch (error) {
      if (error.code !== "browser_api_timeout") {
        paper.downloadResumePending = false;
        log(`Chrome 拒绝恢复下载，正在核对旧下载后重试：${error.message || error}`, "warning");
        const latest = (await browserApi("downloads", "search", {id: item.id}))[0];
        if (latest?.state === "complete") await inspectDownloadItem(paper, latest);
        else if (latest?.state === "interrupted" && Date.now() < downloadDeadline(paper)) await restartInterruptedDownload(paper, latest);
        else await persist();
      }
    }
    await schedule(1000);
  } else {
    await restartInterruptedDownload(paper, item);
  }
  return true;
}

async function inspectDownloadItem(paper, item) {
  if (item.state === "complete") {
    const result = verifyDownload(item);
    await finishPaper(paper, result.ok, result.code, result.reason, item);
  } else if (item.state === "interrupted") {
    if (paper.downloadStallCancelledId === item.id) item = {...item, error: "NETWORK_STALLED"};
    if (await recoverInterruptedDownload(paper, item)) return;
    const detail = paper.downloadRetryCount ? `；已自动重试 ${paper.downloadRetryCount} 次` : "";
    await finishPaper(paper, false, item.error === "NETWORK_STALLED" ? "download_stalled" : item.error || "download_interrupted", `浏览器下载中断：${item.error === "NETWORK_STALLED" ? "连续 45 秒没有收到新数据" : item.error || "未知原因"}${detail}。可重试未完成项。`, item);
  } else if (item.paused || !["safe", "accepted", "allowlistedByPolicy", "deepScannedSafe", undefined].includes(item.danger)) {
    if (state.running) await pause("Chrome 下载处于暂停或安全检查状态，请在 chrome://downloads 中处理后继续。");
  } else {
    const received = Math.max(0, Number(item.bytesReceived) || 0);
    if (!paper.downloadProgressAt || received !== paper.downloadBytesSeen) {
      paper.downloadProgressAt = Date.now();
      paper.downloadBytesSeen = received;
      await persist();
    }
    const totalExpired = Date.now() >= downloadDeadline(paper);
    const stalled = Date.now() - paper.downloadProgressAt >= DOWNLOAD_STALL_MS;
    if (!totalExpired && !stalled) return;
    await browserApi("downloads", "cancel", item.id).catch(() => {});
    // cancel may race with completion; always query the final browser state again.
    const latest = (await browserApi("downloads", "search", {id: item.id}))[0];
    if (latest?.state === "complete") {
      const result = verifyDownload(latest);
      await finishPaper(paper, result.ok, result.code, result.reason, latest);
    } else if (latest?.state === "in_progress") {
      await pause("本条下载已超时，但 Chrome 尚未确认取消。请在 chrome://downloads 中处理，确认后继续。");
    } else if (!totalExpired && stalled && latest?.state === "interrupted") {
      paper.downloadStallCancelledId = item.id;
      await persist();
      await inspectDownloadItem(paper, latest);
    } else await finishPaper(paper, false, "download_timeout", "下载超过等待时限，已取消本条并记录；可稍后重试。", latest || item);
  }
}

async function reconcileDownload(paper) {
  if (Date.now() < (paper.downloadCheckAfter || 0)) return;
  let item;
  try {
    if (Number.isInteger(paper.downloadId)) item = (await browserApi("downloads", "search", {id: paper.downloadId}))[0];
    else item = await findIntentDownload(paper);
  } catch (error) {
    paper.downloadCheckAfter = Date.now() + API_WAIT_MS;
    await pause(`无法核对浏览器下载记录，已暂停以避免重复下载：${error.message || error}`);
    return;
  }
  paper.downloadCheckAfter = 0;
  if (!item) {
    if (!Number.isInteger(paper.downloadId) && (Date.now() - paper.downloadIntentAt < 5000 || paper.downloadStartUncertain && Date.now() < downloadDeadline(paper))) {
      await schedule(2000);
      return;
    }
    await finishPaper(paper, false, "download_missing", "未能在 Chrome 下载记录中确认本条。为避免重复下载已记录为未获取，请人工检查后重试。");
    return;
  }
  if (paper.downloadId !== item.id || state.phase !== "downloading") {
    paper.downloadId = item.id;
    state.phase = "downloading";
    await persist();
  }
  if (item.state === "in_progress") {
    paper.downloadResumePending = false;
    paper.downloadStallCancelledId = null;
  }
  await inspectDownloadItem(paper, item);
}

function documentTarget(tabId, documentId) {
  return documentId ? {tabId, documentIds: [documentId]} : {tabId};
}

async function setProgress(message, deadline = state.phaseDeadlineAt) {
  if (state.progressMessage === message && state.phaseDeadlineAt === deadline) return;
  state.progressMessage = message;
  state.phaseDeadlineAt = deadline;
  await persist();
}

async function watchDocument(tabId, documentId) {
  if (state.watchedDocumentId === documentId && documentId) return;
  try {
    await browserApi("scripting", "executeScript", {target: documentTarget(tabId, documentId), func: installPageWatcher, args: [state.watchId], injectImmediately: true});
    state.watchedDocumentId = documentId;
  } catch { /* Navigation can replace the document while the watcher is installed. */ }
}

async function handleChallenge(paper, result, tabId, documentId) {
  if (!state.settings.autoRobotNo || !result.robotNo) {
    await waitForVerification(result.robotNo ? "等待你点击 No；完成后将自动继续当前文献。" : "等待你完成网页验证；完成后将自动继续当前文献。", documentId);
    return;
  }
  if (paper.robotClicks > 0) {
    if (paper.robotDocumentId && documentId !== paper.robotDocumentId) {
      await waitForVerification("再次出现验证页，已停止重复点击。等待你完成验证；之后将自动继续。", documentId);
      return;
    }
    const deadline = paper.robotClickedAt + Math.min(20, state.settings.timeoutSeconds) * 1000;
    await waitForVerification(Date.now() >= deadline ? "已点击 No，但验证仍未完成。等待你手动处理；完成后将自动继续。" : "已点击 No，正在等待网站验证；完成后将自动继续当前文献。", documentId);
    return;
  }
  if (result.readyState !== "complete") {
    await waitForVerification("验证页尚在初始化；你也可以手动点击 No，完成后将自动继续。", documentId);
    return;
  }
  await waitForVerification("已识别网站的 No 按钮，正在执行一次点击。", documentId);
  // Store click intent before dispatch; a suspended worker must not repeatedly click the challenge.
  paper.robotClicks = 1;
  paper.robotDocumentId = documentId;
  paper.robotClickedAt = Date.now();
  state.resultReadyAt = 0;
  state.phaseDeadlineAt = 0;
  state.progressMessage = "已识别网站的 No 按钮，正在执行一次点击。";
  await persist();
  try {
    const click = (await browserApi("scripting", "executeScript", {target: documentTarget(tabId, documentId), func: clickRobotNo, injectImmediately: true}))[0]?.result;
    if (!["clicked", "already_clicked"].includes(click?.status)) {
      await waitForVerification("未能确认 No 按钮点击成功。等待你手动处理；完成后将自动继续。", documentId);
      return;
    }
    log("已对当前文献的验证页点击一次 No，等待网站自己的验证流程。");
    await waitForVerification("已点击 No，正在等待网站验证；完成后将自动继续当前文献。", documentId);
    await schedule(350);
  } catch {
    // The click may already have navigated; never dispatch it a second time.
    await schedule(350);
  }
}

async function inspectActivePage(paper) {
  let tab;
  try { tab = await getTaskTab(); }
  catch (error) {
    if (closedTaskTabs.has(state.tabId)) { state.tabId = null; await pause("任务页已关闭，保留当前文献；点击继续会重新打开同一条。", "tab_closed"); }
    else if (state.waitingForVerification) { await setProgress("任务页暂未响应，保留验证等待；可以暂停或手动重开。", 0); await schedule(1000); }
    else await finishPaper(paper, false, "page_timeout", `读取任务页超时：${error.message}；可重试未完成项。`);
    return;
  }
  if (!tab) {
    await pause("检索标签页已关闭，已取消自动继续。请点击继续或重开当前页；本条尚未记为失败。", "tab_closed");
    state.tabId = null;
    state.phase = "home";
    await persist();
    return;
  }
  const url = tab.url || tab.pendingUrl || "";
  const stageSeconds = state.phase === "result" ? state.settings.resultTimeoutSeconds : state.settings.timeoutSeconds;
  let expired = !state.waitingForVerification && Date.now() >= state.phaseStartedAt + stageSeconds * 1000;
  if (url && !isAllowedPageUrl(url) && !url.startsWith("chrome-error:")) {
    if (isAllowedPageUrl(tab.pendingUrl)) {
      if (expired) await finishPaper(paper, false, "page_timeout", "检索页面未在等待时限内打开，可稍后重试。");
      else await schedule(500);
    } else await pause("检索标签页跳转到了未授权的网站。当前仅允许 sci-hub.box 与已确认的全文页 sci-net.xyz。");
    return;
  }
  let injection;
  try {
    // Reading the document early avoids waiting for slow images or the entire PDF iframe.
    injection = (await browserApi("scripting", "executeScript", {target: {tabId: tab.id}, func: inspectPage, injectImmediately: true}))[0];
  } catch {
    if (closedTaskTabs.has(tab.id)) {
      state.tabId = null;
      await pause("任务页已关闭，保留当前文献；点击继续会重新打开同一条。", "tab_closed");
      return;
    }
    expired = !state.waitingForVerification && Date.now() >= state.phaseStartedAt + stageSeconds * 1000;
    if (state.waitingForVerification) {
      await setProgress("验证页正在跳转或暂时不可读取；页面恢复后将自动继续。", 0);
      await schedule(1000);
    } else if (url.startsWith("chrome-error:")) await finishPaper(paper, false, "page_connection_error", "浏览器报告无法打开网页。");
    else if (expired) await finishPaper(paper, false, "page_timeout", "等待检索页面超时，未确认全文；可稍后重试。");
    else await schedule(500);
    return;
  }
  const result = injection?.result;
  if (closedTaskTabs.has(tab.id)) {
    state.tabId = null;
    await pause("任务页已关闭，保留当前文献；点击继续会重新打开同一条。", "tab_closed");
    return;
  }
  const documentId = injection?.documentId || null;
  // Outgoing pages can stay visible while a POST or home navigation is in progress.
  if (!state.waitingForVerification && result?.kind !== "captcha" && state.blockedDocumentId && (!documentId || documentId === state.blockedDocumentId)) {
    if (expired) await finishPaper(paper, false, "page_timeout", "提交后未能进入新页面，可稍后重试。");
    else await schedule(500);
    return;
  }
  if (!result) {
    if (expired) await finishPaper(paper, false, "page_timeout", "页面尚未提供可读取的内容，可稍后重试。");
    else await schedule(500);
    return;
  }
  if (documentId !== state.currentDocumentId) {
    state.currentDocumentId = documentId;
    state.watchedDocumentId = null;
    await persist();
  }
  await watchDocument(tab.id, documentId);
  if (closedTaskTabs.has(tab.id)) {
    state.tabId = null;
    await pause("任务页已关闭，保留当前文献；点击继续会重新打开同一条。", "tab_closed");
    return;
  }
  if (result.kind === "captcha") { await handleChallenge(paper, result, tab.id, documentId); return; }
  if (state.waitingForVerification) {
    // A blank/loading page is not proof that the user passed verification.
    if (!["home", "pdf", "not_found"].includes(result.kind)) {
      await setProgress("正在等待验证后的输入页或文献结果；识别到后将自动继续。", 0);
      await schedule(1000);
      return;
    }
    const originalPhase = state.verification?.phase || state.phase;
    if (result.kind === "home" && originalPhase === "result") {
      if ((paper.verificationHomeResubmits || 0) >= 1) {
        await pause("验证后反复返回首页，已停止自动重复提交。当前 DOI 和进度已保留，可手动重开当前页。", "automatic");
        return;
      }
      paper.verificationHomeResubmits = (paper.verificationHomeResubmits || 0) + 1;
    }
    paper.robotResolvedAt = Date.now();
    state.waitingForVerification = false;
    state.verification = null;
    state.running = true;
    state.pauseKind = "";
    state.pauseReason = "";
    state.phase = result.kind === "home" ? "home" : originalPhase;
    state.phaseStartedAt = Date.now();
    state.phaseDeadlineAt = Date.now() + (state.phase === "result" ? state.settings.resultTimeoutSeconds : state.settings.timeoutSeconds) * 1000;
    state.resultReadyAt = 0;
    state.blockedDocumentId = null;
    state.progressMessage = "已识别到验证后的页面，正在自动继续当前文献。";
    log(result.kind === "home" && originalPhase === "result" ? "验证后返回首页，自动重新提交同一 DOI（本条最多一次）。" : "验证完成，自动继续同一条文献，保留本轮处理计数。");
    expired = false;
    await persist();
  }
  if (result.kind === "connection_error") { await finishPaper(paper, false, "page_connection_error", result.message); return; }
  if (state.phase === "home") {
    if (result.kind !== "home") {
      if (expired) await finishPaper(paper, false, "page_timeout", "未找到可提交 DOI 的输入页，可稍后重试。");
      else await schedule(500);
      return;
    }
    state.phase = "result";
    state.phaseStartedAt = Date.now();
    state.phaseDeadlineAt = Date.now() + state.settings.resultTimeoutSeconds * 1000;
    state.blockedDocumentId = documentId;
    state.resultReadyAt = 0;
    state.progressMessage = "DOI 已提交，正在等待检索结果。";
    paper.submittedAt = new Date().toISOString();
    await persist();
    try {
      const submitted = (await browserApi("scripting", "executeScript", {target: documentTarget(tab.id, documentId), func: submitDoi, args: [paper.doi], injectImmediately: true}))[0]?.result;
      if (submitted?.ok === false) await finishPaper(paper, false, "form_unavailable", submitted.reason || "无法提交 DOI。");
      else await schedule(350);
    } catch { await schedule(350); }
    return;
  }
  if (result.kind === "pdf") { await startDownload(paper, result.url); return; }
  if (result.kind === "not_found") { await finishPaper(paper, false, "not_found", result.message); return; }
  if (!state.resultReadyAt) state.resultReadyAt = Date.now();
  const deadline = state.phaseStartedAt + state.settings.resultTimeoutSeconds * 1000;
  if (Date.now() >= deadline) {
    await finishPaper(paper, false, "detection_timeout", "结果页在识别时限内未出现全文地址或明确未收录提示；已跳过，可重试，不代表网站未收录。");
    return;
  }
  await setProgress("结果页已打开，正在识别全文地址；到时将记录原因并继续下一条。", deadline);
  await schedule(500);
}

async function pump() {
  let paper = activePaper();
  if (state.recoveryIntent && (!paper || state.recoveryIntent.paperId !== paper.id || paper.status !== "searching")) {
    state.recoveryIntent = null;
    await persist();
  }
  if (state.running && state.recoveryIntent) { await completePageRecovery(); return; }
  if (paper?.status === "downloading") {
    await reconcileDownload(paper);
    if (state.activeId) { if (state.running) await schedule(2000); return; }
  }
  if (state.waitingForVerification && state.pauseKind === "verification") {
    if (!paper || paper.status !== "searching") {
      await pause("验证等待已结束，请检查当前队列后继续。", "automatic");
      return;
    }
    await inspectActivePage(paper);
    if (state.waitingForVerification && state.settings.autoReopenVerification &&
        (paper.automaticPageRecoveries || 0) < 1 &&
        Date.now() - (state.verification?.startedAt || Date.now()) >= state.settings.verificationReopenSeconds * 1000) {
      await reopenCurrent(true);
    }
    return;
  }
  if (!state.running) return;
  paper = activePaper();
  if (!paper) {
    if (state.nextAt > Date.now()) { await schedule(state.nextAt - Date.now()); return; }
    await startNext();
  } else if (paper.status === "searching") {
    if (paper.pdfUrl) { await startDownload(paper, paper.pdfUrl); return; }
    if (state.tabId === null) await navigateHome(paper);
    else await inspectActivePage(paper);
  }
}

async function skipCurrent() {
  const paper = activePaper();
  if (!paper) return;
  if (paper.status === "downloading") {
    await reconcileDownload(paper);
    if (state.activeId !== paper.id) return;
    if (!Number.isInteger(paper.downloadId)) {
      await pause("尚未确认浏览器下载编号，暂不能安全跳过。请稍后再试或检查下载记录。");
      return;
    }
    await browserApi("downloads", "cancel", paper.downloadId).catch(() => {});
    const item = (await browserApi("downloads", "search", {id: paper.downloadId}))[0];
    if (item?.state === "complete") {
      const result = verifyDownload(item);
      await finishPaper(paper, result.ok, result.code, result.reason, item);
      return;
    }
    if (item?.state === "in_progress") {
      await pause("Chrome 尚未确认取消当前下载，因此保留当前条。请在下载记录中处理后再跳过。");
      return;
    }
  }
  await finishPaper(paper, false, "skipped_by_user", "用户主动跳过当前条，可稍后重试；不代表网站未收录。");
}

async function handleMessage(message) {
  switch (message?.type) {
    case "GET_STATE":
      if (activePaper()?.status === "downloading") await reconcileDownload(activePaper());
      return {ok: true, state};
    case "START_FROM": {
      const number = message.startFromNumber;
      if (!Number.isInteger(number) || number < 1 || number > state.papers.length) throw new Error(`起点应为 1–${state.papers.length} 之间的整数（当前列表位置）。`);
      const settings = normalizeSettings({...state.settings, ...message.settings});
      if (state.running || state.waitingForVerification) throw new Error("请先暂停当前队列，再修改下载起点。");
      const current = activePaper();
      if (state.papers.some(paper => paper.status === "downloading")) throw new Error("当前浏览器下载仍未结束，请先完成或安全跳过当前下载，再修改起点。");
      // Validate every input before touching queue state. Earlier records retain their own status.
      if (current?.status === "searching") {
        current.lastInterruptedSearch = {startedAt: current.startedAt || "", phase: state.phase, reason: "用户调整下载起点"};
        current.status = "pending";
        current.reason = "调整起点时暂存了未完成的检索，仍属待处理记录。";
        current.reasonCode = "";
      }
      state.startFromNumber = number;
      state.runPaperIds = null;
      state.settings = settings;
      state.activeId = null;
      state.phase = "idle";
      state.phaseStartedAt = 0;
      state.phaseDeadlineAt = 0;
      state.waitingForVerification = false;
      state.verification = null;
      state.recoveryIntent = null;
      state.resultReadyAt = 0;
      state.blockedDocumentId = null;
      state.watchedDocumentId = null;
      state.watchId = null;
      log(`下载范围设为当前列表第 ${number} 条至第 ${state.papers.length} 条；保留现有结果及原始文献编号。`);
      return handleMessage({type: "START", limit: 0});
    }
    case "START": {
      if (state.running) return {ok: true, state};
      if (state.waitingForVerification) { await pump(); return {ok: true, state}; }
      const limit = Number(message.limit ?? state.limit);
      if (![0, 3, 10].includes(limit)) throw new Error("单次处理数量应为 3、10 或 0（全部）。");
      state.settings = normalizeSettings({...state.settings, ...message.settings});
      state.limit = limit;
      state.processedThisRun = 0;
      state.runId += 1;
      state.running = true;
      state.waitingForVerification = false;
      state.verification = null;
      state.pauseKind = "";
      state.pauseReason = "";
      state.lastError = "";
      state.consecutiveConnectionFailures = 0;
      state.nextAt = 0;
      state.phaseStartedAt = Date.now();
      state.phaseDeadlineAt = Date.now() + (state.phase === "result" ? state.settings.resultTimeoutSeconds : state.settings.timeoutSeconds) * 1000;
      state.resultReadyAt = 0;
      const paper = activePaper();
      if (paper?.status === "searching") {
        try { if (!await getTaskTab()) state.tabId = null; }
        catch { /* The bounded page loop will record the unavailable tab. */ }
      }
      if (paper && !state.watchId) state.watchId = `${paper.id}:${paper.attempts}:${paper.startedAt}`;
      state.watchedDocumentId = null;
      if (paper?.status === "downloading") {
        paper.downloadIntentAt = paper.downloadIntentAt || Date.now();
        // User-initiated Continue grants a fresh finite budget to a transfer that
        // was interrupted while paused; automatic recoveries never reset it.
        paper.downloadBudgetStartedAt = Date.now();
        paper.downloadCheckAfter = 0;
        paper.downloadRetryCount = 0;
        paper.downloadRetryAt = 0;
        state.phaseDeadlineAt = downloadDeadline(paper);
      }
      log(`开始本轮，数量：${limit || "全部待处理"}。`);
      await persist();
      await pump();
      return {ok: true, state};
    }
    case "PAUSE":
      await pause("已手动暂停，自动继续与自动重开均已取消；正在进行的浏览器下载会继续核对。", "user");
      return {ok: true, state};
    case "SKIP_CURRENT":
      await skipCurrent();
      return {ok: true, state};
    case "REOPEN_CURRENT":
      await reopenCurrent(false);
      return {ok: true, state};
    case "RETRY_UNFINISHED": {
      if (state.running || state.waitingForVerification) throw new Error("请先暂停当前队列，再重试未完成项。");
      const settings = normalizeSettings({...state.settings, ...message.settings});
      if (activePaper()?.status === "downloading") await reconcileDownload(activePaper());
      let count = 0;
      const failedOnly = message.scope === "failed";
      const interruptedSearch = activePaper();
      if (failedOnly && interruptedSearch?.status === "searching") {
        interruptedSearch.status = "pending";
        interruptedSearch.reason = "仅重试失败项时暂存了当前未完成检索，可继续所有未完成项。";
        interruptedSearch.lastInterruptedSearch = {startedAt: interruptedSearch.startedAt || "", phase: state.phase};
        state.activeId = null;
      }
      const retryIds = [];
      for (const paper of state.papers) {
        if (paper.status === "success" || !hasDownloadTarget(paper) || failedOnly && paper.status !== "failed") continue;
        count += 1;
        retryIds.push(paper.id);
        if (paper.status === "downloading") continue;
        if (paper.status !== "pending") paper.lastFailure = {reason: paper.reason, reasonCode: paper.reasonCode, downloadId: paper.downloadId, filename: paper.filename};
        paper.status = "pending";
        paper.reason = ""; paper.reasonCode = ""; paper.downloadId = null;
        if (state.activeId === paper.id) state.activeId = null;
      }
      state.settings = settings;
      state.startFromNumber = 1;
      state.runPaperIds = failedOnly ? retryIds : null;
      if (!state.activeId) {
        state.phase = "idle"; state.phaseDeadlineAt = 0; state.recoveryIntent = null;
        state.currentDocumentId = null; state.blockedDocumentId = null; state.watchedDocumentId = null;
      }
      log(`重新处理 ${count} 条${failedOnly ? "失败" : "未完成"}记录；已成功记录保留，正在下载的文件继续跟踪。`);
      await persist();
      const result = await handleMessage({type: "START", limit: 0, keepSelection: true});
      return {...result, count};
    }
    case "RETRY_FAILED": {
      if (state.running || state.activeId) throw new Error("请先等待当前文献结束，再重置失败项；暂停后可继续处理当前文献。");
      let count = 0;
      for (const paper of state.papers) {
        if (paper.status !== "failed" || !hasDownloadTarget(paper)) continue;
        paper.lastFailure = {reason: paper.reason, reasonCode: paper.reasonCode, downloadId: paper.downloadId, filename: paper.filename};
        paper.status = "pending";
        paper.reason = "";
        paper.reasonCode = "";
        paper.downloadId = null;
        count += 1;
      }
      log(`已将 ${count} 条失败记录重新加入待处理队列，请点击开始。`);
      await persist();
      return {ok: true, state};
    }
    case "UPDATE_SETTINGS":
      if (state.running) throw new Error("请暂停后修改设置。");
      state.settings = normalizeSettings({...state.settings, ...message.settings});
      await persist();
      return {ok: true, state};
    case "IMPORT": {
      const blocked = importBlockedReason(state);
      if (blocked) throw new Error(blocked);
      normalizePapers(message.papers);
      const previous = state;
      const next = createInitialState({papers: message.papers, sourceName: message.sourceName || "导入的文献清单"});
      const carried = carryCompletedImports(next.papers, previous);
      next.papers = carried.papers;
      next.completedPapers = carried.completedPapers;
      next.settings = previous.settings;
      state = next;
      log(`已导入 ${state.papers.length} 条文献，保留 ${carried.restoredCount} 条已成功记录。`);
      try { await persist(); } catch (error) { state = previous; throw error; }
      clearTimeout(wakeTimer);
      await browserApi("alarms", "clear", WAKE).catch(() => {});
      return {ok: true, state};
    }
    default: throw new Error("无法识别的操作。");
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type === "PAGE_CHANGED") {
    if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || !isAllowedPageUrl(sender.url)) return false;
    enqueue(async () => {
      const observing = state.running || state.waitingForVerification;
      const active = observing && sender.tab?.id === state.tabId && message.watchId === state.watchId &&
        activePaper()?.status === "searching" && sender.documentId === state.currentDocumentId &&
        (state.waitingForVerification || sender.documentId !== state.blockedDocumentId);
      if (active) await pump();
      return {active: Boolean(active && (state.running || state.waitingForVerification) && activePaper()?.status === "searching")};
    }).then(respond, () => respond({active: false}));
    return true;
  }
  // Only the extension's own dashboard may control the queue.
  if (sender.id !== chrome.runtime.id || (sender.url && !sender.url.startsWith(chrome.runtime.getURL("")))) return false;
  enqueue(() => handleMessage(message)).then(respond, error => respond({ok: false, error: error.message || String(error)}));
  return true;
});
chrome.action.onClicked.addListener(() => chrome.tabs.create({url: chrome.runtime.getURL("dashboard.html")}));
chrome.alarms.onAlarm.addListener(alarm => { if ([WATCHDOG, WAKE].includes(alarm.name)) runEvent(pump); });
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === "complete" || change.status === "loading" || change.url) runEvent(async () => { if (tabId === state.tabId) await pump(); });
});
const navigationFilter = {url: [{schemes: ["https"], hostEquals: "sci-hub.box"}, {schemes: ["https"], hostEquals: "sci-net.xyz"}]};
for (const event of [chrome.webNavigation.onCommitted, chrome.webNavigation.onDOMContentLoaded]) {
  event.addListener(details => {
    if (details.frameId === 0) runEvent(async () => { if (details.tabId === state.tabId) await pump(); });
  }, navigationFilter);
}
chrome.webNavigation.onErrorOccurred.addListener(details => {
  if (details.frameId !== 0 || details.error === "net::ERR_ABORTED") return;
  runEvent(async () => {
    const paper = activePaper();
    if (state.running && details.tabId === state.tabId && paper?.status === "searching" && details.documentId &&
        details.documentId === state.currentDocumentId && details.documentId !== state.blockedDocumentId) {
      await finishPaper(paper, false, "page_connection_error", `检索页面加载失败：${details.error || "浏览器网络错误"}`);
    }
  });
}, navigationFilter);
chrome.tabs.onRemoved.addListener(tabId => {
  // Record the browser fact immediately: the serialized page read may currently
  // be waiting. When it times out it must preserve, not fail, the closed paper.
  if (tabId === state?.tabId) closedTaskTabs.add(tabId);
  runEvent(async () => {
    closedTaskTabs.delete(tabId);
    if (tabId !== state.tabId) return;
    state.tabId = null;
    if ((state.running || state.waitingForVerification) && activePaper()?.status === "searching") await pause("检索标签页已关闭，自动继续与自动重开均已取消；当前文献未记为失败。点击继续可重新打开。", "tab_closed");
    else await persist();
  });
});
chrome.downloads.onCreated.addListener(item => runEvent(async () => {
  const paper = activePaper();
  if (paper?.status === "downloading" && !Number.isInteger(paper.downloadId) && matchesUnclaimedIntent(item, paper)) {
    paper.downloadId = item.id;
    state.phase = "downloading";
    await persist();
    await inspectDownloadItem(paper, item);
  }
}));
chrome.downloads.onChanged.addListener(delta => runEvent(async () => {
  const paper = activePaper();
  if (paper?.status === "downloading" && paper.downloadId === delta.id) { await reconcileDownload(paper); if (state.running && !state.activeId) await pump(); }
}));
chrome.runtime.onStartup.addListener(() => runEvent(async () => {
  if (state.running || state.waitingForVerification) await pause("浏览器已重新启动，自动继续与自动重开均已取消。请点击继续；正在下载的文件仍会核对结果。", "browser_restart");
  if (activePaper()?.status === "downloading") await reconcileDownload(activePaper());
}));
chrome.runtime.onInstalled.addListener(() => runEvent(async () => {
  if (state.running || state.waitingForVerification) await pause("扩展已安装或更新，请点击继续。", "browser_restart");
}));

// Restore alarms and reconcile an interrupted worker, but the session check pauses browser restarts.
runEvent(pump);
