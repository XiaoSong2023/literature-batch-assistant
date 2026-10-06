export const DEFAULT_SETTINGS = Object.freeze({
  siteUrl: "https://sci-hub.box/",
  delaySeconds: 1,
  timeoutSeconds: 25,
  resultTimeoutSeconds: 12,
  downloadTimeoutSeconds: 300,
  autoRobotNo: true,
  autoReopenVerification: true,
  verificationReopenSeconds: 45,
});

export function normalizeDoi(value) {
  let doi = String(value ?? "").trim().replace(/^doi\s*:\s*/i, "");
  if (/^https?:\/\/(?:dx\.)?doi\.org\//i.test(doi)) {
    doi = doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
    try { doi = decodeURIComponent(doi); } catch { /* Keep literal percent signs. */ }
  }
  doi = doi.trim();
  return /^10\.\d{4,9}(?:\.\d+)*\/\S+$/i.test(doi) ? doi : "";
}

// Preserve path/query case and signed parameters. A DOI resolver URL remains a DOI.
export function normalizeHttpUrl(value) {
  const text = String(value ?? "").trim();
  if (!text || /[\s\u0000-\u001f\u007f]/.test(text)) return "";
  try {
    const url = new URL(text);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
}

export function getPdfUrl(source) {
  for (const value of [source.pdfUrl, source.fullTextUrl, source.url]) {
    const url = normalizeHttpUrl(value);
    if (url && !normalizeDoi(url)) return url;
  }
  return "";
}

export function hasDownloadTarget(paper) { return Boolean(normalizeDoi(paper.doi) || getPdfUrl(paper)); }

// A paused search has no live file transfer. It can be replaced by an import;
// running work and downloads must keep their current queue until stopped.
export function importBlockedReason(state) {
  if (!state) return "正在加载队列，请稍候。";
  if (state.running || state.waitingForVerification) return "请先点击上方“暂停队列”，再导入新清单。";
  if (state.papers?.some(paper => paper.status === "downloading")) return "当前浏览器下载尚未结束。请等待下载完成，或点击上方“跳过当前条目”结束当前下载后再导入。";
  return "";
}

// Different abstracts may share a book DOI or PDF. Only identical titles and
// identifiers are duplicates. Unnamed records match only other unnamed records.
export function paperImportKey(paper) {
  const title = String(paper.title || "未提供标题").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
  const doi = normalizeDoi(paper.doi);
  const target = doi ? `doi:${doi.toLowerCase()}` : getPdfUrl(paper) ? `url:${getPdfUrl(paper)}` : "";
  return target ? JSON.stringify([target, title]) : "";
}

function completedKeys(paper) {
  const title = String(paper.title || "未提供标题").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
  const doi = normalizeDoi(paper.doi), pdfUrl = getPdfUrl(paper);
  return [doi && JSON.stringify([`doi:${doi.toLowerCase()}`, title]), pdfUrl && JSON.stringify([`url:${pdfUrl}`, title])].filter(Boolean);
}

// Only this extension's existing local state can carry completion into an import.
// Imported status fields are not evidence that a file has been downloaded.
export function carryCompletedImports(papers, currentState) {
  const history = new Map();
  for (const paper of [...(currentState.completedPapers || []), ...(currentState.papers || [])]) {
    if (paper.status !== "success" || !hasDownloadTarget(paper)) continue;
    const saved = {};
    for (const key of ["title", "doi", "pdfUrl", "status", "attempts", "downloadId", "filename", "completedAt", "finishedAt", "reason", "reasonCode", "downloadUrl"]) {
      if (paper[key] !== undefined) saved[key] = paper[key];
    }
    history.set(paperImportKey(saved), saved);
  }
  const completedPapers = [...history.values()], byKey = new Map();
  for (const paper of completedPapers) for (const key of completedKeys(paper)) byKey.set(key, paper);
  let restoredCount = 0;
  const restored = papers.map(paper => {
    const match = completedKeys(paper).map(key => byKey.get(key)).find(Boolean);
    if (!match) return paper;
    restoredCount++;
    const result = {...paper};
    for (const key of ["status", "attempts", "downloadId", "filename", "completedAt", "finishedAt", "downloadUrl"]) {
      if (match[key] !== undefined) result[key] = match[key];
    }
    result.reason = "本扩展已有相同题名及 DOI / PDF 链接的成功记录，已保留，不重复下载。";
    result.reasonCode = "";
    return result;
  });
  return {papers: restored, completedPapers, restoredCount};
}

export function normalizePapers(papers) {
  if (!Array.isArray(papers) || !papers.length || papers.length > 20000) throw new Error("请导入 1–20000 条文献记录。");
  const seen = new Set();
  return papers.map((source, index) => {
    if (!source || typeof source !== "object") throw new Error(`第 ${index + 1} 条记录格式不正确。`);
    const doi = normalizeDoi(source.doi);
    const pdfUrl = getPdfUrl(source);
    const eligible = Boolean(doi || pdfUrl);
    const sourceIndex = Number.isInteger(Number(source.sourceIndex)) && Number(source.sourceIndex) > 0 ? String(source.sourceIndex) : String(index + 1);
    let id = String(source.id ?? `paper-${sourceIndex}`).slice(0, 100);
    if (!id || seen.has(id)) id = `paper-${index + 1}-${seen.size + 1}`;
    while (seen.has(id)) id += "-x";
    seen.add(id);
    return {
      id, sourceIndex,
      title: String(source.title ?? "未提供标题").trim().slice(0, 2000) || "未提供标题",
      doi, originalDoi: String(source.doi ?? "").slice(0, 500),
      pdfUrl, landingUrl: normalizeHttpUrl(source.landingUrl),
      sourceStatus: String(source.sourceStatus ?? "").slice(0, 500),
      sourceFile: String(source.sourceFile ?? "").slice(0, 500),
      sourceRow: String(source.sourceRow ?? "").slice(0, 100),
      rawCitation: String(source.rawCitation ?? "").slice(0, 6000),
      status: eligible ? "pending" : "missing_doi", attempts: 0,
      reason: eligible ? "" : "缺少可用 DOI / PDF 直链，未尝试下载；普通网页入口需人工打开。",
      reasonCode: eligible ? "" : "missing_doi", downloadId: null, filename: "",
    };
  });
}

export function normalizeSettings(settings = {}) {
  const number = (key, min, max) => {
    const value = settings[key] === undefined ? DEFAULT_SETTINGS[key] : Number(settings[key]);
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${key} 应在 ${min}–${max} 之间。`);
    return Math.round(value * 100) / 100;
  };
  const url = new URL(settings.siteUrl || DEFAULT_SETTINGS.siteUrl);
  if (url.origin !== "https://sci-hub.box" || url.username || url.password) throw new Error("检索首页固定为 https://sci-hub.box/；sci-net.xyz 用于读取全文结果页。");
  return {siteUrl: DEFAULT_SETTINGS.siteUrl, delaySeconds: number("delaySeconds", 0.25, 120), timeoutSeconds: number("timeoutSeconds", 5, 300), resultTimeoutSeconds: number("resultTimeoutSeconds", 2, 120), downloadTimeoutSeconds: number("downloadTimeoutSeconds", 30, 1800), autoRobotNo: settings.autoRobotNo === undefined ? true : settings.autoRobotNo === true, autoReopenVerification: settings.autoReopenVerification === undefined ? true : settings.autoReopenVerification === true, verificationReopenSeconds: number("verificationReopenSeconds", 15, 300)};
}

// Keep completed downloads and attempts intact when upgrading the queue.
export function migrateState(state) {
  state.completedPapers ??= [];
  for (const paper of state.papers) {
    paper.pdfUrl = getPdfUrl(paper);
    paper.landingUrl = normalizeHttpUrl(paper.landingUrl);
    if (paper.status === "missing_doi" && hasDownloadTarget(paper)) {
      paper.status = "pending";
      paper.reason = "";
      paper.reasonCode = "";
    }
  }
  if (state.settingsVersion !== 2) {
    const settings = {...state.settings};
    if (settings.delaySeconds === 8) settings.delaySeconds = DEFAULT_SETTINGS.delaySeconds;
    if (settings.timeoutSeconds === 90) settings.timeoutSeconds = DEFAULT_SETTINGS.timeoutSeconds;
    state.settings = normalizeSettings(settings);
    state.settingsVersion = 2;
  } else state.settings = normalizeSettings(state.settings);
  state.progressMessage ??= "";
  state.phaseDeadlineAt ??= 0;
  state.currentDocumentId ??= null;
  state.blockedDocumentId ??= null;
  state.resultReadyAt ??= 0;
  const legacyVerification = state.waitingForVerification === undefined && !state.pauseKind && !state.running &&
    state.papers.some(paper => paper.id === state.activeId && paper.status === "searching") &&
    /^(?:页面要求验证码或人工验证|此验证需要人工处理|点击 No 后再次出现验证页|已点击 No，但网站验证仍未完成|验证页尚未加载完整，无法确认 No 按钮已就绪|未能确认 No 按钮可以点击)/.test(state.pauseReason || "");
  state.waitingForVerification ??= legacyVerification;
  state.pauseKind ??= legacyVerification ? "verification" : "";
  state.verification ??= legacyVerification ? {phase: state.phase, documentId: state.currentDocumentId, startedAt: Date.now()} : null;
  state.recoveryIntent ??= null;
  if (!Number.isInteger(state.startFromNumber) || state.startFromNumber < 1 || state.startFromNumber > state.papers.length) state.startFromNumber = 1;
  if (legacyVerification) {
    state.phaseDeadlineAt = 0;
    state.pauseReason = "等待你完成网页验证；完成后将自动继续当前文献。";
    state.progressMessage = state.pauseReason;
  }
  state.controlVersion = 3;
  return state;
}

export function sanitizeFilename(paper) {
  const clean = (value, limit) => String(value ?? "").normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_")
    .replace(/\.{2,}/g, "_").replace(/\s+/g, " ").replace(/[. ]+$/g, "").slice(0, limit).replace(/[. ]+$/g, "");
  const index = String(paper.sourceIndex || 0).padStart(4, "0");
  const doiPart = paper.doi ? `_${clean(paper.doi, 65)}` : "";
  return `LiteratureBatch/${index}_${clean(paper.title, 72) || "paper"}${doiPart}.pdf`;
}

export function createInitialState(bundle) {
  return {
    schemaVersion: 1, settingsVersion: 2, sourceName: String(bundle.sourceName || "文献清单"), importedAt: bundle.importedAt || new Date().toISOString(),
    papers: bundle.papers?.length ? normalizePapers(bundle.papers) : [], completedPapers: [], running: false, activeId: null,
    processedThisRun: 0, limit: 3, settings: {...DEFAULT_SETTINGS},
    log: [], updatedAt: new Date().toISOString(), tabId: null, phase: "idle",
    runId: 0, consecutiveConnectionFailures: 0, nextAt: 0, phaseStartedAt: 0,
    pauseReason: "", lastError: "", progressMessage: "", phaseDeadlineAt: 0,
    currentDocumentId: null, blockedDocumentId: null, resultReadyAt: 0,
    controlVersion: 3, waitingForVerification: false, pauseKind: "", verification: null, recoveryIntent: null, startFromNumber: 1,
  };
}

export function verifyDownload(item) {
  if (!item) return {ok: false, code: "download_missing", reason: "浏览器下载记录已不存在，无法确认文件。"};
  if (item.state !== "complete") return {ok: false, code: "download_incomplete", reason: `下载未完成：${item.error || item.state || "未知状态"}`};
  if (item.exists === false) return {ok: false, code: "file_missing", reason: "下载曾完成，但文件已被删除或移动。"};
  const mime = String(item.mime || "").split(";")[0].trim().toLowerCase();
  if (!["application/pdf", "application/x-pdf"].includes(mime)) return {ok: false, code: "unverified_file_type", reason: `文件已下载，但 MIME 为 ${mime || "未知"}，不能确认是 PDF；请人工检查。`};
  const size = Number(item.fileSize >= 0 ? item.fileSize : item.bytesReceived);
  if (!Number.isFinite(size) || size < 1024) return {ok: false, code: "file_too_small", reason: `文件大小异常（${Number.isFinite(size) ? size : "未知"} 字节），不能确认是论文全文。`};
  return {ok: true, code: "", reason: "浏览器已确认下载完成，PDF MIME 与文件大小检查通过。"};
}

export function matchDownloadIntent(item, paper, extensionId) {
  if (!item || !paper?.downloadIntentAt || item.byExtensionId !== extensionId) return false;
  const start = Date.parse(item.startTime);
  return Number.isFinite(start) && start >= paper.downloadIntentAt - 1000 &&
    (item.url === paper.downloadUrl || item.finalUrl === paper.downloadUrl);
}

export function isConnectionFailure(reasonCode) {
  return ["navigation_error", "page_timeout", "page_connection_error", "download_start_error", "download_timeout", "download_history_error"].includes(reasonCode) || /^(?:NETWORK_|SERVER_)/.test(reasonCode || "");
}
