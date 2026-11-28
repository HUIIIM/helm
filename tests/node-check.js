// Parse gate + CSP gate.
//   node tests/node-check.js            parse every inline <script> of index.html and sw.js with `node --check`;
//                                       verify the CSP meta tag's script-src hash matches the inline script exactly
//   node tests/node-check.js --fix-csp  rewrite the script-src hash after an intended edit to the inline script
// Exit code 0 = all pass.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const REPO = path.resolve(__dirname, '..');
const INDEX = path.join(REPO, 'index.html');
let html = fs.readFileSync(INDEX, 'utf8');
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

// CSP gate: the page allows scripts only by hash, so every edit to the inline script must update the hash.
const want = blocks.map(b => "'sha256-" + crypto.createHash('sha256').update(b, 'utf8').digest('base64') + "'");
const meta = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/);
if (!meta) { failed++; console.log('CSP FAIL: no Content-Security-Policy meta tag in index.html'); }
else {
  const scriptSrc = (meta[1].match(/script-src ([^;]*)/) || [])[1] || '';
  const have = scriptSrc.trim().split(/\s+/).filter(x => x.startsWith("'sha256-"));
  const ok = have.length === want.length && want.every(h => have.includes(h));
  if (ok) console.log('CSP PASS script-src hash matches the inline script');
  else if (process.argv.includes('--fix-csp')) {
    const fixed = meta[0].replace(/script-src [^;]*/, 'script-src ' + want.join(' '));
    html = html.replace(meta[0], fixed);
    fs.writeFileSync(INDEX, html);
    console.log('CSP FIXED script-src -> ' + want.join(' '));
  } else { failed++; console.log('CSP FAIL script-src hash does not match the inline script; run: node tests/node-check.js --fix-csp\n  have: ' + have.join(' ') + '\n  want: ' + want.join(' ')); }
}
process.exit(failed ? 1 : 0);
