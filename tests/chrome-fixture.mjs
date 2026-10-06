import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

class EventHub {
  listeners = new Set();
  addListener = listener => this.listeners.add(listener);
  removeListener = listener => this.listeners.delete(listener);
  hasListener = listener => this.listeners.has(listener);
  async emit(...args) {
    return Promise.all([...this.listeners].map(listener => listener(...args)));
  }
}

/** Fake only the browser boundary. All queue logic runs from the real extension modules. */
export async function createChromeFixture({ bundle, persisted = {}, session = {}, inspect, scriptHandler, downloadItems = [], tabItems = [], autoCommitSubmission = true } = {}) {
  let now = Date.parse('2026-10-05T12:00:00Z');
  let nextTab = 1;
  let nextDownload = 1;
  let nextTimer = 1;
  let nextDocument = 1;
  const alarms = new Map();
  const tabs = new Map();
  const downloads = new Map();
  for (const item of downloadItems) downloads.set(item.id, copy(item));
  for (const item of tabItems) tabs.set(item.id, copy(item));
  nextTab = Math.max(0, ...tabs.keys()) + 1;
  nextDownload = Math.max(0, ...downloads.keys()) + 1;
  const timers = new Map();
  const calls = { downloads: [], navigation: [], scripts: [], cancelled: [], errors: [], storageWrites: 0 };
  const makeStore = source => ({
    data: copy(source),
    async get(keys) {
      if (keys === null || keys === undefined) return copy(this.data);
      if (typeof keys === 'string') return { [keys]: copy(this.data[keys]) };
      if (Array.isArray(keys)) return Object.fromEntries(keys.map(key => [key, copy(this.data[key])]));
      return { ...copy(keys), ...copy(this.data) };
    },
    async set(values) { calls.storageWrites += 1; Object.assign(this.data, copy(values)); },
    async remove(keys) { for (const key of [].concat(keys)) delete this.data[key]; },
  });
  const chrome = {
    runtime: {
      id: 'offline-fixture-extension',
      getURL: value => `chrome-extension://offline-fixture-extension/${value}`,
      onMessage: new EventHub(), onInstalled: new EventHub(), onStartup: new EventHub(),
      async sendMessage() {},
    },
    storage: { local: makeStore(persisted), session: makeStore(session), onChanged: new EventHub() },
    alarms: {
      onAlarm: new EventHub(),
      async get(name) { return copy(alarms.get(name)); },
      async getAll() { return [...alarms.values()].map(copy); },
      async create(name, info) { alarms.set(name, { name, scheduledTime: info.when ?? now + (info.delayInMinutes ?? 0) * 60000, periodInMinutes: info.periodInMinutes }); },
      async clear(name) { return alarms.delete(name); },
      async clearAll() { alarms.clear(); return true; },
    },
    tabs: {
      onUpdated: new EventHub(), onRemoved: new EventHub(),
      async create(info) { const tab = { id: nextTab++, status: 'complete', documentId: `document-${nextDocument++}`, ...info }; tabs.set(tab.id, tab); calls.navigation.push(copy(tab)); return copy(tab); },
      async get(id) { if (!tabs.has(id)) throw Error('No tab with id'); return copy(tabs.get(id)); },
      async query() { return [...tabs.values()].map(copy); },
      async update(id, info) { if (!tabs.has(id)) throw Error('No tab with id'); const tab = Object.assign(tabs.get(id), info); if (info.url) tab.documentId = `document-${nextDocument++}`; calls.navigation.push(copy(tab)); return copy(tab); },
      async remove(id) { tabs.delete(id); await chrome.tabs.onRemoved.emit(id, {}); },
      async sendMessage(id, message) { return inspect ? inspect({ tab: copy(tabs.get(id)), message, calls }) : {}; },
    },
    webNavigation: {
      onCommitted: new EventHub(), onDOMContentLoaded: new EventHub(), onErrorOccurred: new EventHub(),
      async getFrame({tabId}) { const tab=tabs.get(tabId); return tab ? {documentId:tab.documentId,frameId:0,url:tab.url} : null; },
    },
    scripting: {
      async executeScript(options) {
        const tab = tabs.get(options.target?.tabId);
        const documentId = tab?.documentId || `doc-${options.target?.tabId}-${calls.navigation.length}`;
        if (options.target?.documentIds && !options.target.documentIds.includes(documentId)) throw Error('No document with id');
        calls.scripts.push({ name: options.func?.name, args: copy(options.args), target: copy(options.target) });
        const result = scriptHandler
          ? await scriptHandler({ ...options, tab: copy(tabs.get(options.target?.tabId)), calls })
          : inspect ? await inspect({ ...options, tab: copy(tabs.get(options.target?.tabId)), calls }) : {};
        if (options.func?.name === 'submitDoi' && result?.ok && tab && autoCommitSubmission) tab.documentId = `document-${nextDocument++}`;
        return [{ frameId: 0, documentId, result }];
      },
    },
    downloads: {
      onCreated: new EventHub(), onChanged: new EventHub(),
      async download(options) {
        const id = nextDownload++;
        const item = { id, url: options.url, finalUrl: options.url, filename: options.filename, mime: 'application/pdf', state: 'in_progress', bytesReceived: 0, totalBytes: -1, fileSize: -1, byExtensionId: chrome.runtime.id, startTime: new Date(now).toISOString() };
        downloads.set(id, item); calls.downloads.push(copy(item));
        return id;
      },
      async search(query) {
        return [...downloads.values()].filter(item => query.id === undefined || item.id === query.id).map(copy);
      },
      async cancel(id) { calls.cancelled.push(id); if (downloads.has(id)) downloads.get(id).state = 'interrupted'; },
      async erase(query) { const ids = [...downloads.keys()].filter(id => !query.id || id === query.id); for (const id of ids) downloads.delete(id); return ids; },
    },
    action: { onClicked: new EventHub(), async setBadgeText() {}, async setBadgeBackgroundColor() {}, async setTitle() {} },
    permissions: { async contains() { return true; }, async request() { return true; } },
    windows: { async update() {} },
  };
  class FixtureDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const context = vm.createContext({
    chrome, URL, URLSearchParams, structuredClone, Blob, TextEncoder, TextDecoder, AbortController,
    Date: FixtureDate,
    console: { ...console, error(...args) { calls.errors.push(args.map(String).join(' ')); } },
    setTimeout(fn, delay = 0, ...args) { const id = nextTimer++; timers.set(id, { at: now + delay, fn: () => fn(...args) }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch: async url => {
      if (String(url).startsWith('chrome-extension:')) return { ok: true, json: async () => copy(bundle ?? { papers: [] }) };
      throw Error(`Network is forbidden in offline fixture: ${url}`);
    },
  });
  const modules = new Map();
  const extensionDir = path.resolve(import.meta.dirname, '../extension');
  async function loadModule(filename) {
    filename = path.resolve(filename);
    if (modules.has(filename)) return modules.get(filename);
    const source = await fs.readFile(filename, 'utf8');
    const module = new vm.SourceTextModule(source, { context, identifier: filename });
    modules.set(filename, module);
    await module.link(specifier => loadModule(path.resolve(path.dirname(filename), specifier)));
    return module;
  }
  const background = await loadModule(path.join(extensionDir, 'background.js'));
  await background.evaluate();
  async function settle(rounds = 40) { for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve)); }
  await settle();
  async function send(message, senderOverride) {
    const response = new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(Error(`Message did not respond: ${JSON.stringify(message)}`)), 3000);
      const reply = value => { clearTimeout(deadline); resolve(copy(value)); };
      for (const listener of chrome.runtime.onMessage.listeners) {
        const result = listener(message, senderOverride || { id: chrome.runtime.id, url: chrome.runtime.getURL('dashboard.html') }, reply);
        if (result && typeof result.then === 'function') result.then(reply, reject);
        else if (result !== true && result !== undefined && result !== false) reply(result);
      }
    });
    await settle();
    return response;
  }
  async function advance(milliseconds) {
    now += milliseconds;
    for (let pass = 0; pass < 100; pass++) {
      let fired = false;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); fired = true; }
      for (const [name, alarm] of [...alarms]) if (alarm.scheduledTime <= now) {
        if (alarm.periodInMinutes) alarm.scheduledTime = now + alarm.periodInMinutes * 60000;
        else alarms.delete(name);
        await chrome.alarms.onAlarm.emit(copy(alarm)); fired = true;
      }
      await settle();
      if (!fired) break;
    }
  }
  async function completeDownload(id, changes = {}) {
    const item = downloads.get(id);
    if (!item) throw Error(`Fixture has no download ${id}`);
    Object.assign(item, { state: 'complete', mime: 'application/pdf', bytesReceived: 2048, totalBytes: 2048, fileSize: 2048 }, changes);
    await chrome.downloads.onChanged.emit({ id, state: { current: item.state } });
    await settle();
  }
  return { chrome, send, advance, settle, completeDownload, calls, tabs, downloads, alarms, context,
    get now() { return now; },
    get persisted() { return copy(chrome.storage.local.data); },
    get session() { return copy(chrome.storage.session.data); },
  };
}
