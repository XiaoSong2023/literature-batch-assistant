// Locates Playwright and a Chrome binary for the browser tests and tools.
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);

/** Resolves a dev dependency from node_modules, or from a shared folder named by CODEX_NODE_MODULES. */
export function loadModule(name, override) {
  const candidates = [override, process.env.CODEX_NODE_MODULES && path.join(process.env.CODEX_NODE_MODULES, name), name].filter(Boolean);
  for (const candidate of candidates) {
    try { return require(candidate); } catch { /* try the next location */ }
  }
  throw new Error(`找不到 ${name}。请先在项目根目录运行 npm install。`);
}

export function loadPlaywright() {
  return loadModule('playwright', process.env.PLAYWRIGHT_MODULE);
}

/** Installed Google Chrome when present; otherwise Playwright's own Chromium. */
export function chromeExecutable() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const known = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
  ];
  return known.find(file => fs.existsSync(file));
}

/** Serves files from the extension directory at https://fixture.example/. */
export async function serveExtension(context, extensionDir) {
  const types = {'.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2'};
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    const file = path.resolve(extensionDir, decodeURIComponent(url.pathname.slice(1)));
    if (url.hostname !== 'fixture.example' || !file.startsWith(extensionDir + path.sep) || !fs.existsSync(file)) return route.abort();
    return route.fulfill({status: 200, contentType: types[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
  });
}
