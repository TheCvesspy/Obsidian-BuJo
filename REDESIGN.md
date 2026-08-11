# Friday v3 — Streamlined Task Redesign

> Design proposal. Nothing is built or migrated yet. Review, edit inline, and approve.
> Decisions locked with the user are marked ✅. Open micro-decisions are marked ❓ at the bottom.

## 1. Principles

1. **One home per task.** A task is written in exactly one place and never copied.
2. **Two homes, nothing else.**
   - `BuJo/Tasks.md` — the central inbox for loose tasks (not yet tied to a Topic). ✅
   - **Topic files** (`BuJo/Team/Sprints/Topics/*.md`) — keep their own `## Tasks` lists as the source of truth for that Topic's work. The plugin *reads* them, never moves them. ✅
3. **Tasks float by date, not by ritual.** No morning shuffle, no `[>]`, no `(from [[…]])` duplicates. An unfinished task simply keeps showing up until it's done, snoozed, or dropped. ✅
4. **Postpone is first-class**, in two flavors, so Overdue only ever contains things that are genuinely late and still wanted. ✅
5. **The inbox stays small on its own** via auto-archiving of completed items. ✅
6. **Daily notes are a journal**, not a task store — capture + time log only. A command funnels captures into `Tasks.md`.

## 2. The model

### 2.1 Homes and flow

```
   capture                    triage                     work
┌───────────────┐   sweep   ┌───────────────┐  assign  ┌──────────────────┐
│ Daily ## Inbox │ ───────▶ │  BuJo/Tasks.md │ ───────▶ │ Topic ## Tasks    │
│ (quick jots)   │          │ (loose tasks)  │          │ (source of truth) │
└───────────────┘          └───────┬───────┘          └────────┬─────────┘
                                    │  auto-archive done         │
                                    ▼                            ▼
                            BuJo/Archive/Tasks-YYYY-MM.md   (aggregated by plugin)
```

The plugin scans **both** homes (plus any other page that happens to contain checkboxes) and merges everything into one in-memory task list. Every view is a filter over that one list — so a task shows up in "Today" whether it lives in `Tasks.md` or inside the DOCSIS topic. Its Topic/page is always shown as its source link, preserving the linkage you care about.

### 2.2 One date only ✅

A task carries a single scheduling date: `@due`. There is **no** separate "do date." Overdue = `@due` is in the past and the task is open and not snoozed.

### 2.3 Postpone — two flavors ✅

| Flavor | Syntax | Meaning | Effect on views |
|--------|--------|---------|-----------------|
| **Snooze** | `@snooze <date>` | "Not now — hide until this date." Deadline (`@due`) stays honest. | Removed from **Today** and **Overdue** while `today < snooze`. Wakes automatically on the snooze date and reappears under its `@due`. |
| **Someday** | `#someday` | "Maybe, no timeline." | Leaves **all** dated views. Lives only in the **Someday** list, reviewed periodically. Reactivate by giving it an `@due` or removing the tag. |

> Why `@snooze` is not a second planning date: it's a *suppression* modifier, not a "when I'll work it" date. It exists only to keep Overdue clean. This stays consistent with the "one date only" decision — `@due` remains the single date that schedules the task.

### 2.4 Statuses — simplified

Drop the copy-era markers. Keep three:

| Marker | Status |
|--------|--------|
| `- [ ]` | Open |
| `- [x]` | Done |
| `- [-]` | Cancelled / dropped |

`[>]` (migrated) and `[<]` (scheduled) are **removed** — the concepts they encoded no longer exist. Migration will convert any existing `[>]`/`[<]` back to `[ ]` (or `[x]`/`[-]` if it was completed downstream). The parser stays tolerant of the old markers so nothing breaks mid-migration.

### 2.5 Cleaning: auto-archive completed ✅

On startup (and via a command), Done/Cancelled tasks older than `archiveCompletedAfterDays` (default **7**) are moved out of `Tasks.md` into `BuJo/Archive/Tasks-YYYY-MM.md`. The inbox therefore only ever shows live work. Topic task lists are archived too, but only if you opt in per setting (default: leave Topic history in place, since Topics are also a record).

## 3. Syntax (new, minimal)

```markdown
- [ ] Draft the ROP attribute list @due 2026-08-20 #priority/high [[IK ROP TABULKA Topic]]
- [ ] Call Michal Vokr about DOCSIS standard @due 2026-08-14 @snooze 2026-08-25
- [ ] Investigate a better bulk-filter approach for PB-3062 #someday
- [ ] Add Denys + Michal Novák to the team #w/CO
```

| Token | Purpose | Notes |
|-------|---------|-------|
| `@due <date>` | The one scheduling date | ISO `YYYY-MM-DD` (see ❓ Q1). Natural language still parsed (`tomorrow`, `next friday`, `eow`). |
| `@snooze <date>` | Hide until | Same date grammar as `@due`. |
| `#someday` | Dateless backlog | |
| `[[Topic or Page]]` | Link to a Topic/page | Preserves linkage for loose tasks in `Tasks.md`. Topic tasks already have their file as the source. |
| `#priority/high\|medium\|low` | Priority | Unchanged. |
| `#w/<code>` `#p/<code>` | Work type / purpose | Unchanged — used in your analytics. |

Removed tokens: `(from [[…]])`, `#effort/…` (already deprecated). Migration strips them.

## 4. Views — from 9 tabs down to 5

The strategic **Topics** browser (List / Impact-Effort / Roadmap) is untouched — it's good. The *task* side collapses to four focused views:

| View | Contents |
|------|----------|
| **Today** | Open tasks with `@due` today or overdue, **excluding** snoozed and someday. Grouped by Topic/page. Your daily driver. |
| **Upcoming** | Open tasks due in the next N days (default 14) + snoozed tasks waking in that window. |
| **Inbox / Triage** | Un-triaged loose tasks (no Topic link **and** no date) from `Tasks.md` + freshly swept daily captures. The list you empty. |
| **Someday** | `#someday` tasks, for periodic review. |
| **Topics** | Unchanged (List / Impact-Effort / Roadmap). |

Retired as top-level tabs: Daily, Weekly, Monthly, Calendar, Sprint, Overdue, Overview, Analytics. (See ❓ Q2 — pick which of these you actually want to keep. Overdue folds into Today; Sprint lives inside Topics; Analytics can stay behind a command.)

## 5. Commands

| Command | Does |
|---------|------|
| **Snooze task…** | Prompts for a date, writes `@snooze`. Context-menu on any checkbox line too. |
| **Send to Someday** | Adds `#someday`, strips `@due`/`@snooze`. |
| **Wake task** | Removes `@snooze`/`#someday`, back to active. |
| **Sweep daily Inbox → Tasks.md** | Moves today's (or all) daily `## Inbox` lines into `Tasks.md`. |
| **Move task to Topic…** | Fuzzy-pick a Topic; relocates the line into that Topic's `## Tasks`. |
| **Archive completed** | Runs the cleaning pass now. |
| **Quick create task** | Kept; defaults target = `Tasks.md`. |

Removed: **Run Daily Migration** (the whole morning-shuffle modal goes away).

## 6. Plugin code changes (by file)

- `types.ts` — add `snoozeDate: Date|null`, `someday: boolean`, `topicLink: string|null` to `TaskItem`; new settings `tasksFilePath` (`BuJo/Tasks.md`), `archiveCompletedAfterDays` (7), `dateFormat` (`iso`), `upcomingWindowDays` (14). Deprecate `Migrated`/`Scheduled` in `TaskStatus` (keep for parse tolerance).
- `constants.ts` — add `SNOOZE_REGEX`, `SOMEDAY_TAG`; ISO date support in `DUE_DATE_REGEX`.
- `parser/dateParser.ts` — parse ISO `YYYY-MM-DD` (keep DD-MM-YYYY + natural language as fallbacks).
- `parser/taskParser.ts` — extract `@snooze`, `#someday`, and a leading/trailing `[[link]]` as `topicLink`.
- `services/taskStore.ts` — replace date buckets with `getToday()`, `getUpcoming()`, `getInboxTriage()`, `getSomeday()`; snooze/someday exclusion baked into the "active" filter.
- `services/taskWriter.ts` — `setSnooze`, `clearSnooze`, `setSomeday`, `moveToTopic`, `sweepDailyInbox`.
- `services/migrationService.ts` — **retire** copy/forward logic; repurpose file into `cleanupService.ts` (auto-archive) or delete.
- `services/archiveService.ts` — add age threshold + inbox-scoped archiving.
- `ui/` — new `TodayView`, `UpcomingView`, `TriageView`, `SomedayView`; retire the deprecated view components; trim `ViewSwitcher` to 5 tabs. Remove `MigrationModal`. Add `SnoozeModal`, `MoveToTopicModal`.
- `main.ts` — re-wire commands, drop migration-on-startup, add cleanup-on-startup.

Roughly: ~6 files changed, ~4 new UI files, ~5 files deleted. Net **smaller** codebase.

## 7. Vault migration (the irreversible part — done carefully)

**Safety first (vault is not under git):**
0. Copy the whole `BuJo/` tree to `BuJo_backup_<date>/` (or a zip in the vault root) before any write. Produce a dry-run report first; only apply after you approve it.

Steps (each idempotent, with a before/after count report):
1. **Collapse copies.** For every `[>]` task and its `(from [[…]])` duplicates across daily notes: keep the origin line only, delete the daily-note copies, reset the origin to `[ ]` (or `[x]`/`[-]` if it was finished downstream).
2. **Create `BuJo/Tasks.md`.** Move loose daily-note `## Tasks` / `## Inbox` items **not** tied to a Topic into it, preserving `@due` and priority. Drop `(from …)` links.
3. **Leave Topic `## Tasks` in place.** No change except date/tag normalization.
4. **Normalize.** Dates → ISO; strip `#effort/…` and stray `(from [[…]])`; convert old statuses.
5. **Archive.** Move already-Done/Cancelled tasks to `BuJo/Archive/Tasks-YYYY-MM.md`.
6. **Report.** Print tasks touched, files changed, copies removed, items archived.

## 8. Phasing

- **Phase 0** — this doc, approved.
- **Phase 1 (plugin)** — parser + store + writer + settings for `@snooze`/`#someday`/one-date model. Backward-compatible: reads your current files without breaking.
- **Phase 2 (plugin)** — new views (Today / Upcoming / Triage / Someday), trimmed tab bar, new commands, retire migration modal + cleanup service.
- **Phase 3 (vault)** — dry-run migration report → your approval → apply with backup.
- **Phase 4** — docs (ARCHITECTURE.md + SyntaxReference), release bump.

Plugin phases (1–2) are safe and reversible. The vault migration (3) is the only step that changes your data, and it backs up first + shows a dry run.

## 9. Resolved decisions ✅

- **Q1 — Date format:** **ISO** `YYYY-MM-DD` everywhere. Migration converts existing `DD-MM-YYYY`. Natural language still parsed.
- **Q2 — Tabs:** the **5 core tabs + Calendar** (6 total). Analytics reachable via a command, not a tab. Weekly/Monthly/Sprint/Overdue/Overview retired (Sprint lives inside Topics; Overdue folds into Today).
- **Q3 — Archive age:** **7 days** before completed tasks leave `Tasks.md`.
- **Q4 — Topic auto-archive:** **No** — completed tasks stay inside Topic files as a permanent record. Only `Tasks.md` auto-cleans.
