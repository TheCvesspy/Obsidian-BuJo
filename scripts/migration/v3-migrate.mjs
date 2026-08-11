// Friday v3 vault migration. Report-only by default; pass --apply to write (backs up first).
//   node migrate.mjs            → report only, no changes
//   node migrate.mjs --apply    → back up BuJo/ then apply
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync, cpSync } from 'node:fs';
import { join, relative, sep, dirname } from 'node:path';

const VAULT = 'C:/Users/on079542/Obsidian Vaults/QuillWork';
const DAILY_DIR = join(VAULT, 'BuJo/Daily');
const TOPICS_DIR = join(VAULT, 'BuJo/Team/Sprints/Topics');
const TASKS_FILE = join(VAULT, 'BuJo/Tasks.md');
const APPLY = process.argv.includes('--apply');
const CUTOFF_DAYS = 30;

const TODAY = new Date(); TODAY.setHours(0, 0, 0, 0);
const CUTOFF = new Date(TODAY.getTime()); CUTOFF.setDate(CUTOFF.getDate() - CUTOFF_DAYS);
const TODAY_ISO = iso(TODAY);
const RUNSTAMP = TODAY_ISO;

const CHECKBOX = /^(\s*)-\s*\[([ xX><!/-])\]\s+(.*)$/;
const HEADING = /^#{1,6}\s+/;
const FROM_COPY = /\s*\(from\s+\[\[[^\]]+\]\]\)/g;
const EFFORT = /\s*#effort\/[SMLsml]\b/g;
const DUE = /@due\s+([\w\d\s\/-]+?)(?=\s+[@#(]|$)/i;
const PRIORITY = /#priority\/(high|medium|low)/i;
const WORK = /#(?:work|w)\/(\S+)/i;
const PURP = /#(?:purpose|p)\/(\S+)/i;
const TYPE = /#type\/\w+/i;
const DONE = /@done\s+\d{4}-\d{2}-\d{2}/i;

function iso(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function pad(n) { return String(n).padStart(2, '0'); }

/** Convert a @due raw string to ISO using contextYear for bare DD-MM. Natural language kept as-is. */
function normalizeDue(raw, contextYear) {
  const s = raw.trim();
  const p = s.split('-');
  if (p.length === 3 && p[0].length === 4) return s; // already ISO
  if (p.length === 3) { const [d, m, y] = p.map(x => parseInt(x, 10)); if (ok(d, m, y)) return `${y}-${pad(m)}-${pad(d)}`; return s; }
  if (p.length === 2 && /^\d+$/.test(p[0]) && /^\d+$/.test(p[1])) { const d = +p[0], m = +p[1]; if (ok(d, m, contextYear)) return `${contextYear}-${pad(m)}-${pad(d)}`; return s; }
  return s; // natural language (today/next friday/…)
}
function ok(d, m, y) { return d >= 1 && d <= 31 && m >= 1 && m <= 12 && !isNaN(y); }

/** Clean a raw checkbox line's BODY (text after "- [x] "): drop (from…)/#effort, convert @due→ISO. */
function cleanBody(raw, contextYear) {
  const m = raw.match(CHECKBOX);
  let body = m ? m[3] : raw;
  body = body.replace(FROM_COPY, '').replace(EFFORT, '').replace(DONE, '');
  const due = body.match(DUE);
  if (due) { body = body.replace(DUE, `@due ${normalizeDue(due[1], contextYear)}`); }
  return body.replace(/\s{2,}/g, ' ').trim();
}

/** Dedup key: body with all tags/dates stripped, lowercased. */
function keyOf(body) {
  return body
    .replace(DUE, '').replace(PRIORITY, '').replace(WORK, '').replace(PURP, '').replace(TYPE, '')
    .replace(/#[\w/-]+/g, '').replace(DONE, '')
    .replace(/\s{2,}/g, ' ').trim().toLowerCase();
}

function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name); const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.md')) out.push(full);
  }
  return out;
}
function noteDate(path) {
  const m = path.replace(/\\/g, '/').match(/(\d{4})-(\d{2})-(\d{2})\.md$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  try { return new Date(statSync(path).mtime); } catch { return TODAY; }
}

// ── Pass 1: collect every daily checkbox, grouped by dedup key ──
const dailyFiles = walk(DAILY_DIR);
const groups = new Map(); // key -> { occurrences: [{file, date, raw, status, indent}] }
for (const file of dailyFiles) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const nd = noteDate(file);
  for (const line of lines) {
    const m = line.match(CHECKBOX);
    if (!m) continue;
    const body = cleanBody(line, nd.getFullYear());
    const key = keyOf(body);
    if (!key) continue; // empty checkbox line
    const g = groups.get(key) ?? { key, occ: [] };
    g.occ.push({ file, date: nd, body, status: m[2].toLowerCase(), indent: (m[1] || '').length });
    groups.set(key, g);
  }
}

// ── Decide the fate of each group ──
const survivors = [];   // → Tasks.md
const archivedDone = []; // done/cancelled
const archivedStale = []; // open but older than cutoff
for (const g of groups.values()) {
  const anyDone = g.occ.some(o => o.status === 'x');
  const anyCancelled = g.occ.some(o => o.status === '-');
  const recency = g.occ.reduce((a, o) => o.date > a ? o.date : a, new Date(0));
  // Canonical body: prefer the occurrence with the most content (longest cleaned body).
  const best = g.occ.slice().sort((a, b) => b.body.length - a.body.length)[0];
  const rec = { key: g.key, body: best.body, count: g.occ.length, recency };
  if (anyDone) { rec.status = 'x'; archivedDone.push(rec); }
  else if (anyCancelled) { rec.status = '-'; archivedDone.push(rec); }
  else if (recency >= CUTOFF) { rec.status = ' '; survivors.push(rec); }
  else { rec.status = '-'; archivedStale.push(rec); }
}

// ── Topics: normalize dates, strip #effort, reset [>]/[<] (no task moves) ──
const topicFiles = walk(TOPICS_DIR);
let topicDueFixed = 0, topicEffortStripped = 0, topicMarkersReset = 0;
const topicRewrites = new Map();
for (const file of topicFiles) {
  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n');
  let changed = false;
  const y = 2026;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(CHECKBOX);
    if (!m) continue;
    let line = lines[i];
    if (m[2] === '>' || m[2] === '<') { line = line.replace(/\[[><]\]/, '[ ]'); topicMarkersReset++; changed = true; }
    if (EFFORT.test(line)) { line = line.replace(EFFORT, ''); topicEffortStripped++; changed = true; EFFORT.lastIndex = 0; }
    const due = line.match(DUE);
    if (due) { const norm = normalizeDue(due[1], y); if (norm !== due[1].trim()) { line = line.replace(DUE, `@due ${norm}`); topicDueFixed++; changed = true; } }
    lines[i] = line.replace(/[ \t]{2,}/g, ' ').replace(/\s+$/, '');
  }
  if (changed) topicRewrites.set(file, lines.join('\n'));
}

// ── Build Tasks.md content + archive content ──
function line(rec) { return `- [${rec.status}] ${rec.body}`; }
survivors.sort((a, b) => b.recency - a.recency);
const tasksBody = [
  '# Tasks', '',
  'Loose tasks awaiting triage. Give one a `@due`, `@snooze`, `#someday`, or a trailing `[[Topic]]` link.', '',
  ...survivors.map(line), '',
].join('\n');

const archiveBody = [
  `# v3 migration archive — ${RUNSTAMP}`, '',
  '_Auto-collapsed from daily-note copy-forwards during the Friday v3 migration._', '',
  `## Completed (${archivedDone.length})`, '',
  ...archivedDone.map(r => `- [${r.status}] ${r.body}${DONE.test(r.body) ? '' : ` @done ${iso(r.recency)}`}`), '',
  `## Abandoned — stale, never completed, older than ${CUTOFF_DAYS} days (${archivedStale.length})`, '',
  ...archivedStale.map(r => `- [-] ${r.body} @done ${iso(r.recency)}`), '',
].join('\n');
const archiveFile = join(VAULT, `BuJo/Archive/v3-migration-${RUNSTAMP}.md`);

// ── Rebuild daily notes: strip every checkbox + its indented continuations ──
function stripCheckboxes(src) {
  const lines = src.split('\n');
  const remove = new Set();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(CHECKBOX);
    if (!m) continue;
    remove.add(i);
    const indent = (m[1] || '').length;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === '') break;
      if (HEADING.test(l)) break;
      if (CHECKBOX.test(l)) break;
      if ((l.match(/^(\s*)/)?.[1].length || 0) <= indent) break;
      remove.add(j);
    }
  }
  return { text: lines.filter((_, i) => !remove.has(i)).join('\n'), removed: remove.size };
}
let dailyLinesRemoved = 0;
const dailyRewrites = new Map();
for (const file of dailyFiles) {
  const src = readFileSync(file, 'utf8');
  const { text, removed } = stripCheckboxes(src);
  if (removed > 0) { dailyRewrites.set(file, text); dailyLinesRemoved += removed; }
}

// ── Report ──
console.log('='.repeat(68));
console.log(`FRIDAY v3 MIGRATION — ${APPLY ? 'APPLY' : 'REPORT ONLY'} (today ${TODAY_ISO}, cutoff ${iso(CUTOFF)})`);
console.log('='.repeat(68));
console.log(`\nDaily copy-chains collapsed:   ${groups.size} distinct task(s) from ${[...groups.values()].reduce((s, g) => s + g.occ.length, 0)} checkbox line(s)`);
console.log(`  → survivors to Tasks.md:     ${survivors.length} (open, seen within ${CUTOFF_DAYS} days)`);
console.log(`  → archived (done/cancelled): ${archivedDone.length}`);
console.log(`  → archived (stale/abandoned):${archivedStale.length}`);
console.log(`Daily checkbox lines removed:  ${dailyLinesRemoved} across ${dailyRewrites.size} daily note(s)`);
console.log(`\nTopics cleaned in place (${topicRewrites.size} file(s)):`);
console.log(`  dates → ISO: ${topicDueFixed}   #effort stripped: ${topicEffortStripped}   [>]/[<] reset: ${topicMarkersReset}`);
console.log(`\nWrites:`);
console.log(`  ${existsSync(TASKS_FILE) ? 'overwrite' : 'create'}  BuJo/Tasks.md  (${survivors.length} tasks)`);
console.log(`  create     ${relative(VAULT, archiveFile).split(sep).join('/')}  (${archivedDone.length + archivedStale.length} tasks)`);
console.log(`  rewrite    ${dailyRewrites.size} daily note(s) + ${topicRewrites.size} topic(s)`);

console.log(`\nSAMPLE survivors → Tasks.md:`);
for (const r of survivors.slice(0, 10)) console.log('  ' + line(r) + `   [${r.count}×, last ${iso(r.recency)}]`);
console.log(`\nSAMPLE abandoned (archived):`);
for (const r of archivedStale.slice(0, 6)) console.log('  - [-] ' + r.body + `   [${r.count}×, last ${iso(r.recency)}]`);

if (!APPLY) { console.log('\nREPORT ONLY — nothing written. Re-run with --apply to execute (backs up BuJo/ first).'); process.exit(0); }

// ── APPLY ──
// Backup lives OUTSIDE the vault (sibling folder) so Obsidian never indexes it and
// re-surfaces the old tasks.
const backup = join(dirname(VAULT), `QuillWork_BuJo_backup_${RUNSTAMP.replace(/-/g, '')}`);
console.log(`\nBacking up BuJo/ → ${backup} …`);
cpSync(join(VAULT, 'BuJo'), backup, { recursive: true });

function write(path, content) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content, 'utf8'); }
write(TASKS_FILE, tasksBody);
write(archiveFile, archiveBody);
for (const [file, text] of dailyRewrites) writeFileSync(file, text, 'utf8');
for (const [file, text] of topicRewrites) writeFileSync(file, text, 'utf8');
console.log('APPLIED. Backup is safe; reload Obsidian to see the result.');
