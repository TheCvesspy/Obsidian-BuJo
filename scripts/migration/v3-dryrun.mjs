// Friday v3 vault migration — DRY RUN (read-only). Reports what a migration would change.
// Usage: node migrate-dryrun.mjs
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const VAULT = 'C:/Users/on079542/Obsidian Vaults/QuillWork';
const DAILY = 'BuJo/Daily';
const TOPICS = 'BuJo/Team/Sprints/Topics';
const TASKS_FILE = 'BuJo/Tasks.md';

// Folders to skip entirely (big/irrelevant/system).
const SKIP_DIRS = new Set(['.obsidian', '.trash', '.git', 'Attachments', 'Excalidraw', 'Clippings', '.claude']);
const SKIP_PATH_SUBSTR = ['Dokumentace/PnB/pv-documentation', 'BuJo/Archive'];

const CHECKBOX = /^(\s*)-\s*\[([ xX><!/-])\]\s+(.*)$/;
const FROM_COPY = /\(from\s+\[\[[^\]]+\]\]\)/;
const DUE = /@due\s+([\w\d\s\/-]+?)(?=\s+[@#(]|$)/i;
const EFFORT = /#effort\/(S|M|L)\b/i;
const HEADING = /^(#{1,6})\s+(.+)$/;

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(VAULT, full).split(sep).join('/');
    if (SKIP_DIRS.has(name)) continue;
    if (SKIP_PATH_SUBSTR.some(s => rel.startsWith(s))) continue;
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (name.endsWith('.md')) out.push({ full, rel });
  }
}

function area(rel) {
  if (rel.startsWith(DAILY)) return 'Daily';
  if (rel.startsWith(TOPICS)) return 'Topics';
  if (rel.startsWith('BuJo/')) return 'BuJo (other)';
  return 'Other pages';
}

// Classify a @due date string: iso / dmy / dm / natural.
function dueKind(raw) {
  const s = raw.trim();
  const parts = s.split('-');
  if (parts.length === 3 && parts[0].length === 4) return 'iso';
  if (parts.length === 3) return 'dmy';
  if (parts.length === 2 && /^\d/.test(parts[0])) return 'dm';
  return 'natural';
}

const files = [];
walk(VAULT, files);

const stats = {};
const samples = { copies: [], dmy: [], dm: [], effort: [], migratedMarker: [], scheduledMarker: [] };
function bump(a, k, n = 1) { (stats[a] ??= {})[k] = (stats[a][k] || 0) + n; }

let looseOpenDaily = 0, doneDaily = 0;

for (const { full, rel } of files) {
  const a = area(rel);
  let content;
  try { content = readFileSync(full, 'utf8'); } catch { continue; }
  const lines = content.split('\n');
  bump(a, 'files');

  // Track heading context inside daily notes to find loose ## Tasks / ## Inbox items.
  let section = null;
  for (const line of lines) {
    const h = line.match(HEADING);
    if (h) {
      const t = h[2].trim().toLowerCase();
      section = (t.includes('task') || t.includes('inbox') || t.includes('migrated')) ? t : null;
      continue;
    }
    const m = line.match(CHECKBOX);
    if (!m) continue;
    const status = m[2].toLowerCase();
    bump(a, 'checkboxes');

    if (status === 'x' || status === '-') bump(a, 'done/cancelled');
    if (status === '>') { bump(a, '[>] migrated'); if (samples.migratedMarker.length < 6) samples.migratedMarker.push(`${rel}: ${line.trim()}`); }
    if (status === '<') { bump(a, '[<] scheduled'); if (samples.scheduledMarker.length < 6) samples.scheduledMarker.push(`${rel}: ${line.trim()}`); }

    if (FROM_COPY.test(line)) { bump(a, '(from [[…]]) copies'); if (samples.copies.length < 8) samples.copies.push(`${rel}: ${line.trim()}`); }

    const due = line.match(DUE);
    if (due) {
      const k = dueKind(due[1]);
      bump(a, `@due ${k}`);
      if (k === 'dmy' && samples.dmy.length < 6) samples.dmy.push(`${rel}: ${line.trim()}`);
      if (k === 'dm' && samples.dm.length < 6) samples.dm.push(`${rel}: ${line.trim()}`);
    }
    if (EFFORT.test(line)) { bump(a, '#effort/ tags'); if (samples.effort.length < 6) samples.effort.push(`${rel}: ${line.trim()}`); }

    // Daily loose-task accounting (root-level items under Tasks/Inbox, not (from) copies).
    if (a === 'Daily' && section && (m[1] || '').length === 0) {
      if (status === ' ' || status === '!') { if (!FROM_COPY.test(line)) looseOpenDaily++; }
      if (status === 'x' || status === '-') doneDaily++;
    }
  }
}

// ── Report ──
const areas = ['Daily', 'Topics', 'BuJo (other)', 'Other pages'];
const keys = ['files', 'checkboxes', 'done/cancelled', '[>] migrated', '[<] scheduled',
  '(from [[…]]) copies', '@due iso', '@due dmy', '@due dm', '@due natural', '#effort/ tags'];

console.log('='.repeat(70));
console.log('FRIDAY v3 — VAULT MIGRATION DRY RUN (no files changed)');
console.log('Vault:', VAULT);
console.log('='.repeat(70));

console.log('\nLANDSCAPE (counts by area):\n');
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
process.stdout.write(pad('metric', 24));
for (const a of areas) process.stdout.write(padL(a, 16));
console.log();
for (const k of keys) {
  process.stdout.write(pad(k, 24));
  for (const a of areas) process.stdout.write(padL(stats[a]?.[k] || 0, 16));
  console.log();
}

console.log('\nPROPOSED ACTIONS:\n');
const totalCopies = areas.reduce((s, a) => s + (stats[a]?.['(from [[…]]) copies'] || 0), 0);
const totalMig = areas.reduce((s, a) => s + (stats[a]?.['[>] migrated'] || 0), 0);
const totalSched = areas.reduce((s, a) => s + (stats[a]?.['[<] scheduled'] || 0), 0);
const totalDmy = areas.reduce((s, a) => s + (stats[a]?.['@due dmy'] || 0), 0);
const totalDm = areas.reduce((s, a) => s + (stats[a]?.['@due dm'] || 0), 0);
const totalEffort = areas.reduce((s, a) => s + (stats[a]?.['#effort/ tags'] || 0), 0);
const topicsDone = stats['Topics']?.['done/cancelled'] || 0;

console.log(`1. Collapse copy-forwards: remove ${totalCopies} "(from [[…]])" duplicate line(s);`);
console.log(`   reset ${totalMig} "[>]" marker(s) and ${totalSched} "[<]" marker(s) to "[ ]" (unless done downstream).`);
console.log(`2. Create ${TASKS_FILE} ${existsSync(join(VAULT, TASKS_FILE)) ? '(already exists)' : '(new)'};`);
console.log(`   move ~${looseOpenDaily} open loose task(s) out of daily ## Tasks/## Inbox into it.`);
console.log(`3. Normalize dates -> ISO: ${totalDmy} DD-MM-YYYY + ${totalDm} DD-MM occurrence(s) (only in files we rewrite).`);
console.log(`4. Strip ${totalEffort} obsolete "#effort/" tag(s).`);
console.log(`5. Archive ${doneDaily} done/cancelled task(s) from daily notes. Topics keep their ${topicsDone} completed task(s) as a record.`);

console.log('\nSAMPLES:\n');
const showSamples = (title, arr) => { if (arr.length) { console.log(`  ${title}:`); for (const s of arr) console.log('    · ' + s); console.log(); } };
showSamples('(from [[…]]) copies to remove', samples.copies);
showSamples('[>] migrated markers to reset', samples.migratedMarker);
showSamples('@due DD-MM-YYYY to convert', samples.dmy);
showSamples('@due DD-MM to convert', samples.dm);
showSamples('#effort/ tags to strip', samples.effort);
console.log('End of dry run. Nothing was written.');
