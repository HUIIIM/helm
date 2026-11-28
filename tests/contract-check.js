// Snapshot contract check (ADR-0001 §4.3; schema: docs/contract/snapshot.v2.schema.json). Zero dependencies.
//
//   node tests/contract-check.js                 check every fixture against tests/contract-expectations.json
//   node tests/contract-check.js --file a.json   validate any snapshot (e.g. a generator's output); exit 1 on any violation
//
// Two layers:
//   1. Structure: a small JSON Schema validator covering the keywords the schema uses
//      (type, const, enum, required, properties, items, additionalProperties, minimum, minLength, pattern,
//      format "date-time", local $ref). An unsupported keyword in the schema is an error, so the schema cannot
//      silently outgrow the checker.
//   2. Invariants the schema cannot express (ADR-0001 §4.3):
//      EXPOSURE_RAW_TITLE  a key named "title" anywhere: only display_title / title_map values are projected
//      REF_DANGLING        subject_ref that does not resolve to a goal id or decision id in the same projection
//      ID_DUPLICATE        duplicate goal id, decision id, approval id or queue_id
//      HASH_MISSING        a pending (decidable) queue item without content_hash
//
// Fixtures are client probes, so several are out of contract on purpose; tests/contract-expectations.json pins the
// exact violation set per fixture and the run fails on any difference in either direction.
const fs = require('fs');
const path = require('path');
const REPO = path.resolve(__dirname, '..');
const SCHEMA = JSON.parse(fs.readFileSync(path.join(REPO, 'docs/contract/snapshot.v2.schema.json'), 'utf8'));
const SUPPORTED = new Set(['$schema', '$id', 'title', 'description', '$defs', '$ref', 'type', 'const', 'enum', 'required',
  'properties', 'items', 'additionalProperties', 'minimum', 'minLength', 'pattern', 'format']);
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}
function typeMatches(v, t) { const a = typeOf(v); return a === t || (t === 'number' && a === 'integer'); }
function resolve(ref) {
  if (!ref.startsWith('#/')) throw new Error('only local $ref is supported: ' + ref);
  return ref.slice(2).split('/').reduce((node, key) => {
    if (!node || !(key in node)) throw new Error('unresolvable $ref: ' + ref);
    return node[key];
  }, SCHEMA);
}
function validate(schema, value, at, out) {
  for (const k of Object.keys(schema)) if (!SUPPORTED.has(k)) throw new Error('unsupported schema keyword "' + k + '" at ' + at);
  if (schema.$ref) validate(resolve(schema.$ref), value, at, out);
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(t => typeMatches(value, t))) { out.push(`SCHEMA_TYPE@${at}`); return; }
  }
  if ('const' in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) out.push(`SCHEMA_CONST@${at}`);
  if (schema.enum && !schema.enum.some(e => JSON.stringify(e) === JSON.stringify(value))) out.push(`SCHEMA_ENUM@${at}`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) out.push(`SCHEMA_MIN_LENGTH@${at}`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) out.push(`SCHEMA_PATTERN@${at}`);
    if (schema.format === 'date-time' && !(DATE_TIME.test(value) && !isNaN(Date.parse(value)))) out.push(`SCHEMA_FORMAT@${at}`);
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) out.push(`SCHEMA_MINIMUM@${at}`);
  if (typeOf(value) === 'object') {
    for (const r of schema.required || []) if (!(r in value)) out.push(`SCHEMA_REQUIRED@${at}.${r}`);
    for (const [k, sub] of Object.entries(schema.properties || {})) if (k in value) validate(sub, value[k], `${at}.${k}`, out);
    if (schema.additionalProperties !== undefined && typeof schema.additionalProperties === 'object') {
      for (const k of Object.keys(value)) if (!(schema.properties && k in schema.properties)) validate(schema.additionalProperties, value[k], `${at}.${k}`, out);
    }
  }
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => validate(schema.items, v, `${at}[${i}]`, out));
}

function invariants(doc, out) {
  (function walk(v, at) {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${at}[${i}]`));
    if (typeOf(v) !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      if (k === 'title') out.push(`EXPOSURE_RAW_TITLE@${at}.${k}`);
      if (k !== 'title_map') walk(x, `${at}.${k}`);
    }
  })(doc, '$');
  const list = v => (Array.isArray(v) ? v.filter(x => typeOf(x) === 'object') : []);
  const goals = list(doc.goals), decisions = list(doc.decisions);
  const known = new Set([...goals, ...decisions].map(x => x.id).filter(x => typeof x === 'string'));
  const dup = (items, key, at) => {
    const seen = new Set();
    (Array.isArray(items) ? items : []).forEach((x, i) => {
      if (typeOf(x) !== 'object' || typeof x[key] !== 'string') return;
      if (seen.has(x[key])) out.push(`ID_DUPLICATE@${at}[${i}].${key}`);
      seen.add(x[key]);
    });
  };
  dup(doc.goals, 'id', '$.goals');
  dup(doc.decisions, 'id', '$.decisions');
  const pa = typeOf(doc.pending_approvals) === 'object' ? doc.pending_approvals : {};
  const q = typeOf(doc.queue) === 'object' ? doc.queue : {};
  dup(pa.items, 'id', '$.pending_approvals.items');
  dup(q.items, 'queue_id', '$.queue.items');
  const refs = [
    [doc.decisions, '$.decisions'],
    [typeOf(doc.overview) === 'object' ? doc.overview.recent_activity : null, '$.overview.recent_activity'],
    [pa.items, '$.pending_approvals.items'],
    [q.items, '$.queue.items'],
  ];
  for (const [items, at] of refs) {
    (Array.isArray(items) ? items : []).forEach((x, i) => {
      if (typeOf(x) === 'object' && typeof x.subject_ref === 'string' && !known.has(x.subject_ref)) out.push(`REF_DANGLING@${at}[${i}].subject_ref`);
    });
  }
  (Array.isArray(q.items) ? q.items : []).forEach((x, i) => {
    if (typeOf(x) === 'object' && x.state === 'pending' && !(typeof x.content_hash === 'string' && x.content_hash)) out.push(`HASH_MISSING@$.queue.items[${i}].content_hash`);
  });
}

function check(doc) {
  const out = [];
  validate(SCHEMA, doc, '$', out);
  invariants(doc, out);
  return [...new Set(out)].sort();
}

const fileArg = process.argv.indexOf('--file');
if (fileArg > -1) {
  const f = process.argv[fileArg + 1];
  const v = check(JSON.parse(fs.readFileSync(f, 'utf8')));
  console.log(v.length ? `CONTRACT FAIL ${f} (${v.length})\n  ` + v.join('\n  ') : `CONTRACT PASS ${f}`);
  process.exit(v.length ? 1 : 0);
}

// Self-test: every violation code must fire on a synthetic document, and a clean document must pass.
const CLEAN = {
  projection_version: 2, generation_seq: 1, generated_at: '2026-11-28T00:00:00Z',
  goals: [{ id: 'g1', display_title: 'G' }], decisions: [{ id: 'd1', subject_ref: 'g1' }],
  queue: { status: 'connected', count: 1, title_map: { q1: 'T' }, items: [{ queue_id: 'q1', kind: 'ceo_ruling', state: 'pending', content_hash: 'sha256:' + 'a'.repeat(64), requested_at: null, decided_by: null }] },
};
const SELF = [
  ['clean document', d => d, []],
  ['wrong major version', d => { d.projection_version = 3; }, ['SCHEMA_CONST@$.projection_version']],
  ['generation_seq not an integer', d => { d.generation_seq = '1'; }, ['SCHEMA_TYPE@$.generation_seq']],
  ['negative generation_seq', d => { d.generation_seq = -1; }, ['SCHEMA_MINIMUM@$.generation_seq']],
  ['generated_at not a date-time', d => { d.generated_at = '2026-11-28'; }, ['SCHEMA_FORMAT@$.generated_at']],
  ['missing generated_at', d => { delete d.generated_at; }, ['SCHEMA_REQUIRED@$.generated_at']],
  ['empty goal id', d => { d.goals[0].id = ''; d.decisions[0].subject_ref = null; }, ['SCHEMA_MIN_LENGTH@$.goals[0].id']],
  ['content_hash not sha256', d => { d.queue.items[0].content_hash = 'md5:x'; }, ['SCHEMA_PATTERN@$.queue.items[0].content_hash']],
  ['state outside K2', d => { d.queue.items[0].state = 'voided'; }, ['SCHEMA_ENUM@$.queue.items[0].state']],
  ['title_map value not a string', d => { d.queue.title_map.q1 = 1; }, ['SCHEMA_TYPE@$.queue.title_map.q1']],
  ['raw title projected', d => { d.goals[0].title = 'raw'; }, ['EXPOSURE_RAW_TITLE@$.goals[0].title']],
  ['dangling subject_ref', d => { d.decisions[0].subject_ref = 'g9'; }, ['REF_DANGLING@$.decisions[0].subject_ref']],
  ['duplicate goal id', d => { d.goals.push({ id: 'g1' }); }, ['ID_DUPLICATE@$.goals[1].id']],
  ['pending item without hash', d => { d.queue.items[0].content_hash = null; }, ['HASH_MISSING@$.queue.items[0].content_hash']],
  ['decided item without hash is allowed', d => { d.queue.items[0].state = 'approved'; d.queue.items[0].content_hash = null; }, []],
  ['unknown extra field is allowed', d => { d.staleness_days = 3; d.queue.items[0].future_field = 1; }, []],
];
let selfBad = 0;
for (const [name, mutate, want] of SELF) {
  const d = JSON.parse(JSON.stringify(CLEAN)); mutate(d);
  const got = check(d);
  if (JSON.stringify(got) !== JSON.stringify([...want].sort())) { selfBad++; console.log(`SELF-TEST FAIL ${name}: want ${JSON.stringify(want)} got ${JSON.stringify(got)}`); }
}
console.log(`SELF-TEST cases=${SELF.length} fail=${selfBad}`);

const EXPECT = JSON.parse(fs.readFileSync(path.join(__dirname, 'contract-expectations.json'), 'utf8'));
const dir = path.join(__dirname, 'fixtures');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
let bad = 0;
for (const f of files) {
  const actual = check(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  const e = EXPECT.fixtures[f];
  if (!e) { bad++; console.log(`FAIL ${f}: no entry in tests/contract-expectations.json (actual: ${actual.length ? actual.join(', ') : 'in contract'})`); continue; }
  const want = [...e.violations].sort();
  const missing = want.filter(x => !actual.includes(x)), extra = actual.filter(x => !want.includes(x));
  if (missing.length || extra.length) {
    bad++;
    console.log(`FAIL ${f}` + (missing.length ? `\n  expected but not found: ${missing.join(', ')}` : '') + (extra.length ? `\n  found but not expected: ${extra.join(', ')}` : ''));
  } else {
    console.log(`PASS ${f}: ${actual.length ? actual.length + ' expected violation(s), ' + e.role : 'in contract'}`);
  }
}
for (const f of Object.keys(EXPECT.fixtures)) if (!files.includes(f)) { bad++; console.log(`FAIL ${f}: listed in expectations but not in tests/fixtures/`); }
console.log(`RESULT fixtures=${files.length} fail=${bad} self-test-fail=${selfBad}`);
process.exit(bad || selfBad ? 1 : 0);
