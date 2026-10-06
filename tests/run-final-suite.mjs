import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const files=(await fs.readdir(import.meta.dirname)).filter(name=>name.endsWith('.test.mjs')).sort().map(name=>`tests/${name}`);
const args=['--experimental-vm-modules','--test','--test-reporter=spec',...files];
const result=spawnSync(process.execPath,args,{cwd:path.resolve(import.meta.dirname,'..'),encoding:'utf8',env:{...process.env,NO_COLOR:'1'}});
const output=(result.stdout||'')+(result.stderr||'');
await fs.writeFile(path.join(import.meta.dirname,'final-test-output.txt'),output);
const metric=name=>Number(output.match(new RegExp(`^ℹ ${name} ([0-9.]+)$`,'m'))?.[1]??NaN);
const manifest=JSON.parse(await fs.readFile(path.join(import.meta.dirname,'../extension/manifest.json'),'utf8'));
const summary={version:manifest.version,command:`node ${args.join(' ')}`,exitCode:result.status,tests:metric('tests'),passed:metric('pass'),failed:metric('fail'),skipped:metric('skipped'),durationMs:metric('duration_ms'),realBrowserEvidence:['tests/mv3-url-result.json','tests/mv3-speed-result.json','tests/mv3-v14-retry-result.json'],screenshots:['tests/dashboard-preview.png','tests/import-preview.png','tests/dedup-preview.png','tests/verification-wait-preview.png'],filesystemCleanupTestedWith:'In-memory directory handles only; no real PDF deletion'};
await fs.writeFile(path.join(import.meta.dirname,'final-test-summary.json'),JSON.stringify(summary,null,2));
console.log(output);
console.log(JSON.stringify(summary,null,2));
process.exitCode=result.status??1;
