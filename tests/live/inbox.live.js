// Live test for the pending inbox (Helm slice 3): two widths (390 / 1440), every queue fixture, zero-PAGEERROR gate.
// Run from anywhere:  node tests/live/inbox.live.js [shots-dir]
// Needs: Node 18+ and Playwright with Chromium (require('playwright')). The script serves the repo itself on a free
// 127.0.0.1 port; nothing is written outside the shots directory (default: <tmp>/helm-live-shots).
// Exit code: 0 = all assertions pass, 1 = at least one assertion failed, 2 = harness error.
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const REPO = path.resolve(__dirname, '..', '..');
let BASE = '';
// The app accepts https snapshot URLs only (F-1), so fixtures are served under an https test host and fulfilled from the repo by a route.
const FIX = 'https://fixtures.helm.test';
const SW_VERSION = (fs.readFileSync(path.join(REPO, 'sw.js'), 'utf8').match(/SW_VERSION = '([^']+)'/) || [])[1];
const SHOTS = process.argv[2] || path.join(os.tmpdir(), 'helm-live-shots');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };
function serve() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      const f = path.join(REPO, decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname));
      if (!f.startsWith(REPO + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => { BASE = 'http://127.0.0.1:' + srv.address().port; resolve(srv); });
  });
}
let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; failures.push(name); console.log('  FAIL ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); }
}
// Fixtures are static files with fixed dates; the app judges freshness on generated_at (ADR-0001 §4.4). A fixture that
// carries generated_at is served with "5 minutes ago" so it reads as live; pass opts.generatedAt to serve a chosen value
// (null removes the field). Fixtures without generated_at are served unchanged.
function freshen(body, override) {
  if (override !== undefined) { if (override === null) { delete body.generated_at; delete body.generatedAt; } else body.generated_at = override; return body; }
  if (body.generated_at !== undefined || body.generatedAt !== undefined) { delete body.generatedAt; body.generated_at = new Date(Date.now() - 5 * 60000).toISOString(); }
  return body;
}
async function open(browser, w, h, fixture, opts) {
  opts = opts || {};
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: opts.dsf || 1, locale: opts.locale || 'zh-CN', acceptDownloads: true });
  const page = await ctx.newPage();
  const errs = [], reqs = [];
  page.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });
  page.on('request', r => reqs.push(r.method() + ' ' + r.url()));
  await page.route(FIX + '/**', async r => { const u = new URL(r.request().url()); const f = path.join(REPO, decodeURIComponent(u.pathname)); if (!f.startsWith(REPO + '/tests/fixtures/') || !fs.existsSync(f)) return r.fulfill({ status: 404, body: 'not found' }); await r.fulfill({ contentType: 'application/json', body: JSON.stringify(freshen(JSON.parse(fs.readFileSync(f, 'utf8')), opts.generatedAt)) }); });
  // Record every CSP violation the page reports (the page ships a meta CSP; see tests/node-check.js).
  await page.addInitScript(() => { window.__cspv = []; document.addEventListener('securitypolicyviolation', e => window.__cspv.push(e.violatedDirective + ' ' + e.blockedURI)); });
  if (opts.route) await opts.route(page);
  await page.addInitScript((u) => { if (!localStorage.getItem('__seeded')) { localStorage.setItem('__seeded', '1'); if (u) localStorage.setItem('fit.snapshot.url', u); } }, fixture ? FIX + '/tests/fixtures/' + fixture : '');
  await page.goto(BASE + '/index.html');
  await page.waitForTimeout(700);
  return { ctx, page, errs, reqs };
}
const hostSel = w => (w >= 1024 ? '#wp-pending-b' : '#approvalsBlock');
const log = page => page.evaluate(() => { const r = localStorage.getItem('helm.decisions.v1'); return r ? JSON.parse(r) : null; });
const logLen = async page => { const l = await log(page); return l ? l.entries.length : 0; };
// Two-step decision: step 1 (choice + reason, "next") never writes; step 2 is a separate confirm button.
async function decide(page, S, choice, reason) {
  const before = await logLen(page);
  if (choice) await S.locator('.inbox-opt').nth(choice === 'approve' ? 0 : 1).click();
  await S.locator('#inboxReason').fill(reason);
  await S.locator('#inboxSubmit').click();
  await S.locator('#inboxConfirm').waitFor();
  const mid = await logLen(page);
  await S.locator('#inboxConfirm').click();
  return { before, mid, after: await logLen(page) };
}

async function mainFlow(browser, w, h) {
  console.log(`\n== main fixture @ ${w}x${h}`);
  const { ctx, page, errs, reqs } = await open(browser, w, h, 'snapshot.queue.json', { dsf: 2 });
  const host = hostSel(w);
  const H = page.locator(host);
  ok(await H.isVisible(), 'inbox host visible');
  const badgeSel = w >= 1024 ? '.pend-badge' : '.ov-badge';
  ok((await H.locator(badgeSel).first().textContent()) === '31', 'orange capsule shows 31 awaiting decision');
  ok((await H.locator('.inbox-sum').textContent()).includes('队列 40 件 · 待你决定 31 · 已记录待封印 0'), 'summary line 40 / 31 / 0');
  ok((await H.locator('.inbox-tab[aria-pressed="true"]').textContent()).startsWith('待决'), 'default tab is pending');
  const rowsTodo = await H.locator('.inbox-row').count();
  ok(w >= 1024 ? rowsTodo === 31 : rowsTodo === 6, 'pending rows listed (31 desktop / 6 collapsed on phone)', rowsTodo);
  await page.screenshot({ path: path.join(SHOTS, `inbox-list-${w}.png`), fullPage: w < 1024 });
  if (w < 1024) {
    await H.locator('[data-inbox-more]').click();
    ok(await H.locator('.inbox-row').count() === 31, 'phone: show-all expands to 31');
  }
  const allText = await H.textContent();
  ok(allText.includes('cq18 · ceo_ruling'), 'title fallback "cq18 · ceo_ruling"');
  ok(allText.includes('Tooling budget cap'), 'title_map title shown when present (cq01)');
  ok(allText.includes('effect 未记录'), 'null effect rendered as words');
  ok(allText.includes('actor 未记录'), 'null actor rendered as words');
  ok(allText.includes('提请时间未记录'), 'null requested_at rendered as words');
  // first row is the longest-waiting item
  const firstId = await H.locator('.inbox-row').first().getAttribute('data-inbox-open');
  const expectFirst = await page.evaluate(async () => { const d = await (await fetch('/tests/fixtures/snapshot.queue.json')).json(); const p = d.queue.items.filter(i => i.state === 'pending' && i.requested_at).sort((a, b) => a.requested_at < b.requested_at ? -1 : 1); return p[0].queue_id; });
  ok(firstId === expectFirst, 'pending sorted longest-waiting first', [firstId, expectFirst]);
  // tabs
  await H.locator('[data-inbox-tab="approved"]').click();
  ok(await H.locator('.inbox-row').count() === 4, 'approved tab: 4');
  await H.locator('[data-inbox-tab="rejected"]').click();
  ok(await H.locator('.inbox-row').count() === 2, 'rejected tab: 2');
  await H.locator('[data-inbox-tab="executed"]').click();
  ok(await H.locator('.inbox-row').count() === 2, 'executed tab: 2');
  await H.locator('[data-inbox-tab="unknown"]').click();
  ok(await H.locator('.inbox-row').count() === 1, 'unknown tab: 1');
  await H.locator('[data-inbox-tab="all"]').click();
  if (w < 1024) await H.locator('[data-inbox-more]').click();
  ok(await H.locator('.inbox-row').count() === 40, 'all tab: 40');
  ok((await H.locator('[data-inbox-tab="logged"]').count()) === 0, 'logged tab hidden while empty');
  await H.locator('[data-inbox-tab="todo"]').click();
  if (w < 1024) await H.locator('[data-inbox-more]').click();

  // detail: cq18
  await H.locator('[data-inbox-open="cq18"]').click();
  const S = page.locator('#inboxSheet');
  ok(await S.isVisible(), 'detail sheet opens');
  ok((await S.locator('#inboxSheetTitle').textContent()) === 'cq18 · ceo_ruling', 'detail title uses fallback');
  ok((await S.textContent()).includes('无显示标题（title_map 无此件）'), 'fallback note shown');
  ok(await S.locator('.inbox-f').count() === 12, 'all 12 fields listed');
  const fields = await S.locator('.inbox-fields').textContent();
  ok(fields.includes('decided_at待决') && fields.includes('decided_via待决') && fields.includes('decision_note待决'), 'decided_* null shown as 待决');
  ok(fields.includes('无关联对象'), 'null subject_ref shown as words');
  ok((await S.locator('.inbox-verbatim').first().textContent()) === 'Record the ruling on external issue references in the decision register', 'text effect rendered verbatim');
  ok(await S.locator('.inbox-diff').count() === 0, 'no diff table for a text effect');
  ok((await S.textContent()).includes('决定记录于本地日志、经日志回写中枢确认队列'), 'local-log notice present in detail');
  // D-09 reason gate
  const submit = S.locator('#inboxSubmit');
  ok(await submit.isDisabled(), 'submit disabled initially');
  await S.locator('#inboxReason').fill('reason only');
  ok(await submit.isDisabled(), 'submit disabled with reason but no choice');
  await S.locator('#inboxReason').fill('');
  await S.locator('.inbox-opt').first().click();
  ok(await submit.isDisabled(), 'submit disabled with choice but no reason');
  await S.locator('#inboxReason').fill('   \n  ');
  ok(await submit.isDisabled(), 'submit disabled with whitespace-only reason');
  // forced submit without a reason must not write
  await page.evaluate(() => { document.getElementById('inboxForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })); });
  ok((await log(page)) === null, 'forced submit without a reason writes nothing');
  await page.screenshot({ path: path.join(SHOTS, `inbox-detail-gate-${w}.png`) });
  await S.locator('#inboxReason').fill('Rule recorded; external issue refs stay out of the projection.');
  ok(await submit.isEnabled(), 'submit enabled with choice + reason');
  ok((await submit.textContent()) === '下一步：确认批准', 'step-1 label names the action and says it is not the final step');
  await submit.click();
  ok(await S.locator('#inboxConfirm').isVisible() && await S.locator('#inboxForm').count() === 0, 'step 2 is a separate review panel');
  ok((await log(page)) === null, 'step 1 writes nothing');
  ok((await S.locator('.inbox-confirm').textContent()).includes('Rule recorded; external issue refs stay out of the projection.'), 'review panel restates the reason verbatim');
  await page.screenshot({ path: path.join(SHOTS, `inbox-detail-review-${w}.png`) });
  await S.locator('[data-inbox-back]').click();
  ok((await S.locator('#inboxReason').inputValue()).startsWith('Rule recorded') && await S.locator('.inbox-opt input[value="approve"]').isChecked(), 'back to edit keeps choice and reason');
  ok((await log(page)) === null, 'back to edit writes nothing');
  await S.locator('#inboxSubmit').click();
  await S.locator('[data-inbox-step="1"]').click();
  await S.locator('[data-inbox-step="-1"]').click();
  ok(await S.locator('#inboxConfirm').count() === 0 && await S.locator('#inboxForm').count() === 1, 'leaving the item drops the review step (back at step 1)');
  ok((await log(page)) === null, 'navigating away from step 2 writes nothing');
  await S.locator('#inboxSubmit').click();
  await S.locator('#inboxConfirm').click();
  let lg = await log(page);
  ok(lg && lg.schema === 'helm.decision-log.v1' && lg.entries.length === 1, 'one entry appended to helm.decisions.v1');
  const e1 = lg.entries[0];
  ok(e1.queue_id === 'cq18' && e1.action === 'approve' && e1.proposed_state === 'approved' && e1.decision_note.startsWith('Rule recorded') && e1.delivery === 'local_only' && e1.decided_via === 'helm-pwa-local-log', 'entry fields', e1);
  ok(e1.basis && /^sha256:[0-9a-f]{64}$/.test(e1.basis.content_hash) && e1.basis.generation_seq === 46 && e1.basis.snapshot_state === 'live', 'entry bound to content_hash + generation', e1.basis);
  ok(typeof e1.reviewed_at === 'string' && Date.parse(e1.reviewed_at) <= Date.parse(e1.decided_at), 'entry carries both step timestamps (reviewed_at <= decided_at)');
  ok((await S.locator('.inbox-flash').textContent()).includes('已记入本地日志并回读确认。尚未回写中枢'), 'saved flash states not written back');
  ok((await S.locator('.inbox-entry .tags').first().textContent()).includes('待封印 · 未回写'), 'entry tagged awaiting seal, not written back');
  await page.screenshot({ path: path.join(SHOTS, `inbox-detail-saved-${w}.png`) });
  ok((await H.locator(badgeSel).first().textContent()) === '30', 'capsule drops to 30 after local decision');
  ok((await H.locator('.inbox-sum').textContent()).includes('待你决定 30 · 已记录待封印 1'), 'summary 30 / 1');
  // next pending
  await S.locator('[data-inbox-nexttodo]').click();
  const nextTitle = await S.locator('#inboxSheetTitle').textContent();
  ok(nextTitle !== 'cq18 · ceo_ruling', 'next-pending moves to another item', nextTitle);
  await page.keyboard.press('Escape');
  ok(!(await S.isVisible()), 'Esc closes the sheet');
  // logged tab + re-decide + withdraw
  await H.locator('[data-inbox-tab="logged"]').click();
  ok(await H.locator('.inbox-row').count() === 1 && (await H.locator('.inbox-local').textContent()).includes('本地已记录：批准 · 待封印（未回写）'), 'logged tab shows the item with a not-written-back marker');
  await H.locator('[data-inbox-open="cq18"]').click();
  await S.locator('[data-inbox-mode="redecide"]').click();
  ok(await S.locator('#inboxSubmit').isDisabled(), 're-decide form starts disabled');
  let st = await decide(page, S, 'reject', 'Changed my mind: reject.');
  ok(st.mid === st.before && st.after === st.before + 1, 're-decide: step 1 writes nothing, step 2 writes one entry', st);
  lg = await log(page);
  ok(lg.entries.length === 2 && lg.entries[1].action === 'reject' && lg.entries[1].supersedes === lg.entries[0].log_id && lg.entries[0].action === 'approve', 're-decide appends and links supersedes; first entry kept');
  ok(await S.locator('.inbox-entry').count() === 2 && (await S.locator('.inbox-entry.is-old').count()) === 1, 'item history shows both, older marked superseded');
  await S.locator('[data-inbox-mode="withdraw"]').click();
  ok(await S.locator('#inboxSubmit').isDisabled(), 'withdraw needs a reason too');
  st = await decide(page, S, null, 'Withdrawn pending the upstream ruling.');
  ok(st.mid === st.before && st.after === st.before + 1, 'withdraw: two steps as well', st);
  lg = await log(page);
  ok(lg.entries.length === 3 && lg.entries[2].action === 'withdraw' && lg.entries[2].proposed_state === null, 'withdraw appended (append-only log, 3 entries)');
  ok(await S.locator('#inboxForm').count() === 1 && await S.locator('.inbox-choice').count() === 1, 'after withdraw the decide form is back');
  await S.locator('[data-inbox-close]').click();
  ok((await H.locator(badgeSel).first().textContent()) === '31', 'capsule back to 31 after withdraw');
  // hub-decided and unknown items are closed
  await H.locator('[data-inbox-tab="approved"]').click();
  await H.locator('.inbox-row').first().click();
  ok(await S.locator('#inboxForm').count() === 0 && (await S.textContent()).includes('中枢队列已有决定，不在此改写'), 'approved item: no form');
  ok(!(await S.locator('.inbox-fields').textContent()).includes('decided_at待决'), 'approved item shows its decided_at');
  await S.locator('[data-inbox-close]').click();
  await H.locator('[data-inbox-tab="unknown"]').click();
  await H.locator('.inbox-row').first().click();
  ok(await S.locator('#inboxForm').count() === 0 && (await S.textContent()).includes('fail-closed'), 'unknown-state item: closed (fail-closed)');
  await S.locator('[data-inbox-close]').click();
  // subject link -> object detail
  await H.locator('[data-inbox-tab="all"]').click();
  if (w < 1024) await H.locator('[data-inbox-more]').click();
  await H.locator('[data-inbox-open="cq01"]').click();
  ok((await S.locator('#inboxSheetTitle').textContent()) === 'Tooling budget cap', 'titled item uses title_map title');
  ok((await S.locator('.inbox-d-sub').textContent()).includes('cq01'), 'queue_id still shown next to a display title');
  await S.locator('[data-inbox-subject-type]').click();
  ok(!(await S.isVisible()), 'subject link closes the sheet');
  ok(await page.locator(w >= 1024 ? '#wp-detail-b .obj-title' : '#objDetail.open .obj-title').first().textContent() === 'Ship Helm overview', 'subject link opens the goal object');
  if (w < 1024) await page.locator('#objDetail [data-obj-close]').click();
  // decision log sheet + export
  await H.locator('[data-inbox-log]').click();
  ok((await S.locator('#inboxSheetTitle').textContent()) === '决策日志' && await S.locator('.inbox-entry').count() === 3, 'log sheet lists 3 entries');
  ok((await S.textContent()).includes('PWA 阶段不接令牌，本日志不含任何凭据'), 'log sheet states no token / no credentials');
  const [dl] = await Promise.all([page.waitForEvent('download'), S.locator('[data-inbox-export]').click()]);
  const dlPath = path.join(SHOTS, `export-${w}.json`);
  await dl.saveAs(dlPath);
  const ex = JSON.parse(fs.readFileSync(dlPath, 'utf8'));
  ok(/^helm-decision-log-\d{8}-\d{6}\.json$/.test(dl.suggestedFilename()) && ex.schema === 'helm.decision-log.v1' && ex.delivery === 'local_only' && ex.entries.length === 3 && ex.shell_version === SW_VERSION, 'export file parses: schema, delivery=local_only, 3 entries', dl.suggestedFilename());
  await S.locator('[data-inbox-json]').click();
  ok(JSON.parse(await S.locator('.inbox-json').inputValue()).entries.length === 3, 'JSON text view matches');
  await page.screenshot({ path: path.join(SHOTS, `inbox-log-${w}.png`) });
  await S.locator('[data-inbox-close]').click();
  // search -> detail
  await page.locator(w >= 1024 ? '#searchFieldBtn' : '#searchBtn').click();
  await page.locator('#globalSearch').fill('cq27');
  ok(await page.locator('#searchResults .item').count() === 1, 'search by queue_id finds one item');
  await page.locator('#searchResults [data-inbox-open]').click();
  ok((await S.locator('#inboxSheetTitle').textContent()) === 'cq27 · ceo_ruling', 'search result opens the item detail');
  await S.locator('[data-inbox-close]').click();
  // Me view card
  await page.locator('nav button[data-v="v-me"]').click();
  ok((await page.locator('#inboxLogCard').textContent()).includes('3 条记录'), 'Me view log card shows the count');
  // persistence across reload + storage hygiene
  await page.reload(); await page.waitForTimeout(700);
  lg = await log(page);
  ok(lg.entries.length === 3, 'log survives reload');
  const keys = await page.evaluate(() => Object.keys(localStorage).sort());
  ok(keys.every(k => !/token|secret|auth|credential|key$/i.test(k)), 'no token-like localStorage keys', keys);
  const dump = await page.evaluate(() => JSON.stringify(localStorage));
  ok(!/bearer|ghp_|sk-|authorization/i.test(dump), 'no credential-looking values in localStorage');
  console.log('  localStorage keys: ' + keys.join(', '));
  // network hygiene
  const nonGet = reqs.filter(r => !r.startsWith('GET '));
  const offOrigin = reqs.filter(r => !r.includes(BASE) && !r.includes(FIX + '/tests/fixtures/'));
  ok(nonGet.length === 0, 'no non-GET request was made', nonGet);
  ok(offOrigin.length === 0, 'no off-origin request was made', offOrigin);
  ok((await page.evaluate(() => window.__cspv)).length === 0, `zero CSP violations across the main flow @ ${w}`, await page.evaluate(() => window.__cspv));
  ok(errs.length === 0, `zero PAGEERROR / console errors @ ${w}`, errs);
  await ctx.close();
}

async function staleHashFlow(browser, w, h) {
  console.log(`\n== content_hash change after a local decision @ ${w}x${h}`);
  let mutate = false;
  const route = async page => {
    await page.route('**/tests/fixtures/snapshot.queue.json', async r => {
      const body = JSON.parse(fs.readFileSync(path.join(REPO, 'tests/fixtures/snapshot.queue.json'), 'utf8'));
      if (mutate) { const it = body.queue.items.find(i => i.queue_id === 'cq18'); it.effect = 'CHANGED effect text'; it.content_hash = 'sha256:' + 'ab'.repeat(32); body.generation_seq = 50; }
      await r.fulfill({ contentType: 'application/json', body: JSON.stringify(freshen(body)) });
    });
  };
  const { ctx, page, errs } = await open(browser, w, h, 'snapshot.queue.json', { route });
  const H = page.locator(hostSel(w)), S = page.locator('#inboxSheet');
  if (w < 1024) await H.locator('[data-inbox-more]').click();
  await H.locator('[data-inbox-open="cq18"]').click();
  await decide(page, S, 'approve', 'Approve v1 content.');
  await S.locator('[data-inbox-close]').click();
  ok((await H.locator('.inbox-sum').textContent()).includes('待你决定 30'), 'logged before the change (30 pending)');
  mutate = true;
  await page.reload(); await page.waitForTimeout(700);
  ok((await H.locator('.inbox-sum').textContent()).includes('待你决定 31 · 已记录待封印 0'), 'after hash change the item is back in pending (31)');
  if (w < 1024) await H.locator('[data-inbox-more]').click();
  ok((await H.locator('[data-inbox-open="cq18"] .inbox-local').textContent()).includes('本地记录基于旧内容'), 'row flags the stale local record');
  await H.locator('[data-inbox-open="cq18"]').click();
  ok((await S.textContent()).includes('此件内容哈希已变化'), 'detail warns about the hash change');
  ok(await S.locator('#inboxForm').count() === 1 && await S.locator('#inboxSubmit').isDisabled(), 'decision form is offered again, gated');
  ok(errs.length === 0, 'zero page errors', errs);
  await ctx.close();
}

async function sealFlow(browser, w, h) {
  console.log(`\n== seal: hub state catches up with the local record @ ${w}x${h}`);
  let hub = 'pending';
  const route = async page => {
    await page.route('**/tests/fixtures/snapshot.queue.json', async r => {
      const body = JSON.parse(fs.readFileSync(path.join(REPO, 'tests/fixtures/snapshot.queue.json'), 'utf8'));
      const it = body.queue.items.find(i => i.queue_id === 'cq20');
      if (hub !== 'pending') { it.state = hub; it.decided_at = '2026-11-13T09:00:00Z'; it.decided_via = 'ceo_chat'; it.decision_note = null; body.generation_seq = 51; }
      await r.fulfill({ contentType: 'application/json', body: JSON.stringify(freshen(body)) });
    });
  };
  const { ctx, page, errs } = await open(browser, w, h, 'snapshot.queue.json', { route });
  const H = page.locator(hostSel(w)), S = page.locator('#inboxSheet');
  if (w < 1024) await H.locator('[data-inbox-more]').click();
  await H.locator('[data-inbox-open="cq20"]').click();
  await decide(page, S, 'approve', 'Approve cq20.');
  ok((await S.locator('.inbox-local-now .eyebrow').textContent()).includes('待封印 · 未回写'), 'pending hub item: local record awaiting seal');
  await S.locator('[data-inbox-close]').click();
  hub = 'approved';
  await page.reload(); await page.waitForTimeout(700);
  await H.locator('[data-inbox-tab="approved"]').click();
  ok(await H.locator('.inbox-row').count() === 5, 'hub approved: item moves to the approved tab (5)');
  ok((await H.locator('[data-inbox-open="cq20"] .inbox-local').textContent()).includes('中枢已定 · 与本地记录一致（已批准）'), 'row: hub state matches the local record');
  await H.locator('[data-inbox-open="cq20"]').click();
  ok(await S.locator('#inboxForm').count() === 0 && (await S.locator('.inbox-local-now').textContent()).includes('与本地记录一致'), 'detail: closed, seal line shown');
  ok((await S.locator('.inbox-entry .tags').first().textContent()).includes('与本地记录一致'), 'history entry tagged with the seal');
  await page.screenshot({ path: path.join(SHOTS, `inbox-sealed-${w}.png`) });
  await S.locator('[data-inbox-close]').click();
  hub = 'rejected';
  await page.reload(); await page.waitForTimeout(700);
  await H.locator('[data-inbox-tab="rejected"]').click();
  ok((await H.locator('[data-inbox-open="cq20"] .inbox-local').textContent()).includes('中枢已定 · 与本地记录不同（中枢：已否决）'), 'row: hub decision differs from the local record');
  await H.locator('[data-inbox-log]').click();
  ok((await S.locator('.inbox-entry .tags').first().textContent()).includes('与本地记录不同'), 'log sheet shows the differing seal');
  ok(errs.length === 0, 'zero page errors', errs);
  await ctx.close();
}

async function freshnessFlow(browser, w, h) {
  console.log(`\n== freshness from generated_at (ADR-0001 §4.4) @ ${w}x${h}`);
  const top = page => page.locator('#topSignalText').textContent();
  const dataLine = async page => w >= 1024 ? page.locator('#wp-data-age').textContent() : page.locator('#snapshotNote').textContent();
  const iso = ms => new Date(Date.now() + ms).toISOString();
  let r = await open(browser, w, h, 'snapshot.queue.json');
  ok((await top(r.page)).startsWith('已连接'), 'generated 5 min ago: Live', await top(r.page));
  ok((await dataLine(r.page)).includes('数据生成于 5 分钟前'), 'data age shown (5 min)', await dataLine(r.page));
  ok(r.errs.length === 0, 'zero page errors (fresh)', r.errs); await r.ctx.close();

  r = await open(browser, w, h, 'snapshot.queue.json', { generatedAt: iso(-8 * 86400000) });
  ok((await top(r.page)).startsWith('快照较旧'), 'fetched just now but generated 8 days ago: Stale, not Live', await top(r.page));
  ok((await dataLine(r.page)).includes('数据生成于 8 天前'), 'data age shown (8 days)', await dataLine(r.page));
  await r.page.locator('nav button[data-v="v-me"]').click();
  ok((await r.page.locator('#snapshotStatus').textContent()).includes('数据生成于 8 天前'), 'Me view states the data age');
  await r.page.locator('nav button[data-v="v-brief"]').click();
  const H = r.page.locator(hostSel(w)), S = r.page.locator('#inboxSheet');
  await H.locator('.inbox-row').first().click();
  ok((await S.locator('.inbox-warn').first().textContent()).includes('当前显示的不是实时快照（快照较旧'), 'inbox detail warns on stale data');
  ok((await S.locator('.inbox-warn').first().textContent()).includes('数据生成于 8 天前'), 'the warning names the data age, not the fetch age');
  await decide(r.page, S, 'approve', 'Decided on stale data.');
  const lg = await log(r.page);
  ok(lg.entries[0].basis.snapshot_state === 'stale', 'decision basis records snapshot_state=stale', lg.entries[0].basis);
  await r.page.screenshot({ path: path.join(SHOTS, `freshness-stale-${w}.png`) });
  ok(r.errs.length === 0, 'zero page errors (stale)', r.errs); await r.ctx.close();

  r = await open(browser, w, h, 'snapshot.queue.json', { generatedAt: null });
  ok((await top(r.page)).startsWith('快照较旧'), 'no generated_at: never Live', await top(r.page));
  ok((await dataLine(r.page)).includes('数据生成时间未知'), 'missing generated_at stated in words', await dataLine(r.page));
  ok(r.errs.length === 0, 'zero page errors (missing)', r.errs); await r.ctx.close();

  r = await open(browser, w, h, 'snapshot.queue.json', { generatedAt: iso(2 * 3600000) });
  ok((await top(r.page)).startsWith('快照较旧') && (await dataLine(r.page)).includes('晚于本机时间'), 'generated_at in the future: not Live, stated');
  ok(r.errs.length === 0, 'zero page errors (future)', r.errs); await r.ctx.close();

  r = await open(browser, w, h, 'snapshot.queue.json', { generatedAt: iso(-23 * 3600000) });
  ok((await top(r.page)).startsWith('已连接'), 'generated 23 h ago: still within the 24 h threshold');
  ok(r.errs.length === 0, 'zero page errors (23 h)', r.errs); await r.ctx.close();

  r = await open(browser, w, h, 'snapshot.queue.json', { generatedAt: 'not-a-date' });
  ok((await top(r.page)).startsWith('快照较旧') && (await dataLine(r.page)).includes('数据生成时间未知'), 'unparsable generated_at treated as missing');
  ok(r.errs.length === 0, 'zero page errors (unparsable)', r.errs); await r.ctx.close();

  r = await open(browser, w, h, 'snapshot.sample.json');
  ok((await top(r.page)).startsWith('已连接'), 'legacy camelCase generatedAt is read (sample fixture)', await top(r.page));
  ok(r.errs.length === 0, 'zero page errors (sample)', r.errs); await r.ctx.close();
}

async function cspFlow(browser, w, h) {
  console.log(`\n== content security policy @ ${w}x${h}`);
  const r = await open(browser, w, h, 'snapshot.queue.json');
  const p = r.page;
  const csp = await p.evaluate(() => { const m = document.querySelector('meta[http-equiv="Content-Security-Policy"]'); return m ? m.content : null; });
  ok(!!csp && /script-src 'sha256-[A-Za-z0-9+/=]+'/.test(csp) && !/unsafe-eval/.test(csp) && !/script-src[^;]*unsafe-inline/.test(csp), 'meta CSP present; scripts allowed by hash only', csp);
  ok((await p.locator('.inbox-row').count()) > 0 && (await p.locator('#topSignalText').textContent()).startsWith('已连接'), 'app runs and loads the https snapshot under the CSP');
  ok((await p.evaluate(() => window.__cspv)).length === 0, 'no violation during normal load', await p.evaluate(() => window.__cspv));
  const sw = await p.evaluate(() => Promise.race([navigator.serviceWorker.ready.then(r => r.active ? r.active.scriptURL : 'no-active'), new Promise(res => setTimeout(() => res('timeout'), 5000))]));
  ok(typeof sw === 'string' && sw.endsWith('/sw.js'), 'the service worker registers and activates under the CSP (worker-src)', sw);
  const injected = await p.evaluate(() => { const s = document.createElement('script'); s.textContent = 'window.__cspProbe = 1'; document.head.appendChild(s); return window.__cspProbe; });
  ok(injected === undefined, 'an injected inline script does not run');
  const httpFetch = await p.evaluate(() => fetch('http://127.0.0.2:9/x').then(() => 'loaded', () => 'blocked'));
  ok(httpFetch === 'blocked', 'a non-https, non-self fetch is blocked');
  await p.waitForTimeout(200);
  const v = await p.evaluate(() => window.__cspv);
  ok(v.some(x => x.startsWith('script-src')) && v.some(x => x.startsWith('connect-src')), 'both probes were refused by the CSP (script-src, connect-src)', v);
  const real = r.errs.filter(e => !/Content Security Policy|Failed to fetch/.test(e));
  ok(real.length === 0, 'no other page errors', real);
  await r.ctx.close();
}

async function cachedFlow(browser, w, h) {
  console.log(`\n== offline / cached snapshot @ ${w}x${h}`);
  let down = false;
  const route = async page => { await page.route('**/tests/fixtures/snapshot.queue.json', r => down ? r.abort() : r.fallback()); };
  const { ctx, page, errs } = await open(browser, w, h, 'snapshot.queue.json', { route });
  down = true;
  await page.reload(); await page.waitForTimeout(700);
  const H = page.locator(hostSel(w)), S = page.locator('#inboxSheet');
  ok(await H.locator('.inbox-row').count() > 0, 'inbox renders from the cached snapshot');
  ok((await page.locator('#topSignalText').textContent()).includes('#46'), 'cached snapshot keeps its generation number', await page.locator('#topSignalText').textContent());
  await H.locator('.inbox-row').first().click();
  ok((await S.locator('.inbox-warn').first().textContent()).includes('当前显示的不是实时快照'), 'detail warns that the snapshot is cached');
  await decide(page, S, 'approve', 'Decided on cached data.');
  const lg = await log(page);
  ok(lg.entries.length === 1 && lg.entries[0].basis.snapshot_state === 'cached' && lg.entries[0].basis.generation_seq === 46, 'entry records snapshot_state=cached and generation', lg.entries[0].basis);
  const real = errs.filter(e => !/Failed to load resource|net::ERR_FAILED/.test(e));
  ok(real.length === 0, 'zero page errors (aborted fetch excluded)', real);
  await ctx.close();
}

async function edgeFlow(browser, w, h) {
  console.log(`\n== edge fixture @ ${w}x${h}`);
  const { ctx, page, errs } = await open(browser, w, h, 'snapshot.queue-edge.json', { dsf: 2 });
  const H = page.locator(hostSel(w)), S = page.locator('#inboxSheet');
  if (w < 1024) await H.locator('[data-inbox-more]').click();
  const sum = await H.locator('.inbox-sum').textContent();
  ok(sum.includes('队列 9 件') && sum.includes('队列申报 12 件，本快照携带明细 9 件') && sum.includes('2 件缺少 queue_id 或编号重复，未列出'), 'count mismatch and dropped items stated', sum);
  ok(!(await page.content()).includes('RAW REVIEW TITLE'), 'raw [review] title never reaches the DOM');
  ok((await H.textContent()).includes('Title supplied by title_map'), 'envelope title_map title is used');
  ok((await H.textContent()).includes('cqe05 · ceo_ruling'), 'item with only a raw title falls back to queue_id · kind');
  await H.locator('[data-inbox-open="cqe01"]').click();
  ok(await S.locator('.inbox-diff tbody tr').count() === 3 && await S.locator('.inbox-diff th').count() === 3, 'structured effect: 3 rows, 3 columns');
  ok(await S.locator('.inbox-diff tr.is-changed').count() === 2 && await S.locator('.inbox-diff tr.is-same').count() === 1, 'changed / unchanged rows marked');
  const r0 = await S.locator('.inbox-diff tbody tr').first().textContent();
  ok(r0.includes('budget_cap_usd') && r0.includes('60') && r0.includes('100'), 'row carries field, current and proposed values', r0);
  await page.screenshot({ path: path.join(SHOTS, `inbox-diff-${w}.png`) });
  await S.locator('[data-inbox-step="1"]').click();
  const id2 = await S.locator('.inbox-d-sub').textContent();
  await S.locator('[data-inbox-close]').click();
  await H.locator('[data-inbox-open="cqe02"]').click();
  ok(await S.locator('.inbox-diff th').count() === 2 && (await S.textContent()).includes('effect 没有携带现状值'), 'map effect without current values: proposed-only, no invented diff');
  await S.locator('[data-inbox-close]').click();
  await H.locator('[data-inbox-open="cqe03"]').click();
  ok(await S.locator('.inbox-diff tbody tr').count() === 2 && (await S.locator('.inbox-verbatim').first().textContent()) === 'Move the briefing earlier and shorten it', 'summary + changes[] form');
  await S.locator('[data-inbox-close]').click();
  await H.locator('[data-inbox-open="cqe04"]').click();
  ok(await S.locator('.inbox-diff').count() === 0 && (await S.locator('pre.inbox-verbatim').textContent()).includes('"steps"'), 'unrecognised structure rendered verbatim, no table');
  await S.locator('[data-inbox-close]').click();
  await H.locator('[data-inbox-tab="unknown"]').click();
  await H.locator('[data-inbox-open="cqe07"]').click();
  ok(await S.locator('#inboxForm').count() === 0, 'out-of-enum state is unknown and closed');
  await S.locator('[data-inbox-close]').click();
  await H.locator('[data-inbox-tab="todo"]').click();
  if (w < 1024) await H.locator('[data-inbox-more]').click();
  await H.locator('[data-inbox-open="cqe08"]').click();
  ok((await S.locator('.inbox-subject').textContent()).includes('goal-999（不在本快照内）') && await S.locator('[data-inbox-subject-type]').count() === 0, 'unresolvable subject_ref shown as text, no link');
  await S.locator('[data-inbox-close]').click();
  await H.locator('[data-inbox-open="cqe09"]').click();
  ok((await S.textContent()).includes('此件没有内容哈希'), 'missing content_hash is flagged');
  ok(errs.length === 0, 'zero page errors', errs);
  await ctx.close();
}

async function stateFixtures(browser, w, h) {
  console.log(`\n== not-connected / empty / legacy / local-only @ ${w}x${h}`);
  let r = await open(browser, w, h, 'snapshot.queue-not-connected.json', { dsf: 2 });
  let H = r.page.locator(hostSel(w));
  ok((await H.textContent()).includes('待决队列未连接。本快照没有取得队列镜像读数，这里不列出任何待决件，也不以 0 代替。'), 'not_connected: honest text');
  ok(await H.locator('.inbox-row').count() === 0 && await H.locator('.ov-badge,.pend-badge').count() === 0 && await H.locator('.inbox-tab').count() === 0, 'not_connected: no rows, no capsule, no tabs');
  await r.page.screenshot({ path: path.join(SHOTS, `inbox-not-connected-${w}.png`) });
  ok(r.errs.length === 0, 'zero page errors (not_connected)', r.errs); await r.ctx.close();

  r = await open(browser, w, h, 'snapshot.queue-empty.json');
  H = r.page.locator(hostSel(w));
  ok((await H.textContent()).includes('队列已连接，当前没有任何件。') && await H.locator('.inbox-row').count() === 0 && await H.locator('.ov-badge,.pend-badge').count() === 0, 'empty: honest text, no rows, no capsule');
  await r.page.screenshot({ path: path.join(SHOTS, `inbox-empty-${w}.png`) });
  ok(r.errs.length === 0, 'zero page errors (empty)', r.errs); await r.ctx.close();

  r = await open(browser, w, h, 'snapshot.vnext-approvals.json');
  H = r.page.locator(hostSel(w));
  const tx = await H.textContent();
  ok(tx.includes('Increase Helm budget') && tx.includes('Finance') && tx.includes('Budget +$100') && tx.includes('Ship Helm overview') && await H.locator('.inbox-row').count() === 0, 'legacy pending_approvals fixture renders as before (no inbox takeover)');
  ok((await H.locator('.ov-badge,.pend-badge').first().textContent()) === '2', 'legacy capsule still 2');
  ok(r.errs.length === 0, 'zero page errors (legacy approvals)', r.errs); await r.ctx.close();

  r = await open(browser, w, h, 'snapshot.vnext.json');
  H = r.page.locator(hostSel(w));
  ok((await H.textContent()).includes('待决定未连接'), 'legacy not_connected fixture unchanged');
  ok(r.errs.length === 0, 'zero page errors (legacy vnext)', r.errs); await r.ctx.close();

  for (const f of ['snapshot.sample.json', 'snapshot.vnext-desktop.json']) {
    r = await open(browser, w, h, f);
    ok(r.errs.length === 0, 'zero page errors (' + f + ')', r.errs); await r.ctx.close();
  }
  r = await open(browser, w, h, '');
  ok(await r.page.locator('.inbox-row').count() === 0, 'local-only: no inbox rows');
  for (const v of ['v-plan', 'v-team', 'v-chat', 'v-me', 'v-brief']) { await r.page.locator(`nav button[data-v="${v}"]`).click(); ok(await r.page.locator('#' + v).isVisible(), 'view ' + v + ' navigable'); }
  await r.page.locator('nav button[data-v="v-me"]').click();
  ok((await r.page.locator('#inboxLogCard').textContent()).includes('本地日志还没有记录') && await r.page.locator('#inboxLogExport').isDisabled(), 'Me card: empty log, export disabled');
  ok(r.errs.length === 0, 'zero page errors (local-only)', r.errs); await r.ctx.close();

  // F-1 regression with the inbox in place: a stored http snapshot URL is cleared on load and never fetched.
  {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, locale: 'zh-CN' });
    const page = await ctx.newPage(); const errs = [], reqs = [];
    page.on('pageerror', e => errs.push(e.message)); page.on('request', q => reqs.push(q.url()));
    await page.addInitScript((u) => { if (!sessionStorage.getItem('s')) { sessionStorage.setItem('s', '1'); localStorage.setItem('fit.snapshot.url', u); } }, BASE + '/tests/fixtures/snapshot.queue.json');
    await page.goto(BASE + '/index.html'); await page.waitForTimeout(700);
    ok((await page.evaluate(() => localStorage.getItem('fit.snapshot.url'))) === null && !reqs.some(u => u.includes('snapshot.queue.json')) && await page.locator('.inbox-row').count() === 0, 'F-1: http snapshot URL cleared, not fetched, no inbox rows');
    ok(errs.length === 0, 'zero page errors (F-1 probe)', errs); await ctx.close();
  }
  r = await open(browser, w, h, 'snapshot.queue.json', { locale: 'en-US' });
  H = r.page.locator(hostSel(w));
  ok((await H.textContent()).includes('40 in queue · 31 awaiting your decision'), 'en locale strings');
  ok(r.errs.length === 0, 'zero page errors (en)', r.errs); await r.ctx.close();
}

(async () => {
  const srv = await serve();
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch();
  for (const [w, h] of [[390, 844], [1440, 900]]) {
    await mainFlow(browser, w, h);
    await staleHashFlow(browser, w, h);
    await sealFlow(browser, w, h);
    await cachedFlow(browser, w, h);
    await freshnessFlow(browser, w, h);
    await cspFlow(browser, w, h);
    await edgeFlow(browser, w, h);
    await stateFixtures(browser, w, h);
  }
  await browser.close();
  srv.close();
  console.log(`\nRESULT pass=${pass} fail=${fail}`);
  if (fail) { console.log('FAILED: ' + failures.join(' | ')); process.exit(1); }
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
