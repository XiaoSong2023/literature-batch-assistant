// Renders the vermilion seal icon (「文」) to the PNG sizes Chrome expects.
//   node tools/build_icons.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import {loadPlaywright, chromeExecutable} from '../tests/browser-env.mjs';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, 'extension', 'icons');
const font = `data:font/woff2;base64,${(await fs.readFile(path.join(root, 'extension', 'fonts', 'wenxian-serif.woff2'))).toString('base64')}`;

// Small sizes stay crisp and flat; larger ones carry a stamped-ink texture.
function seal(size) {
  const textured = size >= 48;
  const inset = size >= 48 ? size * 0.07 : size <= 16 ? 0 : size * 0.03;
  const box = size - inset * 2;
  const radius = size <= 16 ? 2.5 : box * 0.13;
  const glyph = box * (size <= 16 ? 0.86 : 0.74);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <defs><filter id="ink" x="-5%" y="-5%" width="110%" height="110%">
      <feTurbulence type="fractalNoise" baseFrequency="${(0.42 * 128 / size).toFixed(2)}" numOctaves="3" seed="3" result="n"/>
      <feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -11 ${size >= 128 ? 8.05 : 8.6}" result="s"/>
      <feComposite in="SourceGraphic" in2="s" operator="in"/>
    </filter></defs>
    <g ${textured ? 'filter="url(#ink)"' : ''}>
      <rect x="${inset}" y="${inset}" width="${box}" height="${box}" rx="${radius}" fill="#c4452c"/>
      <text x="${size / 2}" y="${size / 2 + glyph * 0.36}" text-anchor="middle" font-family="Wenxian Serif" font-weight="800" font-size="${glyph}" fill="#fbf6ec">文</text>
    </g>
  </svg>`;
}

const {chromium} = loadPlaywright();
const browser = await chromium.launch({headless: true, executablePath: chromeExecutable()});
const page = await browser.newPage();
await fs.mkdir(outDir, {recursive: true});
const written = [];
for (const size of [16, 32, 48, 128]) {
  await page.setViewportSize({width: size, height: size});
  await page.setContent(`<!doctype html><style>@font-face{font-family:"Wenxian Serif";src:url("${font}")}html,body{margin:0;background:transparent}svg{display:block}</style>${seal(size)}`);
  await page.evaluate(() => document.fonts.ready);
  const file = path.join(outDir, `icon-${size}.png`);
  await page.screenshot({path: file, omitBackground: true});
  written.push(path.relative(root, file));
}
await fs.writeFile(path.join(outDir, 'icon.svg'), seal(128));
await browser.close();
console.log(written.join('\n'));
