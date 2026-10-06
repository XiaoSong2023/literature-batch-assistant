// These functions are injected by chrome.scripting. Keep them self-contained.
export function inspectPage() {
  const result = (() => {
  const visible = element => Boolean(element && (element.getClientRects().length || element.offsetWidth || element.offsetHeight));
  const text = (document.body?.innerText || "").slice(0, 120000);
  const title = document.title || "";
  const absolute = value => {
    try {
      const url = new URL(value, location.href);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
      if (/^(?:localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|\[::1\])/i.test(url.hostname) || /^172\.(?:1[6-9]|2\d|3[01])\./.test(url.hostname)) return null;
      url.hash = "";
      return url.href;
    } catch { return null; }
  };
  const blockedText = /(?:verify (?:that )?you are human|checking your browser|security verification|verify you are not a robot|are you (?:a |are )?robot|complete the captcha|enter (?:the )?(?:captcha|code from the image)|请输入验证码|人机验证|проверка.{0,20}робот)/i;
  const challengeInput = [...document.querySelectorAll('input[name*="captcha" i],input[id*="captcha" i],iframe[src*="recaptcha"][title*="challenge" i],altcha-widget')].some(visible);
  // A site can replace its challenge in-place without updating the old document title.
  // Only visible challenge controls/text keep the document in verification state.
  if (challengeInput || blockedText.test(text)) {
    const question = document.querySelector('.question .ask');
    const answer = document.querySelector('.question .answer');
    const robotNo = location.origin === "https://sci-hub.box" && Boolean(document.querySelector(".question altcha-widget")) && visible(question) &&
      /are you (?:a |are )?robot|вы робот|你是机器人/i.test(question.textContent || "") &&
      Boolean(answer && /^(?:no|нет|否|不是)$/i.test((answer.textContent || "").trim()));
    return {kind: "captcha", robotNo, message: "页面要求验证码或人工验证，请在检索标签页完成后继续。", url: location.href};
  }
  const candidates = [
    ...document.querySelectorAll('iframe#pdf[src],embed#pdf[src],object#pdf[data],embed[type="application/pdf"][src],object[type="application/pdf"][data]'),
    ...[...document.querySelectorAll('iframe[src],embed[src],object[data]')].filter(el => /\.pdf(?:[?#]|$)/i.test(el.getAttribute("src") || el.getAttribute("data") || "")),
  ];
  for (const element of candidates) {
    const url = absolute(element.getAttribute("src") || element.getAttribute("data"));
    if (url) return {kind: "pdf", url, pageUrl: location.href, evidence: element.tagName.toLowerCase()};
  }
  const words = text.replace(/\s+/g, " ");
  const missing = /(?:article|paper|document|publication) (?:was |is |has been )?(?:not (?:found|available|in the database)|unavailable)|not found (?:in|on) (?:the )?(?:database|sci.hub)|does not have (?:the |this )?(?:article|paper|document)|unfortunately.{0,160}(?:not (?:found|available)|doesn.t|cannot)|(?:sci.hub).{0,60}(?:does not|doesn.t|cannot|can.t).{0,50}(?:have|find|provide|retrieve)|(?:article|paper|document).{0,50}(?:has not|hasn.t|not yet).{0,25}(?:added|available)|статья не найдена|документ не найден|文献未找到|没有找到.{0,15}(?:文章|文献)|(?:该|此|这篇)(?:文章|论文|文献).{0,15}(?:未收录|不存在|无法找到)/i;
  if (missing.test(words)) return {kind: "not_found", message: "网站明确提示未找到或未收录该文献。", url: location.href};
  if (/^(?:502|503|504|403|404)\b|bad gateway|service unavailable|gateway time.?out|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|this site can.t be reached|无法访问此网站|access denied/i.test(`${title}\n${text.slice(0, 3000)}`)) return {kind: "connection_error", message: "页面出现网络、服务器或访问错误。", url: location.href};
  // The real homepage links to /docs/SCI.pdf. A search form takes precedence
  // over generic PDF links, otherwise that brochure could be mistaken for the paper.
  const input = document.querySelector('textarea[name="request"],input[name="request"]');
  const hasForm = input && visible(input) && input.form;
  if (hasForm) return {kind: "home", url: location.href, hasForm: true};
  for (const link of document.querySelectorAll('a[href]')) {
    const href = link.getAttribute("href") || "";
    if (!/\/(?:docs|about)\//i.test(href) && (/\.pdf(?:[?#]|$)/i.test(href) || link.getAttribute("type") === "application/pdf")) {
      const url = absolute(href);
      if (url) return {kind: "pdf", url, pageUrl: location.href, evidence: "pdf_link"};
    }
  }
  // Extract only a quoted URL from the site's save control; never execute onclick text.
  for (const button of document.querySelectorAll('#buttons [onclick],button[onclick],a[onclick]')) {
    const handler = button.getAttribute("onclick") || "";
    const match = handler.match(/(?:location(?:\.href)?|window\.location(?:\.href)?)\s*=\s*(['"])([^'"\r\n]+)\1/);
    if (match && /\.pdf(?:[?#]|$)/i.test(match[2])) {
      const url = absolute(match[2]);
      if (url) return {kind: "pdf", url, pageUrl: location.href, evidence: "save_control_url"};
    }
  }
  if (document.contentType === "application/pdf") return {kind: "pdf", url: location.href.split("#")[0], pageUrl: location.href, evidence: "pdf_document"};
  return {kind: "unknown", url: location.href, title: title.slice(0, 200)};
  })();
  return {...result, readyState: document.readyState};
}

export function submitDoi(doi) {
  if (!/^10\.\d{4,9}(?:\.\d+)*\/\S+$/i.test(doi)) return {ok: false, reason: "DOI 格式无效。"};
  const input = document.querySelector('textarea[name="request"],input[name="request"]');
  const form = input?.form;
  if (!input || !form) return {ok: false, reason: "页面未找到 DOI 输入框。"};
  const action = new URL(form.getAttribute("action") || location.href, location.href);
  if (action.origin !== "https://sci-hub.box") return {ok: false, reason: "检索表单跳转到未授权的网站，已停止。"};
  const prototype = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  descriptor.set.call(input, doi);
  input.dispatchEvent(new Event("input", {bubbles: true}));
  input.dispatchEvent(new Event("change", {bubbles: true}));
  if (form.requestSubmit) form.requestSubmit();
  else HTMLFormElement.prototype.submit.call(form);
  return {ok: true};
}

export function clickRobotNo() {
  if (location.origin !== "https://sci-hub.box") return {status: "unsupported"};
  const question = document.querySelector('.question .ask');
  const answer = document.querySelector('.question .answer');
  const visible = element => Boolean(element?.getClientRects().length);
  if (!document.querySelector('.question altcha-widget') || !visible(question) ||
      !/are you (?:a |are )?robot|вы робот|你是机器人/i.test(question.textContent || "") ||
      !answer || !/^(?:no|нет|否|不是)$/i.test((answer.textContent || "").trim())) return {status: "unsupported"};
  if (globalThis.__literatureRobotClicked) return {status: "already_clicked"};
  // The observed site binds ALTCHA handlers in window.onload. Do not click before those handlers exist.
  if (document.readyState !== "complete") return {status: "not_ready"};
  if (!visible(answer)) return {status: "already_clicked"};
  globalThis.__literatureRobotClicked = true;
  answer.click();
  return {status: "clicked"};
}

export function installPageWatcher(watchId) {
  if (!["https://sci-hub.box", "https://sci-net.xyz"].includes(location.origin)) return {ok: false};
  if (globalThis.__literatureWatcher?.watchId === watchId && !globalThis.__literatureWatcher.stopped) return {ok: true};
  globalThis.__literatureWatcher?.stop();
  let timer;
  let lifetime;
  const watcher = {watchId, stopped: false, stop};
  const observer = new MutationObserver(signal);
  function stop() {
    watcher.stopped = true;
    observer.disconnect();
    clearTimeout(timer);
    clearTimeout(lifetime);
    document.removeEventListener("DOMContentLoaded", signal);
  }
  function signal() {
    if (watcher.stopped || timer) return;
    timer = setTimeout(() => {
      timer = null;
      try {
        chrome.runtime.sendMessage({type: "PAGE_CHANGED", watchId}).then(response => {
          if (!response?.active) stop();
        }).catch(stop);
      } catch { stop(); }
    }, 150);
  }
  observer.observe(document, {subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["src", "href", "class", "style"]});
  document.addEventListener("DOMContentLoaded", signal);
  lifetime = setTimeout(stop, 300000);
  globalThis.__literatureWatcher = watcher;
  signal();
  return {ok: true};
}
