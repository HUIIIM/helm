// Parse gate: extracts every inline <script> from index.html and runs `node --check` on it, then on sw.js.
// Run: node tests/node-check.js   (exit code 0 = all pass)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const REPO = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-check-'));
let failed = 0;
const check = (file, label) => {
  try { execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }); console.log('node --check PASS ' + label); }
  catch (e) { failed++; console.log('node --check FAIL ' + label + '\n' + String(e.stderr || e.message)); }
};
console.log('inline script blocks: ' + blocks.length);
blocks.forEach((b, i) => { const f = path.join(dir, 'inline-' + i + '.js'); fs.writeFileSync(f, b); check(f, 'inline-' + i + ' (' + Buffer.byteLength(b) + ' bytes)'); });
check(path.join(REPO, 'sw.js'), 'sw.js');
fs.rmSync(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
