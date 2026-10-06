// Local-only, top-level PDF cleanup. The UI obtains the directory handle in a
// user gesture and asks for readwrite permission only for an explicit deletion.
// https://developer.chrome.com/docs/capabilities/web-apis/file-system-access
// https://fs.spec.whatwg.org/#api-filesystemdirectoryhandle-removeentry
// https://www.w3.org/TR/webcrypto/#SubtleCrypto-method-digest
// WebCrypto digest is not streaming: process one file at a time and cap memory.
export const MAX_DEDUP_FILE_BYTES = 128 * 1024 * 1024;

const activeDeletions = new WeakSet();
const key = name => name.toLowerCase();
const validName = name => typeof name === 'string' && name.length > 0 &&
  name !== '.' && name !== '..' && !/[\\/:\u0000-\u001f\u007f]/.test(name);

function copyInfo(name) {
  if (!validName(name) || !/\.pdf$/i.test(name)) return null;
  const extension = name.slice(-4);
  let stem = name.slice(0, -4), count = 0;
  while (/[ \t]*\([1-9]\d*\)$/.test(stem)) {
    stem = stem.replace(/[ \t]*\([1-9]\d*\)$/, '');
    count++;
  }
  return count && stem.trim() ? {originalName: stem + extension} : null;
}

function stopIfAborted(signal, result) {
  if (!signal?.aborted) return;
  const error = new DOMException('操作已停止，已完成的删除不会撤销。', 'AbortError');
  error.result = result;
  throw error;
}

function issue(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function errorRecord(name, error, originalName) {
  const messages = {
    NotAllowedError: '没有文件夹读写权限，请重新选择并授权。',
    NotFoundError: '文件已移动或不存在，已保留其余文件。',
    NotReadableError: '文件正在变化或无法读取，请下载结束后重试。',
    TypeMismatchError: '此名称已变为文件夹，已跳过。',
  };
  return {name, ...(originalName ? {originalName} : {}),
    code: (typeof error.code === 'string' && error.code) || error.name || 'READ_ERROR',
    reason: messages[error.name] || error.message || '无法处理该文件。'};
}

function checkDirectory(directoryHandle, deleting = false) {
  if (!directoryHandle || directoryHandle.kind !== 'directory' ||
    typeof directoryHandle.entries !== 'function' ||
    typeof directoryHandle.getFileHandle !== 'function' ||
    (deleting && typeof directoryHandle.removeEntry !== 'function')) {
    throw new TypeError('请先选择本地下载文件夹。');
  }
  if (!globalThis.crypto?.subtle) throw new Error('当前浏览器不支持安全的 SHA-256 校验。');
}

async function fingerprint(directoryHandle, name, {signal, result, cache} = {}) {
  stopIfAborted(signal, result);
  const handle = await directoryHandle.getFileHandle(name);
  const file = await handle.getFile();
  stopIfAborted(signal, result);
  if (!Number.isSafeInteger(file.size) || file.size <= 0) throw issue('EMPTY_FILE', '空文件或无效文件，已保留。');
  if (file.size > MAX_DEDUP_FILE_BYTES) throw issue('TOO_LARGE', '文件超过 128 MB，已保留。');
  const cached = cache?.get(name);
  if (cached && cached.size === file.size && cached.lastModified === file.lastModified) return cached;
  const bytes = await file.arrayBuffer();
  stopIfAborted(signal, result);
  if (bytes.byteLength !== file.size) throw issue('FILE_CHANGED', '读取期间文件发生变化，已保留。');
  const header = new TextDecoder('ascii').decode(new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 1024)));
  if (!/^[\t\n\f\r ]*%PDF-\d\.\d/.test(header)) throw issue('NOT_PDF', '没有有效 PDF 文件头，已保留。');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  stopIfAborted(signal, result);
  const current = await handle.getFile();
  if (file.size !== current.size || file.lastModified !== current.lastModified) {
    throw issue('FILE_CHANGED', '读取期间文件发生变化，已保留。');
  }
  const value = {size: file.size, lastModified: file.lastModified,
    hash: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')};
  cache?.set(name, value);
  return value;
}

async function listFiles(directoryHandle, {signal, result, onProgress} = {}) {
  const files = new Map();
  let entries = 0;
  for await (const [name, handle] of directoryHandle.entries()) {
    stopIfAborted(signal, result);
    entries++;
    if (handle.kind === 'file' && validName(name)) {
      const matches = files.get(key(name)) || [];
      matches.push(name);
      files.set(key(name), matches);
    } else if (handle.kind === 'directory' && result && 'ignoredDirectories' in result) {
      result.ignoredDirectories++;
    }
    if (entries % 100 === 0) onProgress?.({phase: 'listing', entries});
  }
  stopIfAborted(signal, result);
  return files;
}

/** Read-only scan; candidates are serializable snapshots, never file handles. */
export async function scanDuplicatePdfs(directoryHandle, {onProgress, signal} = {}) {
  checkDirectory(directoryHandle);
  const result = {candidates: [], scanned: 0, numberedCopies: 0, skipped: [],
    totalBytes: 0, ignoredFiles: 0, ignoredDirectories: 0};
  stopIfAborted(signal, result);
  const files = await listFiles(directoryHandle, {signal, result, onProgress});
  const cache = new Map();
  const names = Array.from(files.values()).flat().sort((a, b) => a.localeCompare(b));
  for (const name of names) {
    stopIfAborted(signal, result);
    if (!/\.pdf$/i.test(name)) { result.ignoredFiles++; continue; }
    result.scanned++;
    const info = copyInfo(name);
    if (!info) continue;
    result.numberedCopies++;
    const originals = files.get(key(info.originalName));
    let originalName;
    try {
      if (files.get(key(name)).length !== 1 || originals?.length > 1) {
        throw issue('AMBIGUOUS_NAME', '存在仅大小写不同的重名文件，已保留。');
      }
      if (!originals?.length) throw issue('NO_ORIGINAL', '未找到无编号原文件，已保留。');
      originalName = originals[0];
      onProgress?.({phase: 'hashing', name, originalName, scanned: result.scanned,
        numberedCopies: result.numberedCopies, candidates: result.candidates.length});
      const original = await fingerprint(directoryHandle, originalName, {signal, result, cache});
      const copy = await fingerprint(directoryHandle, name, {signal, result});
      if (original.size !== copy.size || original.hash !== copy.hash) {
        throw issue('DIFFERENT_CONTENT', '与原文件内容不同，已保留。');
      }
      result.candidates.push({name, originalName, size: copy.size, hash: copy.hash});
      result.totalBytes += copy.size;
    } catch (error) {
      if (signal?.aborted || error.name === 'AbortError') { stopIfAborted(signal, result); throw error; }
      result.skipped.push(errorRecord(name, error, originalName));
    }
    onProgress?.({phase: 'scanning', name, scanned: result.scanned,
      numberedCopies: result.numberedCopies, candidates: result.candidates.length});
  }
  stopIfAborted(signal, result);
  onProgress?.({phase: 'scan-complete', scanned: result.scanned,
    numberedCopies: result.numberedCopies, candidates: result.candidates.length});
  return result;
}

function validCandidate(candidate) {
  if (!candidate || !validName(candidate.name) || !validName(candidate.originalName)) return false;
  const info = copyInfo(candidate.name);
  return info && !copyInfo(candidate.originalName) && key(candidate.name) !== key(candidate.originalName) &&
    key(info.originalName) === key(candidate.originalName) &&
    Number.isSafeInteger(candidate.size) && candidate.size > 0 && candidate.size <= MAX_DEDUP_FILE_BYTES &&
    typeof candidate.hash === 'string' && /^[a-f0-9]{64}$/.test(candidate.hash);
}

/** Permanent removal only after the UI's explicit review/delete action.
 * Re-hash BOTH files for every deletion; no scan-time hash cache is trusted.
 * File System Access has no atomic compare-and-delete: do not use while another
 * application is modifying these files. A final metadata check narrows that race.
 */
export async function deleteDuplicatePdfs(directoryHandle, candidates, {onProgress, signal} = {}) {
  checkDirectory(directoryHandle, true);
  if (!Array.isArray(candidates)) throw new TypeError('请先扫描重复文件。');
  if (activeDeletions.has(directoryHandle)) throw new Error('该文件夹正在清理，请等待完成。');
  activeDeletions.add(directoryHandle);
  const result = {deleted: [], skipped: [], failed: [], bytesFreed: 0};
  try {
    stopIfAborted(signal, result);
    const files = await listFiles(directoryHandle, {signal, result});
    const seen = new Set();
    let completed = 0;
    for (const input of candidates) {
      stopIfAborted(signal, result);
      const candidate = input && {...input};
      let name = typeof candidate?.name === 'string' ? candidate.name : '(无效文件名)';
      try {
        if (!validCandidate(candidate)) throw issue('INVALID_CANDIDATE', '无效或不安全的待清理记录，已跳过。');
        const {originalName, size, hash} = candidate;
        if (seen.has(key(name))) throw issue('DUPLICATE_REQUEST', '重复的待清理记录，已跳过。');
        seen.add(key(name));
        if (files.get(key(name))?.length !== 1 || files.get(key(originalName))?.length !== 1) {
          throw issue('NAME_CHANGED', '文件不存在或存在大小写重名，请重新扫描。');
        }
        onProgress?.({phase: 'verifying', name, completed, total: candidates.length,
          deleted: result.deleted.length});
        const original = await fingerprint(directoryHandle, originalName, {signal, result});
        const copy = await fingerprint(directoryHandle, name, {signal, result});
        if (original.size !== size || copy.size !== size || original.hash !== hash || copy.hash !== hash) {
          throw issue('FILE_CHANGED', '文件内容已改变，已保留；请重新扫描。');
        }
        // Reopen by name, ensuring the retained original still exists immediately
        // before removing the copy. Never create a file or pass recursive:true.
        const currentOriginal = await (await directoryHandle.getFileHandle(originalName)).getFile();
        const currentCopy = await (await directoryHandle.getFileHandle(name)).getFile();
        if (currentOriginal.size !== size || currentCopy.size !== size ||
          currentOriginal.lastModified !== original.lastModified || currentCopy.lastModified !== copy.lastModified) {
          throw issue('FILE_CHANGED', '校验后文件发生变化，已保留；请重新扫描。');
        }
        stopIfAborted(signal, result);
        await directoryHandle.removeEntry(name);
        result.deleted.push({name, originalName, size});
        result.bytesFreed += size;
      } catch (error) {
        if (signal?.aborted || error.name === 'AbortError') { stopIfAborted(signal, result); throw error; }
        const record = errorRecord(name, error, candidate?.originalName);
        if (typeof error.code === 'string' || ['NotFoundError', 'NotReadableError', 'TypeMismatchError'].includes(error.name)) {
          result.skipped.push(record);
        } else {
          result.failed.push(record);
        }
      }
      completed++;
      onProgress?.({phase: 'deleting', name, completed, total: candidates.length,
        deleted: result.deleted.length, skipped: result.skipped.length, failed: result.failed.length,
        bytesFreed: result.bytesFreed});
    }
    stopIfAborted(signal, result);
    return result;
  } finally {
    activeDeletions.delete(directoryHandle);
  }
}
