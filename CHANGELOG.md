# Changelog

All notable changes to the Friday Obsidian plugin (formerly *BuJo*) are tracked here.

## Unreleased

### Docs

- **ARCHITECTURE.md §15 rewritten for the v3 Kanban model.** The chapter still documented the retired sprint system (`sprint`/`sprintHistory` keys, `assignTopicToSprint`, "Active sprint" scope). It now covers the current topic frontmatter schema (incl. `snoozedUntil`, flow timestamps, `assignee`/`waitingOn`, `blockedBy`, `refs`), the Board's ownership groups / Blocked strips / Snoozed shelf, derived-block vs snoozed semantics, card signals (aging badge, JIRA drift, snooze chips), filter persistence, lifecycle features (snooze, dated notes, archiving), the real `SprintTopicService` API, and the topic command + MCP tool lists. Also refreshed: TOC, §2 file reference (`sprintTopicService.ts`, `topicParser.ts`), §5 topic commands, §6 view-mode table (dropped the removed Sprint view), §8 Morning Review (new "Woke from snooze" section). ([ARCHITECTURE.md](ARCHITECTURE.md))

### Added

- **Board splits into "My topics" vs "Team topics", with Blocked strips and an Unassigned pool.** The Topics Board previously rendered one four-column Kanban over everything, so a lead's own work drowned in the team's, and blocked cards crowded In Progress without being workable. Now, when `settings.jiraEmail` is set **and** at least one topic has an assignee, the board renders two ownership groups — **👤 My topics** (assigned to me) and **👥 Team topics** (assigned to someone else) — each with its own Backlog / To Do / In Progress / Done columns. **Blocked topics leave the status columns entirely** and gather in a red **🛑 Blocked strip** per group (derived block state: manual flag OR open JIRA flag/blocker OR unfinished dependency topic). **Unassigned topics ride with "My topics" as a 📥 Unassigned strip** — unowned work is the lead's to hand out. Both strips are drop targets: drop a card on Blocked to flag it blocked, on Unassigned to clear its owner; drag a blocked card into any status column and the manual blocked flag clears ("work resumes here") — with a notice when a dependency/JIRA block keeps it in the strip anyway. WIP limits stay a board-wide policy: with a limit set, the column pill shows the cross-group total (`total / limit`), and breaches highlight in every group. Vaults without an identity or without any assignees keep the old single board (plus the Blocked strip), so solo setups don't degrade. ([src/ui/components/TopicsOverviewView.ts](src/ui/components/TopicsOverviewView.ts), [styles.css](styles.css))

- **Aging badge on in-progress topic cards.** A topic that has sat in In Progress past `agingWipThresholdDays` (default 7, already used by Analytics) now shows an orange **⏱ Nd** badge in the card header, with the since-date in the tooltip — stalled work is visible where you look, not only in the Analytics tab. ([src/ui/components/TopicCard.ts](src/ui/components/TopicCard.ts), [src/ui/components/TopicsOverviewView.ts](src/ui/components/TopicsOverviewView.ts), [styles.css](styles.css))

- **Morning Review surfaces topics that woke from snooze.** New "Woke from snooze" section: topics whose `snoozedUntil` has passed but wasn't cleared (they're already back in their board column). Each row offers **Back on board** (clears the stale snooze) or **+1 week** (renews it from today), so a wake is a decision, not an accident. Rows disappear once acted on. ([src/ui/MorningReviewModal.ts](src/ui/MorningReviewModal.ts))

- **JIRA drift detection on topic cards.** When a topic's Kanban state contradicts its linked issues, the card shows a **⚠ JIRA drift** chip with the reasons in the tooltip: *topic Done but an issue is still open in JIRA*, or *every linked issue resolved but the topic isn't done*. Only cached issue data is consulted, so the chip never fires on stale/partial info; multi-key topics only count as "resolved" when **all** keys are done. ([src/ui/components/TopicCard.ts](src/ui/components/TopicCard.ts), [styles.css](styles.css))

- **Topic archiving.** New command **"Friday: Archive done topics"** (done longer than the hide-window / 30d / 90d / all) moves old done topics into `{topicsFolder}/Archive/` via `fileManager.renameFile` (wiki-links stay intact; `blockedBy` edges are rewritten by the existing rename hook). The scanner now **excludes the Archive/ subfolder**, so archived topics vanish from every view and stop being parsed on each scan — the folder and the cache stay lean. Age = `doneAt` (fallback `statusSince`); undateable legacy topics are only swept by "All done topics". Name clashes are skipped, never overwritten. Restore = move the file back out of `Archive/`. ([src/services/sprintTopicService.ts](src/services/sprintTopicService.ts), [src/services/vaultScanner.ts](src/services/vaultScanner.ts), [src/main.ts](src/main.ts))

- **Dated status notes on topics — command + MCP tool.** New command **"Friday: Add note to topic"** (pick topic → one-line prompt) and MCP tool **`topic_add_note`** append `- **YYYY-MM-DD** — <note>` to the END of the topic's `## Notes` section (created if missing; newest last, a chronological decision/status log — 1:1 and steering-meeting material). New generic `TextPromptModal` for one-line prompts. ([src/services/sprintTopicService.ts](src/services/sprintTopicService.ts), [src/ui/TextPromptModal.ts](src/ui/TextPromptModal.ts), [src/mcp/tools/topics.ts](src/mcp/tools/topics.ts), [src/main.ts](src/main.ts))

- **Topics-view filters survive refreshes.** The scope filter, assignee filter, roadmap zoom/grouping, and roadmap scroll position previously reset on every data refresh, because the whole view object is rebuilt per render. They're now backed by module-level state (same pattern as the Snoozed shelf's collapse state), so changing a topic no longer silently resets your filters. ([src/ui/components/TopicsOverviewView.ts](src/ui/components/TopicsOverviewView.ts))

- **Topics can be snoozed (deliberately deferred) — distinct from blocked.** Blocked = work should continue but can't; snoozed = we've decided not to work on this for a while. New `snoozedUntil: YYYY-MM-DD` frontmatter field (managed, canonical order, `topic_update` MCP + DTO support, edit-modal date field). While the date is in the future the topic leaves its status column and parks on a collapsed **💤 Snoozed shelf** at the bottom of the Board (click to expand; cards sorted by wake date); on the wake date it returns to its column automatically — status is never touched, so it wakes exactly where it left. Cards get a **💤 snooze button** (presets: 1 week / 2 weeks / 1 month / 3 months, or "Until a date…"), snoozed cards a **💤 Wake** button and an "until \<date\>" chip; an expired-but-uncleared snooze shows an orange "woke \<date\>" chip so the return is noticed. The List view marks snoozed rows with 💤 and dims them. Also a new palette command **"Friday: Snooze topic"** (pick topic → preset/date/wake). Done topics are never treated as snoozed. ([src/types.ts](src/types.ts), [src/parser/topicParser.ts](src/parser/topicParser.ts), [src/services/topicStatus.ts](src/services/topicStatus.ts), [src/services/sprintTopicService.ts](src/services/sprintTopicService.ts), [src/ui/components/TopicCard.ts](src/ui/components/TopicCard.ts), [src/ui/components/TopicsOverviewView.ts](src/ui/components/TopicsOverviewView.ts), [src/ui/SprintTopicModal.ts](src/ui/SprintTopicModal.ts), [src/mcp/tools/topics.ts](src/mcp/tools/topics.ts), [src/main.ts](src/main.ts), [styles.css](styles.css))

### Changed

- **Daily Migration is repurposed into the Morning Review.** v3 already made tasks *float by date* — an unfinished task keeps surfacing in the **Today** view (overdue + due today, across every home) until it's done, snoozed, or dropped — so the old morning-shuffle modal was duplicating Today with a dead carry-forward. The modal is now a focused start-of-day **nudge surface** with no task-shuffle: **Overdue 1:1s** (team members whose cadence has elapsed), **Waiting on** (topics you're waiting on that have gone quiet), and a **Quick capture** box. The redundant task sections (Yesterday's Incomplete / Overdue / Due Today), the Forward/Reschedule/Done/Cancel actions, and the "pick tasks to add to today" pickers are gone — that triage lives in the Today view. Renamed throughout: command **"Run Daily Migration" → "Morning Review"** (id `run-daily-migration` → `open-morning-review`), setting `migrationPromptOnStartup` → `morningReviewOnStartup`, service `MigrationService` → `MorningReviewService`, modal `MigrationModal` → `MorningReviewModal`, and plugin data `lastMigrationDate` → `lastMorningReviewDate`. Old saved values for the setting and the daily-guard date are migrated automatically on load. New daily notes also drop the now-dead `## Migrated Tasks` heading (`## Inbox` + `## Tasks` only). ([src/services/morningReviewService.ts](src/services/morningReviewService.ts), [src/ui/MorningReviewModal.ts](src/ui/MorningReviewModal.ts), [src/main.ts](src/main.ts), [src/services/dailyNoteService.ts](src/services/dailyNoteService.ts))

- **Topic frontmatter is written in a canonical, grouped order.** Keys now follow `TOPIC_FRONTMATTER_ORDER` (in `topicParser.ts`): triage (`status`, `priority`, `jira`) → ownership (`assignee`, `waitingOn`, `lastNudged`) → schedule (`startDate`, `dueDate`) → strategy (`impact`, `effort`) → mechanics (`blocked`, `sortOrder`) → auto-stamped flow timestamps (`statusSince`, `startedAt`, `doneAt`) → multi-line relations (`blockedBy`, `refs`, kept last). New topics are created in this order, and every in-place edit (`rebuildWithFrontmatter`) re-sorts to it, so a topic's header layout stays consistent over time. Unknown/legacy keys (e.g. `sprint`) keep their relative order and sink to the end. Values are untouched. ([src/parser/topicParser.ts](src/parser/topicParser.ts), [src/services/sprintTopicService.ts](src/services/sprintTopicService.ts))

- **Morning migration stops copying tasks into the daily note.** "Forward" used to mark the source `[>]` migrated and write a duplicate `- [ ] task (from [[source]])` line under `## Migrated Tasks` in today's daily note. That created two artifacts for one piece of work, polluted daily notes with second-hand copies of tasks that lived in Topics / project pages, and required a two-way-sync mechanism to keep the checkbox state in lockstep. Now Forward just **sets `@due` to today on the source task** — the Daily dashboard picks it up through its existing "Due Today" bucket via normal aggregation. The source task stays in its original location, single point of truth, no duplicates. The picker's "Add Selected to Today" button (and the MCP-driven equivalents) follow the same rule: pick a task or open point, get `@due today` stamped on the source.

  **What changes downstream**
  - `MigrationService.executeMigrations` `forward` case: delegates to a new `scheduleForToday(tasks)` helper that just calls `TaskWriter.updateDueDate(task, DD-MM-YYYY)` per task. No more `addMigratedTask` / `addMigratedTaskWithChildren` calls, no more `[>]` status mutation on the source.
  - `MigrationModal` "Add Selected to Today" button: same code path. Picker results route through `scheduleForToday` instead of writing copies. Feedback text changes from "Added N item(s) to today's daily note" to "Scheduled N item(s) for today".
  - Children: no longer separately copied or status-mutated. They ride along by parent linkage — the parent's new `@due today` is enough for the dashboard to surface the whole subtree.
  - `DailyView` (the Daily tab in the Friday dashboard): the **Carried Over** section is gone. It was populated by the now-absent forwarded copies; legacy carried-over entries from old daily notes (pre-change) fall into **Daily Log** instead, since they're physically in today's note. Section order is now: Overdue → Due Today → Daily Log → Upcoming.
  - `DailyNoteService.addMigratedTask` and `addMigratedTaskWithChildren` removed (no remaining callers). `addTaskToDaily` / `addRawTaskLine` / `addRawInboxLine` stay — they back QuickCapture, the Add Task bar, and the `tasks_add_to_daily` MCP tool, all of which represent the user **explicitly writing new content** into today's note (not a duplication of existing content).
  - Two-way sync (`TaskWriter.syncOriginalStatus`, `VaultScanner.detectAndSyncStatusChanges`) is kept in place — legacy users still have carried-over copies in old daily notes from before this change, and ticking those should continue to mirror back to the originals. Will be removable once that legacy data drains.
  - `MigrationService.deduplicateDailyTasks` likewise stays as a legacy-data safeguard — no new duplicates will be created, but old ones still need to be collapsed when surfaced in the review.

  **What stays the same** — Reschedule (per-task date picker), Done, and Cancel actions are unchanged. The morning review still surfaces "Yesterday's Incomplete", "Overdue", and "Due Today" sections, drawing from the same aggregation pipeline. The `lastMigrationDate` stamp still gates the auto-open behavior.

### Files

- `src/services/migrationService.ts` — new `scheduleForToday(tasks)` helper; `forward` case rewritten to use it.
- `src/ui/MigrationModal.ts` — "Add Selected to Today" handler routes through `scheduleForToday`.
- `src/services/dailyNoteService.ts` — `addMigratedTask` / `addMigratedTaskWithChildren` deleted (callers updated).
- `src/ui/components/DailyView.ts` — Carried Over bucket and section removed; section order updated.

### Changed

- **The Topics view splits into 👤 Mine / 👥 Team tabs; assignees get visual identity on the Team tab.** The in-board My/Team grouping (added earlier in this cycle) stacked two full boards vertically — workable, but each half competed for space. It's now a proper **tab bar** (with live topic counts) at the front of the Topics header that scopes **every sub-mode** (Board / List / Roadmap / Impact-Effort): *Mine* = my + unassigned topics (unassigned still gets its 📥 strip on the board), *Team* = topics assigned to others. The tab choice persists across refreshes (module-level state). The Blocked strip and Snoozed shelf render per-tab; **WIP-limit pills still count across both tabs** (the pre-tab filtered set), so a limit means the same thing wherever you look. The assignee dropdown drops its now-redundant Mine / Assigned out / Unassigned lenses while the tabs are active (hidden entirely on the Mine tab; stale persisted values sanitize back to "all"). Vaults without an identity (`jiraEmail`) or without any assignees keep the classic single view. **Team-tab readability:** each card shows a prominent assignee identity — a colored initials avatar (deterministic hue hashed from the member's email, so a person keeps their color everywhere) plus their name in bold right under the title — replacing the small muted chip; the List view's Assignee column gets the same avatar + bold name treatment. ([src/ui/components/TopicsOverviewView.ts](src/ui/components/TopicsOverviewView.ts), [src/ui/components/TopicCard.ts](src/ui/components/TopicCard.ts), [styles.css](styles.css))

- **Dialog & row-action polish per the official Obsidian plugin guidelines.** Sweep of the UI/UX audit findings:
  - **Sentence case + native titles**: modal headings now use `Modal.setTitle()` (theme-consistent, announced by screen readers) instead of raw `<h2>`/`<h3>`, with guideline-compliant casing — "Quick create task", "Edit task", "Set due date".
  - **Keyboard**: `TaskEditModal` gains **Ctrl/Cmd+Enter** save-from-anywhere (plain Enter stays reserved for newlines in the description textarea). Row actions and the description toggle are now **real `<button>`s** — focusable and keyboard-activatable, with a visible focus ring and hover-style reveal on `focus-within` (previously `<span>`s, invisible to keyboard users).
  - **Native look**: row actions and the triage processor's decision grid use **Lucide icons via `setIcon`** (theme-colorable) instead of emoji — calendar / alarm-clock / pin / moon / check / x / undo-2 / pencil; **Drop is styled as a destructive action** (`--text-error`). Tooltips route through the API's `setTooltip` (plus explicit `aria-label`) instead of the raw `title` attribute.
  - **Topic picker**: core-style key-hint footer (`setInstructions`: ↑↓ / ↵ / esc) and **fuzzy-match highlighting** restored via `renderResults`.
  ([src/ui/InsertTaskModal.ts](src/ui/InsertTaskModal.ts), [src/ui/TaskEditModal.ts](src/ui/TaskEditModal.ts), [src/ui/DueDateModal.ts](src/ui/DueDateModal.ts), [src/ui/TopicPickerModal.ts](src/ui/TopicPickerModal.ts), [src/ui/TriageProcessModal.ts](src/ui/TriageProcessModal.ts), [src/ui/components/TaskItemRow.ts](src/ui/components/TaskItemRow.ts), [src/ui/components/TriageView.ts](src/ui/components/TriageView.ts), [styles.css](styles.css))

### Added

- **Full task-edit dialog (✏️) on every dashboard row.** Rows previously offered only point actions (toggle, snooze, someday); changing a task's text, priority, or tags meant opening the source file. A new ✏️ action on every row (all views, any status) opens **Edit Task** (`TaskEditModal`) with the complete v3 field set: **text, status** (open/done/cancelled/migrated/scheduled), **priority, due date, snooze-until, Someday toggle, type** (auto/task/openpoint), **work type, purpose, description**. The dialog saves a **diff** — only fields you actually changed are rewritten. New `TaskWriter.updateTaskFields(task, edits)` rebuilds the line by parsing current tokens with the same regexes (and order) as `taskParser`, so untouched metadata survives verbatim: natural-language raw dates (`@due next friday`), `(from [[…]])` annotations, `@done` stamps, and the trailing `[[Topic]]` link (kept in tail position, per the parser contract). Status changes route through the shared `@done`-stamp logic (closing stamps, reopening strips); turning Someday on clears due & snooze on save (same contract as `setSomeday`); editing the description replaces only the task's immediate indented block — child subtasks and their descriptions are untouched. Unresolved raw dates are flagged in the dialog ("currently `@due next friday`") and only replaced if you pick a date. ([src/ui/TaskEditModal.ts](src/ui/TaskEditModal.ts), [src/services/taskWriter.ts](src/services/taskWriter.ts), [src/ui/components/TaskItemRow.ts](src/ui/components/TaskItemRow.ts), [src/ui/FridayView.ts](src/ui/FridayView.ts))

- **Triage becomes an actual triaging interface, not just a list.** The Triage board previously showed loose items but only offered snooze/someday — two of the four v3 triage verbs ("date it, snooze it, send it to a Topic, or drop it") had no UI. Now, in two layers:
  - **Inline row actions**: Triage rows gain 📅 *Set due date* (opens the date picker, writes `@due`), 📌 *Send to topic* (fuzzy topic picker), and ✖ *Drop* (marks `[-]` cancelled; the v3 inbox auto-archive sweeps it later) alongside the existing ⏰ snooze and 💤 someday — every triage decision is now one click from the board. Other views keep the base action set.
  - **Focus mode (⚡ Process)**: a button in the Triage header opens a card-by-card processor (`TriageProcessModal`) — one item, one decision. Big action buttons with keyboard shortcuts: `c` done, `d` due date, `s` snooze (opens a preset strip: `1`–`5` for tomorrow/3 days/next week/2 weeks/month, `p` to pick a date), `t` topic, `m` someday, `x` drop, `→`/space skip, `←` back, Esc closes. Progress bar + counter, and an end-of-queue summary (`4 dated · 3 to topics · 2 snoozed…`). Works off a snapshot; every action writes through the same `TaskWriter` paths as the board, so the view behind refreshes live.
  - **"Send to Topic" = physical move.** The task line **plus its indented children/description block** is removed from its source (`Tasks.md` or a daily-note `## Inbox`) and prepended to the target topic's `## Tasks` section — consistent with the v3 ownership model (topics own their tasks; no trailing `[[link]]` needed) and with the `tasks_create` MCP tool's topic routing. New `TaskWriter.removeTaskBlock(task)` extracts the block atomically (locates via `locateTaskLine`, captures deeper-indented continuation lines incl. interior blanks, dedents to column 0); the topic file's existence is checked *before* removal so a bad target can't lose the task. The topic picker (`TopicPickerModal`, a `FuzzySuggestModal`) orders topics by Kanban flow — in-progress → open → backlog → done. ([src/ui/TriageProcessModal.ts](src/ui/TriageProcessModal.ts), [src/ui/TopicPickerModal.ts](src/ui/TopicPickerModal.ts), [src/ui/components/TriageView.ts](src/ui/components/TriageView.ts), [src/ui/components/TaskItemRow.ts](src/ui/components/TaskItemRow.ts), [src/ui/FridayView.ts](src/ui/FridayView.ts), [src/services/taskWriter.ts](src/services/taskWriter.ts), [styles.css](styles.css))

- **`tasks_create` MCP tool — create a task the same way the "Quick Create Task" command does, with topic routing.** The MCP layer previously had no true task-creation tool aligned with the v3 model: `tasks_add_to_daily` writes into a daily note and can't emit `#type/`, `#w/`, `#p/`, or a description block. The new **`tasks_create`** tool reuses the plugin's own `buildTaskBlock` (the exact formatter behind the Quick Create Task modal), so the emitted Markdown — `#priority/<level>`, `@due <date>`, `#type/<type>`, `#w/<workType>`, `#p/<purpose>`, plus an indented multi-line `description` — stays identical to the UI. **Destination follows the v3 ownership model:** by default the task lands in the central **`Tasks.md` inbox** (`settings.tasksFilePath`) for triage; if you pass **`topic`** (its title or file path), the task is instead written to the **top of that topic's `## Tasks` section** — where the topic owns it, so no trailing `[[link]]` is needed — and the topic parser counts it in `taskTotal`/`taskDone`. `workType`/`purpose` are validated against the short codes configured in settings (an unknown code returns an error listing the valid ones); `due` is validated by the same `parseDueDate` the rest of the MCP layer uses. Topic references resolve by exact file path, then case-insensitive title, then basename, with a readable error (pointing at `topics_list`) when missing or ambiguous. The response reports `target: "inbox" | "topic"`, the destination `path`, and the rendered `block`. `tasks_add_to_daily` is unchanged and remains the right tool when a task should live in a specific daily note. ([src/mcp/tools/tasks.ts](src/mcp/tools/tasks.ts), [src/services/sprintTopicService.ts](src/services/sprintTopicService.ts), [src/services/tasksInboxService.ts](src/services/tasksInboxService.ts), [src/ui/InsertTaskModal.ts](src/ui/InsertTaskModal.ts), [src/main.ts](src/main.ts))

- **Team members & 1:1 planning are now controllable via the Friday MCP.** The MCP server previously exposed only task and topic tools; team management was UI-only. Six new tools cover it end to end, all operating on the canonical person pages (`{teamFolderPath}/{Name}/{Name}.md`) and `1on1/YYYY-MM-DD.md` session files: **`team_members_list`** (roster with each member's `cadenceState` — on-track / due-soon / overdue / never / suspended — and `daysSinceLast`; excludes departed by default), **`team_member_get`** (one member by name / email / JIRA identity, incl. session paths), **`oneonones_due`** (active members whose 1:1 is overdue, optionally including due-soon; most-overdue first), **`oneonone_log`** (records a held 1:1 by creating a dated session page with an optional agenda — idempotent, and advances the cadence clock since `lastOneOnOne` is derived from session filenames), **`team_member_create`** (new person page with role / email / cadence / status / startDate; fails on duplicate), and **`team_member_update`** (edit role / email / jiraIdentity / startDate / cadence / status; empty string clears a field). Writes trigger a rescan so follow-up reads are consistent; member lookups accept name, email, or JIRA identity (case-insensitive). New service surface — `findMember`, `createMemberPage`, `updateMemberFrontmatter` — writes person-page frontmatter while preserving unmanaged keys verbatim. ([src/mcp/tools/team.ts](src/mcp/tools/team.ts), [src/services/teamMemberService.ts](src/services/teamMemberService.ts), [src/main.ts](src/main.ts))

- **Create topics from JIRA issue keys.** New command **"Friday: Create topic from JIRA issue"** prompts for one or more keys (`JiraKeyPromptModal`; comma/space-separated, lowercase accepted) and, via a shared helper (`createTopicFromJiraInfo`), fills each topic from the fetched issue: title ← summary, `jira` ← key (the link), `priority` ← mapped JIRA priority, `dueDate` ← JIRA due date, `startDate` ← today when a (future) due date exists so the topic draws a real bar on the Roadmap, `assignee` ← resolved team member (JIRA email first, then name/nickname match), and the **description** flattened into the topic's Notes (links preserved as `[text](url)`, capped at ~2k chars; one-time snapshot, not synced). A **duplicate guard** skips keys already linked to a topic — a single key opens its existing/created note, a batch reports a created/skipped/failed summary. Also exposed as the **`topic_create_from_jira`** MCP tool (same behaviour, dedupe included). The `JiraService` fetch now also pulls `priority`, `duedate`, assignee email, and `description`; `mapJiraPriority` moved to `JiraService` and is shared with the JIRA Dashboard's existing "Create topic from this issue". ([src/main.ts](src/main.ts), [src/ui/JiraKeyPromptModal.ts](src/ui/JiraKeyPromptModal.ts), [src/services/jiraService.ts](src/services/jiraService.ts), [src/services/topicFromJira.ts](src/services/topicFromJira.ts), [src/mcp/tools/topics.ts](src/mcp/tools/topics.ts))

- **"Sync topic dependencies from JIRA" — command + MCP tool.** Walks every topic linked to a JIRA issue, reads each issue's "is blocked by" links, and wires a topic `blockedBy` dependency wherever the blocking issue is also linked to a topic (cycles/self/duplicates rejected). The command reports how many links it added; the **`topic_sync_dependencies`** MCP tool returns `{ scanned, added, rejected }`. Both share one implementation (`syncTopicDependenciesFromJira`). This replaces wiring blockers at create-time — which rarely fired, since a blocker usually has no topic yet when its dependent is first imported — with an idempotent, on-demand pass that resolves dependencies across the whole board at once. ([src/main.ts](src/main.ts), [src/services/topicFromJira.ts](src/services/topicFromJira.ts), [src/mcp/tools/topics.ts](src/mcp/tools/topics.ts))

- **Roadmap timeline rebuilt as a proper, scrollable Gantt-style view.** The Topics → Roadmap sub-mode no longer squeezes every topic into the visible width. It now uses a **fixed pixels-per-day scale** so distances are meaningful, opens **centred on the current week**, and lets you **scroll into the past and future** (scrollbar, drag-to-pan anywhere on the timeline, or Shift+scroll). A **Zoom** control switches between **Day / Week / Month** (day shows day-number ruler + weekend shading; week shows ISO week numbers; month shows a year band + month ruler), and **⌖ Today** recentres. The focus date is preserved across zoom changes. A two-tier axis header and a frozen left column (group + topic labels) stay pinned while the timeline scrolls; the today line, week/month gridlines, and weekend shading sit behind the bars. Bar colour still encodes blocked / done / overdue / critical-path. **A long board now scrolls vertically inside the roadmap** (capped height, with the time axis pinned to the top and the label column frozen at the left), and **completed topics are hidden** from the roadmap to conserve space — unless the "Done" scope filter is active — with a "N done hidden" note in the controls. Drag-to-pan now moves both axes. ([src/ui/components/TopicsOverviewView.ts](src/ui/components/TopicsOverviewView.ts), [styles.css](styles.css))

- **Planned roadmap start on topics: `startDate`.** Topics gain an optional `startDate` frontmatter field for an estimated start you control directly, distinct from the auto-stamped `startedAt`. The roadmap bar runs **`startDate → dueDate`** — `dueDate` doubles as the deadline and the bar's end (no separate `endDate`). The topic editor exposes **Start date** and **Due date** as standalone date-picker rows, and both are on the `topic_create` / `topic_update` MCP tools. Span resolution: start prefers `startDate` (then `startedAt`, then `dueDate`); end prefers `dueDate` (then `startDate`, then `startedAt`), so topics scheduled only via a due date still appear; topics with none of these dates sit in the **No date** tray. ([src/types.ts](src/types.ts), [src/parser/topicParser.ts](src/parser/topicParser.ts), [src/services/sprintTopicService.ts](src/services/sprintTopicService.ts), [src/ui/SprintTopicModal.ts](src/ui/SprintTopicModal.ts), [src/mcp/tools/topics.ts](src/mcp/tools/topics.ts))

- **"Me" option in the topic assignee dropdown** (`SprintTopicModal`). Maps to `settings.jiraEmail` — the same identity the JIRA Dashboard "Mine" lens uses — so self-assignment and JIRA matching stay coherent. Sits at the top of the assignee dropdown with a 👤 glyph; when the user's own email is also configured as a team member, the dropdown collapses the two into a single `👤 Me (nickname)` entry rather than offering two paths to the same value. Surfaces even when no team is configured, so solo users can self-assign for later filtering. ([src/ui/SprintTopicModal.ts](src/ui/SprintTopicModal.ts))

### Changed

- **Topics view restructured around a flat table.** The kanban sub-mode that used to be called "List" is renamed to **Board**, and a new **List** sub-mode (now the default) renders topics as a compact 4-column table: *Topic / JIRA / Assignee / Due*. Status shows as a coloured dot in the title cell (grey = open, blue = in progress, green = done) and done rows strike-through. Blocked topics get a 🛑 marker plus a subtle red tint on the title. JIRA keys render as monospaced badges — when the JIRA module is enabled and the issue is cached, each badge becomes a real link to the live issue. Assignee shows as `👤 Me` when it matches `settings.jiraEmail`, the team member's nickname / full name otherwise, italicised muted text for inactive members. Due dates use tabular numerics and highlight red when overdue (and the topic isn't done). Every row has a hover-only ✎ edit affordance that opens the topic modal without leaving the table.

  Why: the kanban already gave a great status overview but was hostile to "who owns this / what's the JIRA / when is it due" scanning across a backlog of dozens of topics. The new table is the lens for those questions; the board is still one click away.

- **Eisenhower (Urgent / Important) sub-mode removed from the Topics view.** It duplicated semantics already carried by `impact` (drives Impact / Effort) and `dueDate` (drives the table's overdue cue) without giving the user an action surface different from those two — and observation: nobody used it. The `impact`, `dueDate`, and `urgencyThresholdDays` fields are unchanged; only the matrix rendering is gone. Setting descriptions and modal hints that referenced "Eisenhower" are reworded to point at the surfaces that still exist (Impact / Effort matrix, table overdue highlights). Tabs in the Topics view header now read: **List · Board · Impact / Effort**.

### Files

- `src/ui/SprintTopicModal.ts` — "Me" option in the assignee dropdown; dedup against teamMembers when the user's email matches an active member; modal hints reworded.
- `src/ui/components/TopicsOverviewView.ts` — `SubMode` type changed (`list | board | impactEffort`); default sub-mode is `list`; new `renderTable` (~110 lines) for the flat table; old `renderList` renamed to `renderBoard`; `renderEisenhower` / `isUrgent` / `isImportant` deleted.
- `src/settings.ts` — urgency-threshold description reworded.
- `styles.css` — new `.friday-topics-table-*` rule block; deleted `.friday-topicmx-q1..q4` (Eisenhower quadrant accents).

### Changed

- **View tab order reshuffled in the Friday main view.** Topics moves from the middle of the strip up to position 2, immediately after Daily — it's now the second-most-used view (the strategic-prioritization landing pad) and was buried before. New order: Daily → Topics → Weekly → Monthly → Calendar → Unscheduled → Sprint → Inbox → Overdue → Overview → Analytics. The default-view dropdown in settings mirrors the same order so the two stay coherent.
- **"Unscheduled" promoted from inline section to its own top-level tab** (between Calendar and Sprint). It used to be one of six sections inside the Daily view's single-pass bucketing pass, which was fine when the un-dated backlog was small but dominated the page once it grew past ~10 items. Pulling it out as a dedicated tab lets the user scope group-mode (by page / priority / due-date) and search to just the un-dated pile, the same way Overdue already worked.

### Files

- `src/types.ts` — `FridayViewMode.Unscheduled` enum entry.
- `src/ui/components/UnscheduledView.ts` — new component, mirrors `OverdueView` (group mode, search, collapse state); pulls from `TaskStore.getUnscheduledTasks()`.
- `src/ui/FridayView.ts` — `UnscheduledView` import + `case FridayViewMode.Unscheduled` route inserted next to Overdue.
- `src/ui/components/ViewSwitcher.ts` — tab list rewritten; new commentary documents the rationale for the flow.
- `src/ui/components/DailyView.ts` — `unscheduled` bucket + `Unscheduled` section dropped; only the upcoming/overdue/etc. buckets remain. Open root tasks without a due date now silently skip the daily-view classification and surface in the dedicated tab instead.
- `src/settings.ts` — default-view dropdown order matches the new switcher, with `Unscheduled` added as a selectable default.

### Added

- **MCPB bundle (`friday-mcp.mcpb`)** — drag-and-drop installable for Claude Desktop. Bypasses the Windows quoting bug that breaks plain `npx mcp-remote` configs (where `C:\Program Files\nodejs\npx.cmd` gets word-split on the space) by using Claude Desktop's own bundled Node runtime — no shell wrapper, no PATH resolution at the OS level. Port + bearer token are entered in the install dialog and surfaced to the bundle via env vars, so users never edit `claude_desktop_config.json` by hand.

  **What's in the bundle**
  - `manifest.json` (MCPB schema v0.3) — declares server entry point and three `user_config` fields (`host` defaulting to `127.0.0.1`, `port` defaulting to `27225`, `token` flagged `sensitive`). Claude Desktop renders these as a form during install and stores the token in the OS keychain.
  - `server/index.js` — ~140-line stdio↔HTTP bridge using only Node built-ins (`http`, `readline`). Reads newline-delimited JSON-RPC from stdin, forwards via `POST /mcp` with `Authorization: Bearer ${token}` to the plugin's embedded HTTP server, writes the response back as a single stdout line. Notifications (no `id`) get acknowledged with a 202 from the plugin and produce no stdout output, matching MCP wire semantics. `ECONNREFUSED` is translated into a clear JSON-RPC error message ("Could not reach Friday plugin at … Open Obsidian, enable the Friday plugin, then turn on Settings → MCP Server.") so the user sees what's wrong instead of a cryptic transport-disconnect in Claude Desktop's log.

  **Build pipeline**
  - New `mcpb/` source directory with the manifest + bridge.
  - `npm run pack-mcpb` invokes the official `@anthropic-ai/mcpb` CLI (added as devDep) to validate the manifest against the v0.3 schema and write `friday-mcp.mcpb` at the repo root. Manifest validation is enforced at pack time — invalid bundles fail the build instead of silently shipping. Released bundles need to be copied alongside `main.js` into the user's `<vault>/.obsidian/plugins/obsidian-task-bujo/` so the settings tab can point users at it.
  - `pack-mcpb` is intentionally not folded into the standard `build` script — the bundle changes far less often than `main.js`, and most plugin-dev iterations don't need to re-pack it.

  **Settings UI changes** ([src/settings.ts](src/settings.ts))
  - New "Recommended: .mcpb bundle (Claude Desktop)" panel above the existing JSON-snippet block, with a 4-step install checklist and a live reference to the current port value so the user can copy the right numbers into the install dialog.
  - The "Sample Claude connector" section is renamed "Alternative: manual client config" and gains a Windows caveat explaining when the direct-HTTP / mcp-remote forms can fail and why the .mcpb is the safer path. The CLI / `.mcp.json` forms remain perfectly fine for Claude Code regardless.

### Files

- **New:** `mcpb/manifest.json`, `mcpb/server/index.js`, `mcpb-pack.mjs`.
- **Modified:** `package.json` (new `pack-mcpb` script, `@anthropic-ai/mcpb` devDep), `src/settings.ts` (new bundle panel + Windows caveat on the JSON snippets), `CHANGELOG.md` (this entry).

- **Embedded MCP server (`Settings → MCP Server`).** Opt-in HTTP server that exposes Friday's task and topic operations to MCP-aware clients (Claude Desktop, Claude Code, Claude in Chrome). Off by default. Desktop-only — silently no-ops on mobile where Node's `http` module isn't available.

  **Architecture**
  - Hand-rolled JSON-RPC over Node's built-in `http` module. No new runtime dependencies — the MCP wire format (`initialize`, `tools/list`, `tools/call`, `notifications/*`) is implemented directly. Single `POST /mcp` endpoint per request, no SSE / session state.
  - Bound to `127.0.0.1` by default. Configurable port (default `27225` — picked to avoid `27124` used by the popular Local REST API plugin). A `mcpHost` setting also exists in `data.json` for power users who need LAN access, but it's intentionally not surfaced in the UI to keep the section tight.
  - Bearer-token auth on every request. Token is auto-generated on first enable (24 random bytes → URL-safe base64). The settings UI offers Copy and Regenerate buttons — regeneration warns that existing clients need to be updated.
  - Lifecycle: `applyMcpServerState()` starts/stops the server idempotently. Called from `onLayoutReady`, the settings toggle, and the (debounced) port input. `onunload` fires a stop so the socket is released before the next reload.

  **Settings UI**
  - Live status line: `● Running on http://127.0.0.1:27225` / `● Stopped` / `● Error: Port 27225 is already in use.` so the user sees the state without opening the console.
  - **Sample Claude connector** panel — three copy-pasteable snippets that always reflect current host/port/token (host/port change or token regen updates them immediately, so there's no risk of pasting a stale config):
    - Claude Desktop `claude_desktop_config.json` (`mcpServers.friday` with `type: "http"`, `url`, `Authorization: Bearer …`).
    - Claude Code CLI shortcut (`claude mcp add --transport http friday … --header "Authorization: Bearer …"`).
    - Claude Code `.mcp.json` (same shape as Claude Desktop).

  **Tools exposed (initial scope)**
  - *Tasks* — `tasks_list` (filter by today / overdue / unscheduled / week / all, with optional page substring + status), `tasks_search` (substring across text + sourcePath), `tasks_set_status` (open / done / cancelled / migrated / scheduled), `tasks_set_due_date` (natural-language or DD-MM / DD-MM-YYYY — reuses the same `parseDueDate` the UI calls), `tasks_add_to_daily` (creates the daily note if missing, writes under `## Tasks` or `## Inbox`).
  - *Sprints* — `sprints_list`, `sprint_create`, `sprint_complete` (auto-starts next sprint if the setting is on).
  - *Topics* — `topics_list` (scope by sprintId / `"active"` / `"backlog"` / `"all"`), `topic_get`, `topic_create` (full constructor surface incl. JIRA keys, impact, effort, dueDate, assignee, waitingOn, linked pages), `topic_update` (one or more frontmatter fields at a time, pass `null` to clear impact/effort/dueDate/assignee/waitingOn), `topic_assign_to_sprint` (accepts real ID, `"active"`, or `"backlog"`).
  - Each tool is a thin adapter — no business logic in the MCP layer. Every operation routes through the existing service methods (`TaskStore`, `TaskWriter`, `DailyNoteService`, `SprintService`, `SprintTopicService`), so writes go through the same atomic `vault.process` paths as the UI does. Task IDs are the existing `${sourcePath}:${lineNumber}` strings — stable within a session but invalidated by edits above the task line, so tools that take a `taskId` document re-listing when in doubt.

  **Out of scope for this first cut** — daily migration tools, team & 1:1s, JIRA bridge, analytics, standalone (Obsidian-not-running) mode, MCP resources/prompts. The plumbing is set up so adding more tools later is a one-file change in `src/mcp/tools/`.

### Files

- **New:** `src/mcp/server.ts` (HTTP transport, JSON-RPC dispatch, bearer auth, lifecycle, token generator), `src/mcp/tool.ts` (shared tool types + small arg-validation helpers used instead of pulling in zod), `src/mcp/tools/tasks.ts` (5 task tools), `src/mcp/tools/topics.ts` (8 sprint/topic tools).
- **Modified:** `src/types.ts` (added `mcpEnabled`, `mcpHost`, `mcpPort`, `mcpToken` to `PluginSettings` with safe defaults), `src/main.ts` (instantiate `McpServer`, register tools, `applyMcpServerState`, gate on `Platform.isDesktop`, stop on unload), `src/settings.ts` (new MCP Server section with enable toggle, port input, status line, token row with Copy / Regenerate, sample connector snippets for Claude Desktop / Claude Code CLI / `.mcp.json`).

### Changed

- **Topics view → List sub-mode now renders as a 4-column kanban (Backlog \| Open \| In Progress \| Done) instead of stacked rows.** The four sections previously stacked top-to-bottom with their cards laid out in a wrapping `auto-fill` grid; with longer backlogs this pushed Done off-screen and the multi-row card grids made it hard to scan a single status. The same four sections now render side-by-side as columns, with cards stacked vertically inside each — matching the existing Sprint Kanban shape so the two views feel consistent. All existing semantics carry over unchanged: scope chips, assignee filter, sort order (impact → priority → title), and drag-and-drop (status set on drop, auto-assign-to-active-sprint when leaving Backlog, blocked-cleared on Done, `moveToBacklog` on backlog drop). Empty-Backlog suppression under the *Active sprint* scope still applies. As a side fix, the "No topics" empty-state placeholder is now rendered **inside** each column's drop zone (previously it sat outside, so empty columns silently rejected drops).

### Files

- `src/ui/components/TopicsOverviewView.ts` — `renderList` wraps the four sections in a new `.friday-topics-list-board` container; the empty-state `friday-empty` div moved from the section into its `.friday-topics-list-grid` drop zone. No changes to data flow, drop handlers, or card rendering.
- `styles.css` — added `.friday-topics-list-board { display: flex; gap: 12px; align-items: stretch; min-height: 200px; overflow-x: auto; }`; `.friday-topics-list-section` gains `flex: 1; min-width: 220px`; `.friday-topics-list-grid` switches from `grid-template-columns: repeat(auto-fill, minmax(260px, 1fr))` to a vertical `flex` stack with `flex: 1` so the drop zone fills the column.
- `ARCHITECTURE.md` — UI Components table (`TopicsOverviewView.ts` row), View modes table (`Topics` row), and §15 Topics tab sub-modes (List description) updated to reflect the column layout.

---

## 2.1.0 — 2026-04-27

The plugin has been renamed from **BuJo** to **Friday**. The original "Bullet Journal" framing fit when the plugin was a daily/weekly log helper, but the surface has grown well past that — JIRA Dashboard, Team Dashboard with workload heatmap, Topics-as-strategic-units, 1:1 cadence tracking, weekly review, sprint analytics. *Friday* (the personal-AI-assistant archetype, à la Iron Man) better captures what it is now: a personal ops console that scans your vault, surfaces what needs attention each morning, and keeps the team and JIRA picture next to your notes.

### Changed

- **Display name `BuJo` → `Friday`** (`manifest.json` `name`). The plugin `id` is unchanged (`obsidian-task-bujo`) so existing installs keep their `data.json`, settings, sprint history, JIRA cache, weekly snapshots, and team roster — only the *label* shifted.
- **Command palette prefix** is now `Friday: …` (Obsidian derives this from the manifest name; command IDs themselves are unchanged so any user-set hotkeys still bind correctly).
- **All user-visible strings** rebranded: ribbon hover labels (`Open Friday`), status-bar text (`Friday ...`), settings-tab heading (`Friday`), context-menu titles (`Friday: Quick create task`, `Friday: Set due date`, etc.), Notice messages (`Friday: generated N person page(s) …`), and the view tab name (`Friday`).
- **Internal symbols renamed for consistency** (no behavioural change): `BuJoViewMode` → `FridayViewMode`, `TaskBuJoView` → `FridayView` (file `src/ui/TaskBuJoView.ts` → `src/ui/FridayView.ts`), `TaskBuJoSettingTab` → `FridaySettingTab`, `TaskBuJoPlugin` → `FridayPlugin`, `setTaskBuJoIcon` → `setFridayIcon`.
- **CSS namespace `task-bujo-*` → `friday-*`** across `styles.css` and ~38 `.ts` files (~2,700 references). Pure cosmetic / structural — no class structure changes, just the prefix.
- **View-type constants** rebased to `friday-*`: `VIEW_TYPE_TASK_BUJO` (`'task-bujo-view'`) → `VIEW_TYPE_FRIDAY` (`'friday-view'`); `VIEW_TYPE_JIRA_DASHBOARD` value `'task-bujo-jira-dashboard'` → `'friday-jira-dashboard'`; `VIEW_TYPE_TEAM_DASHBOARD` value `'task-bujo-team-dashboard'` → `'friday-team-dashboard'`. **One-time UX hiccup**: Obsidian persists view-type strings in workspace layouts, so any leaves you had pinned with the old types will need to be reopened once after upgrading. Workspace state is otherwise untouched.
- **`package.json` `name`** → `obsidian-friday` (cosmetic; npm-style id, not used by Obsidian).
- **manifest description** rewritten to reflect today's scope (ops console / JIRA / team / sprints) rather than the original Bullet Journal framing.

### Intentionally not changed

- **Default folder paths** — `BuJo/Daily`, `BuJo/Monthly`, `BuJo/Sprints/Topics`, `BuJo/Archive`, `BuJo/Team` remain as the out-of-the-box defaults in `PluginSettings`. These map to existing user data on disk; renaming them would orphan everyone's notes. Each is configurable in settings if a user wants to reorganise.
- **Bullet-Journal methodology references** in `ARCHITECTURE.md` and code comments (e.g. "BuJo-inspired migration") are preserved — that's the conceptual ancestor of the morning-review / forwarding workflow and worth keeping in the historical record.
- **Plugin `id`** (`obsidian-task-bujo`) and **command IDs** (`open-bujo`, `run-daily-migration`, etc.) — kept to preserve user data, hotkeys, and the data.json location.

### Files

- `manifest.json`, `package.json`, `versions.json` — version → `2.1.0`, name → `Friday` / `obsidian-friday`, description rewritten.
- `src/**/*.ts` (~38 files), `styles.css` — mass symbol + CSS-class rename via PowerShell, then targeted Edits for user-facing strings.
- `src/ui/TaskBuJoView.ts` → `src/ui/FridayView.ts` — file renamed; all 15 importers updated by the symbol rename.
- `CHANGELOG.md`, `ARCHITECTURE.md` — this entry plus brand updates in headers and the architecture intro.

---

## 2.0.1 — 2026-04-27

Bug-fix release for the Morning Review / Daily Migration flow. The dialog opened but its **Yesterday's Incomplete** section was always empty, and no daily note was created for today — both observed against a vault whose most recent daily note was older than the literal calendar yesterday (e.g. opening on Monday after a Friday log, or returning from vacation).

### Fixed

- **"Yesterday" now resolves to the most recent prior daily note** instead of literally `today − 1`. `MigrationService.getMorningReviewData()` previously called `dailyNotes.getDailyNotePath(today − 1)` and matched tasks by exact `sourcePath`; if that filename didn't exist on disk (weekend, vacation, or any skipped day), `yesterdayTasks` was always empty. The lookup now scans the configured `dailyNotePath` folder, picks the newest `YYYY-MM-DD.md` strictly before today, and uses that as the source. Lexicographic comparison on the ISO filenames is safe because zero-padded `YYYY-MM-DD` sorts chronologically.
- **Today's daily note is created when the Morning Review modal opens.** Previously the file was only created lazily as a side effect of `addMigratedTask` / `addRawTaskLine`, so a user with nothing to forward would close the dialog and find no daily note for today. `MigrationModal.onOpen` now calls the existing idempotent `dailyNotes.getOrCreateDailyNote(new Date())` up front; the file is written with the standard template (`# Daily Log — …` + Inbox / Tasks / Migrated Tasks headings) and is left untouched if it already exists.

### Changed

- **`MorningReviewData` gains a `yesterdayDate: string \| null` field** carrying the ISO date of the prior daily note that populated `yesterdayTasks` (or `null` when no prior note exists). The modal uses it to label the section as **"Incomplete from Thu, Mar 26"** (via `formatDateDisplay`) instead of the misleading static **"Yesterday's Incomplete"** when the prior note isn't actually yesterday. Falls back to the original wording only when no `yesterdayDate` is available.

### Files

- `src/services/dailyNoteService.ts` — new `getMostRecentPriorDailyNotePath(today: Date): string | null`. Walks `vault.getAbstractFileByPath(settings.dailyNotePath).children`, matches `^(\d{4}-\d{2}-\d{2})\.md$`, returns the lexicographically largest path strictly less than today's ISO. Returns `null` if the folder is missing or empty.
- `src/services/migrationService.ts` — `getMorningReviewData()` swaps the literal-yesterday computation for the new helper, derives `yesterdayDate` by parsing the YYYY-MM-DD out of the resolved path, guards the first-pass loop against a `null` path, and returns `yesterdayDate` on the data object. `MorningReviewData.yesterdayDate` added to the interface.
- `src/ui/MigrationModal.ts` — `onOpen()` calls `getOrCreateDailyNote(new Date())` (with a `Notice` on failure) before rendering. The "Yesterday's Incomplete" section header is now built dynamically from `reviewData.yesterdayDate`.

### Compatibility

- No data-on-disk schema changes. `MorningReviewData` is an in-memory shape produced fresh on every modal open; the new `yesterdayDate` field is additive and the only consumer (`MigrationModal`) handles `null` explicitly.
- `needsMigration()` is unchanged — it already routes through `getMorningReviewData()`, so the prior-note lookup feeds the startup-prompt gate automatically.
- The `migrationPromptOnStartup` toggle, the `BuJo: Run Daily Migration` command, the `executeMigrations` action set (forward / reschedule / done / cancel), and the `addMigratedTask*` writers are all untouched.

---

## 2.0.0 — 2026-04-24

Major release covering seven feature blocks developed since 1.0.0. Breaking schema changes: `SprintTopic.jira` is now `string[]` (was `string | null`); `BuJoViewMode.Eisenhower` and `BuJoViewMode.ImpactEffort` enum values removed; `TaskItem.effort` field removed. In-tree migrations handle the common upgrade paths (see "Topics as first-class prioritized items" below).

### Dashboard tabs (My Work / Team)

The JIRA Dashboard was starting to feel crowded once the team block landed below the five personal sections — long team rosters pushed personal sections off-screen, and the two views compete for attention. Split them into sibling tabs so the user picks which lens they're looking through.

#### Added

- **Tab bar in the dashboard header** (`.task-bujo-jira-dashboard-tabs`) with two tabs: **My Work** and **Team**. The bar sits between the title/refresh row and the search input, with the active tab marked by an accent-colored underline and bold weight.
- **New setting `jiraDashboardActiveTab: 'mine' | 'team'`** (default `'mine'`) — persists the last selected tab across sessions. Written via the existing `saveData` bypass that skips cache invalidation, so tab switching doesn't nuke the just-fetched JIRA issues.
- **Lazy cross-tab refresh**: switching to a tab whose service has stale data kicks a `refresh()` on just that service. Switching to an already-fresh tab is free (no network, no re-parse).

#### Changed

- **`JiraDashboardView.renderContent()` split into `renderMineTab()` + `renderTeamTab()`**. Only the active tab's DOM is built per render, so the off-screen tab carries zero layout cost. The Team tab now owns its own disabled / loading / empty-roster messages, where they previously had to share space with the personal sections.
- **Tab bar visibility tracks `jiraTeamEnabled`** — when team tracking is off, the tab bar hides entirely (`.is-hidden`) and the dashboard looks exactly like it did before Team tracking existed. No vestigial single-tab switcher.
- **`resolveActiveTab()` coerces `'team'` → `'mine'`** when the team toggle is off, so flipping the feature off after a session left the Team tab sticky doesn't land the user on an empty view.

#### Files
- `src/types.ts` — `jiraDashboardActiveTab` setting + default.
- `src/ui/JiraDashboardView.ts` — `tabBarEl` field, `renderTabs()`, `resolveActiveTab()`, `switchTab()`, split render.
- `styles.css` — `.task-bujo-jira-dashboard-tabs` + `.task-bujo-jira-dashboard-tab` + `.is-active` / `.is-hidden` modifiers.

---

### Team tracking (lead-analyst mode)

A new lightweight team-tracking layer on top of the JIRA Dashboard, aimed at a lead analyst / team lead who needs a quick "who's drowning" glance plus per-person drill-down. Configure team members once in settings, flip the toggle, and the dashboard grows a workload heatmap and per-person sections driven by a single team-scoped JQL round-trip.

#### Added

##### `TeamMember` model + settings (`Settings → JIRA Integration → Team Members`)
- New `TeamMember` interface: `{ fullName, nickname, email, active }`. Stored on `PluginSettings.teamMembers: TeamMember[]`.
- Email is the JIRA identity — used directly in `assignee in ("email1", "email2", …)` JQL clauses (Atlassian resolves to `accountId` server-side). Nickname is the short label rendered on heatmap bars and row headers.
- `active: boolean` is a tombstone flag — flipping a member to inactive hides them from the dashboard without losing their entry, preserving historical matches if the plugin ever joins back on email.
- **Team Members settings UI**: list of rows with inline edits for full name, nickname, and email, plus an Active checkbox and Remove button. A permissive email validator warns on missing `@` but still saves (typos shouldn't nuke a row).
- Master toggle `jiraTeamEnabled` — off by default. Even with members configured, the team block stays hidden until this is on. Lets users park a team list without activating the feature.

##### `JiraTeamService` (`src/services/jiraTeamService.ts`)
- Sibling of `JiraDashboardService`, with the same state machine (`empty` / `loading` / `fresh` / `error`), in-flight dedup, event bus, monotonic version counter, and safe JSON parsing. Kept separate rather than folded into the dashboard service because the two have different scopes and different failure modes — isolating team state means a team-fetch error never masks the user's personal issues.
- One JQL per refresh:
  ```
  assignee in ("email1", "email2", …)
  [AND project in (jiraDashboardProjects)]
  AND (resolution = Unresolved OR resolutiondate >= -7d)
  ORDER BY updated DESC
  ```
- Reuses `jiraDashboardProjects` and `jiraDashboardTtlMinutes` — the team block shares the same project scope and the same visibility-aware auto-refresh cadence as the personal sections.
- Same explicit field list as the personal service plus `customfield_10021` for Flagged detection. No `*all` token.
- `isEnabled()` returns false (→ no-op) unless: master JIRA toggle on, team toggle on, credentials present, AND at least one active member with a valid-looking email.

##### Workload heatmap on `JiraDashboardView`
- Rendered directly below the five personal sections as part of a dedicated **Team** block.
- One row per active team member, sorted heaviest-first. Layout: `nickname · segmented-bar · counts`.
- Segmented bar is proportional across the team: the busiest member's bar fills the track, others are scaled by `total / maxTotal`. Segments colored by status category — **blocked (red)** · **in-progress (blue)** · **open (grey, faded)** · **done (green, faded)** — so a glance at widths tells you who's flagged and who's idle.
- Hovering any segment shows `{count} {category}` as a tooltip; the compact count summary to the right (`3 blocked · 5 in progress · 2 open`) gives the same info readably.

##### Per-person sections
- One collapsible section per team member, sorted by total workload desc (overloaded people surface first). Reuses the existing row renderer (`renderIssueRow`) so clicking the issue key opens JIRA in the browser, and the right-click "Create topic / Link to topic" actions work on team-member rows too.
- Sticky collapsed state keyed by `team:<email>` in `jiraDashboardCollapsedSections` — collides-by-design with nothing, and survives settings saves thanks to the existing `saveData` bypass for UI state.
- Defaults to collapsed so the heatmap is the primary surface; expand a row only when drilling in.

##### Bucketing strategy
- Each team-scoped issue lands in exactly one member's bucket. Matching priority:
  1. Exact case-insensitive email match against `issue.assigneeEmail` (JIRA Cloud often hides this for privacy, but when present it's unambiguous).
  2. Display-name fallback — case-insensitive `fullName` match against `issue.assignee` (the displayed name).
- Issues matching no member are dropped rather than bucketed into a catch-all (the JQL already scoped to team emails, so this should be rare).

#### Changed
- `JiraDashboardIssue` gains two fields: `assigneeEmail: string | null` and `assigneeAccountId: string | null`. Both personal and team parsers populate them from `fields.assignee.emailAddress` / `accountId`. Existing call sites continue to use `issue.assignee` (displayName) — the new fields are opt-in.
- `JiraDashboardView` constructor gains a `JiraTeamService` dependency. `main.ts` instantiates and passes it at `registerView()` time.
- The `Refresh JIRA Dashboard` command now triggers both services in parallel — the team service no-ops when disabled.
- `main.ts`'s `saveSettings()` clears the team service cache alongside the existing two, so changes to team roster / toggle / projects take effect on the next refresh.

#### Files

**New**
- `src/services/jiraTeamService.ts` — team-scoped fetch service.

**Modified** (highlights)
- `src/types.ts` — `TeamMember` interface, two new settings fields, two new fields on `JiraDashboardIssue`.
- `src/services/jiraDashboardService.ts` — populate `assigneeEmail` / `assigneeAccountId` on the personal parser.
- `src/settings.ts` — Team Members settings sub-section + inline-edit list.
- `src/main.ts` — instantiate + cache-clear + pass to view + refresh-both in the command.
- `src/ui/JiraDashboardView.ts` — team listener subscription, `renderTeamBlock`, `renderHeatmap`, `renderMemberSection`, `bucketByMember`.
- `styles.css` — `.task-bujo-jira-dashboard-team-*`, `.task-bujo-jira-dashboard-heatmap-*`, `.task-bujo-team-member-*` namespaces.

---

### JIRA → Topic actions on the dashboard

The JIRA Dashboard is no longer strictly read-only: it remains read-only against JIRA, but now doubles as a launch point for topic creation and linking. Right-click any dashboard row and the two most common "I saw this ticket in the dashboard and want to work on it" flows are one click away. Nothing on the JIRA side is ever mutated.

#### Added

##### Right-click context menu on `JiraDashboardView` rows
- **Create topic from this issue** — opens `SprintTopicModal` in create mode, pre-seeded from the JIRA issue:
  - Title ← `issue.summary` (fallback: issue key if summary is blank).
  - JIRA field ← `issue.key`.
  - Priority ← mapped from JIRA's 5-level scale to the plugin's 3-level scale via `mapJiraPriority()`: Highest / High → `high`, Medium → `medium`, Low / Lowest → `low`, anything else → `none`.
  - Default sprint ← currently active sprint (from `SprintService.getActiveSprint()`), or Backlog if no sprint is active.
  - All other fields (impact / effort / due date / linked pages / sprint) remain user-editable in the modal before Save. JIRA is source-of-truth for title/priority **on first create only** — the plugin never overwrites topic frontmatter from subsequent JIRA changes.
- **Link to existing topic…** — opens a `FuzzySuggestModal` (`TopicSuggestModal`) over every topic in the vault *except* those already carrying this key. Selecting one appends the issue key to the topic's existing `jira[]` array (dedup preserving insertion order) via `updateTopicFrontmatter`. Many-to-many is preserved: one topic accumulates multiple keys, one issue back-links from multiple topics. The menu item auto-disables when every topic already has this key.
- **Open topic: …** — one entry per already-linked topic, for quick navigation to the topic file (only appears when the row has at least one linked topic).

##### Live re-render on topic changes
- `JiraDashboardView` now subscribes to `VaultScanner.onTopicsChange`. When a new topic lands on disk (Create flow) or an existing topic's `jira:` frontmatter is updated (Link flow), the row's `↔ Topic` chip appears immediately — no manual refresh needed. The scanner has no explicit unsubscribe API, so the callback no-ops after `onClose()` nulls `contentContainer`.

##### `SprintTopicModal` pre-fill hook
- New optional 7th constructor parameter `prefill?: { title?: string; jira?: string; priority?: Priority }`. Consulted only in create mode (ignored when `editTopic` is passed). This is the generic seed path — any future "create a topic from X" flow can reuse it without knowing about the modal's internals.

#### Changed
- `JiraDashboardView` constructor now takes three additional dependencies: `SprintTopicService`, `SprintService`, and `onTopicsChanged: (cb: () => void) => void` (thin wrapper over `scanner.onTopicsChange`). `main.ts` passes them at `registerView()` time.
- Write paths go through the existing `createTopic` / `updateTopicFrontmatter` calls, so both actions participate in the normal file-watch → scanner → re-render cycle without any special casing.

#### Files
- **Modified**: `src/ui/SprintTopicModal.ts` (prefill param), `src/ui/JiraDashboardView.ts` (context menu + action handlers + `mapJiraPriority` + `TopicSuggestModal`), `src/main.ts` (extra deps at registration).

---

### JIRA Dashboard fetch-path hardening

Three production-environment issues surfaced once the dashboard hit a corporate JIRA Cloud tenant. All three are fixed in `JiraDashboardService`; the user-visible behavior is unchanged but the failure modes are gone.

#### Changed
- **Endpoint migrated to `GET /rest/api/3/search/jql`** (from the deprecated `POST /rest/api/3/search`). Atlassian removed the old endpoint (changelog CHANGE-2046) — it now returns HTTP 410 Gone. The new endpoint accepts both GET and POST; we use GET because some tenants enforce XSRF on POSTs even with `X-Atlassian-Token: no-check`, and a 100-row dashboard URL is ~1KB — well under any gateway limit. GET is semantically correct for a read-only query and is documented as a first-class option, not a workaround.
- **Explicit field list** instead of `*all`. The new `/search/jql` endpoint rejects the `*all` magic token, so `JiraDashboardService.doFetch()` now names every field it needs — including `customfield_10021` for Flagged detection. The configurable sprint field (`jiraSprintFieldId`, default `customfield_10020`) is appended to the list at request time.
- **Defensive JSON parsing** via a new `safeParseJson(text)` helper. `resp.json` is a getter that throws a `SyntaxError` when the body isn't JSON (e.g. plain-text `"XSRF check failed"` on a 403). The helper parses once, returns `null` on failure, and is consulted in both the success and error paths so a non-JSON error body surfaces as the real HTTP status rather than masking the underlying error with a parse exception.
- **Dashboard UI-state saves bypass `saveSettings`'s side effects.** Section expand/collapse previously called `saveSettings()`, which clears the JIRA dashboard cache; the cache-clear fired listeners, the re-render saw an empty cache, and the dashboard momentarily showed "No data yet" on every section toggle. The view's save callback is now wired to `saveData(this.data)` directly, so sticky UI-state writes don't invalidate fetched data.

---

### JIRA Dashboard view

A dedicated, read-only personal JIRA Dashboard view — a separate workspace leaf that surfaces the user's active JIRA work without leaving Obsidian. One JQL round-trip per refresh, result sliced client-side into sections. Never writes to disk or mutates JIRA.

#### Added

##### Dashboard view (`VIEW_TYPE_JIRA_DASHBOARD`)
- New workspace leaf registered as a separate tab (not a BuJo sub-mode). Opens via the new **layout-dashboard** ribbon icon or the commands `Open JIRA Dashboard` / `Refresh JIRA Dashboard`.
- **Five sections** — issues are assigned to exactly one bucket, in this order: Blocked/Flagged · In Progress · In Current Sprint · Reported by Me · Recently Done. The leftover bucket ("Reported by Me") hides itself when empty.
- **Sticky collapsed state** per section, persisted in `PluginSettings.jiraDashboardCollapsedSections`. Recently Done and Reported by Me collapse by default on first open.
- **Compact row** per issue with: issue-type icon, key (clickable → browser), summary, parent epic, status chip, priority, flagged badge, assignee, due date (with overdue highlight), sprint name, time spent / remaining estimate, labels (first 5 + more indicator).
- **Topic-link chips** — if a topic file's `jira:` frontmatter lists this issue key, the row shows a `↔ Topic Title` chip that opens the topic file in the current leaf. Many-to-many is honored: one issue key can show multiple topic chips, one topic can chip-link to multiple issues.
- **Live text filter** across key, summary, status, assignee, reporter, parent, sprint, priority, issue type, and labels. Debounced 200ms.
- **Refresh UX** — header shows `Refreshed Xm ago` (or `· stale` when past TTL) plus a manual `Refresh` button. Visibility-aware auto-refresh fires on `onResize` when the cache has aged past the TTL, so opening the tab after a while surfaces fresh data without polling in the background.

##### `JiraDashboardService` (`src/services/jiraDashboardService.ts`)
- Owns a single cached result set (not a per-key map like `JiraService`) — the union of issues matching `assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()` across configured projects, filtered to `resolution = Unresolved OR resolutiondate >= -7d`.
- `refresh()` fires one `POST /rest/api/3/search` with 100 `maxResults` and parses into `JiraDashboardIssue[]`. In-flight dedup so two concurrent calls share one request.
- Tolerant parser for the sprint custom field (array of objects or legacy strings), flagged detection via `customfield_10021`, and safe fallback for all optional fields.
- Event subscription (`on` / `off`) + monotonic `version` counter so views re-render as fresh data arrives.
- Cache cleared on every settings save (URL / token / projects may have changed).

##### Dashboard-specific settings (`Settings → JIRA Integration → JIRA Dashboard`)
- **Dashboard projects** — comma-separated JIRA project keys scoping the JQL search. Empty = all projects you can see.
- **Dashboard cache TTL (minutes)** — separate from the per-issue TTL. Auto-refresh triggers when the view is visible and the cache has aged past this.
- **Sprint custom field ID** — defaults to `customfield_10020` (Cloud standard), overridable per instance.

#### Changed
- `SprintTopic.jira` is now `string[]` (was `string | null`). Topic frontmatter still accepts a single key (`jira: PROJ-1`) or comma-separated keys (`jira: PROJ-1, PROJ-2`); the parser deduplicates and preserves insertion order. One topic can link to many JIRA issues, and one issue can back-link to many topics on the dashboard.
- `TopicCard` renders one JIRA row per key in `topic.jira[]` rather than a single key. Each row carries its own cached status/assignee/loading/error state.
- `SprintTopicModal` label changed to "JIRA Ticket(s)" with a comma-separated input; parses the raw string back to `string[]` on save using the same regex as the dashboard.
- `saveSettings` in `main.ts` now also calls `jiraDashboardService.clearCache()` on every save.

#### Types
- New `JiraDashboardIssue` interface with the fields needed for dashboard row rendering (never written to disk).
- Four new settings fields: `jiraDashboardProjects`, `jiraDashboardTtlMinutes`, `jiraSprintFieldId`, `jiraDashboardCollapsedSections`.

#### Files

**New**
- `src/services/jiraDashboardService.ts`
- `src/ui/JiraDashboardView.ts`

**Modified** (highlights)
- `src/constants.ts` — `VIEW_TYPE_JIRA_DASHBOARD`.
- `src/types.ts` — `JiraDashboardIssue`, dashboard settings, `SprintTopic.jira: string[]`.
- `src/main.ts` — instantiate dashboard service, register view, ribbon icon, open/refresh commands, cache-clear on save.
- `src/settings.ts` — JIRA Dashboard sub-section (projects / TTL / sprint field).
- `src/parser/topicParser.ts` — multi-key jira parsing.
- `src/ui/SprintTopicModal.ts`, `src/ui/SprintCloseModal.ts` — multi-key join/format.
- `src/ui/components/TopicCard.ts` — per-key JIRA rows via `jiraLookup`.
- `src/ui/components/SprintView.ts`, `src/ui/components/TopicsOverviewView.ts` — search predicates + prefetch over all keys.
- `styles.css` — `.task-bujo-jira-dashboard-*` namespace.

---

### JIRA integration module

A new optional module that enriches topics with live data from a configured JIRA Cloud instance.

#### Added

##### JIRA Integration module (toggleable)
- **New settings section** (`Settings → JIRA Integration`) with a master `Enable JIRA integration` toggle. When off, no fetches happen and no JIRA UI appears on cards — the module is fully dormant.
- **Credentials**: base URL, account email, personal API token (password-masked input), and cache TTL in minutes. All stored in the plugin's `data.json`.
- **Test connection** button performs a single authenticated `GET /rest/api/3/myself` call and surfaces the result via a `Notice` (shows the display name on success, the HTTP error or exception message on failure).
- **Topic enrichment** — topics with `jira: PROJ-123` in frontmatter now show:
  - The issue key (clickable — opens the issue in the default browser when cached).
  - A color-coded status chip (grey = New, blue = In Progress, green = Done), matching Atlassian's status-category semantics.
  - An assignee chip (display name, or "Unassigned" if null).
  - The issue summary as a one-line subtitle on the card.
  - A transient loading indicator while a fetch is in flight and an error chip if the last fetch failed (hover the chip to see the error message).
- **`JiraService`** (`src/services/jiraService.ts`) — the module's single entry point:
  - Reads settings on every call (via a `getSettings` function), so toggling the module off takes effect immediately.
  - In-memory cache only — fetched issue data is **never written to disk** and is cleared automatically on any settings save (guards against stale data after URL/token changes).
  - In-flight fetch deduplication: asking for the same key twice concurrently returns the same promise.
  - `prefetchMany(keys)` lets views batch-request every visible topic's issue in parallel; errors are silenced so one bad key doesn't poison the view.
  - Emits events on every cache mutation; views re-render as fresh data arrives without blocking the initial paint.
- **SprintView and TopicsOverviewView** both prefetch on render and pass cache snapshots through to `TopicCard`. The view fingerprint in `TaskBuJoView.refresh()` now folds `jiraService.version` so JIRA-only updates actually trigger a rebuild.

#### Changed
- `TopicCard` renders the JIRA key in a new `task-bujo-kanban-card-jira-row` flex container alongside the status and assignee chips, then shows the issue summary below. When the module is disabled or the topic has no `jira` field, rendering is unchanged.
- `saveSettings` in `main.ts` now calls `jiraService.clearCache()` on every save — cheap, and makes URL/token changes take effect on the next render.

#### Security notes
- The API token lives in plain text in `data.json`, same as the rest of your vault's configuration. The password-masked input prevents over-the-shoulder leaks but offers no at-rest protection — treat the file accordingly.
- All requests go through Obsidian's `requestUrl()`, which bypasses renderer-process CORS. `throw: false` is used so non-2xx responses surface as structured errors rather than uncaught promise rejections.

#### Backwards compatibility
- Entirely opt-in. Existing topics with no `jira` field are unaffected. Existing topics with a `jira` field show the key exactly as before until the module is enabled and credentials are configured.
- No schema change to existing data — the JIRA settings fields are added via the existing `Object.assign` deep-merge in `onload()`, defaulting to `jiraEnabled: false` for every upgrading user.

#### Files
- **New**: `src/services/jiraService.ts`
- **Changed**: `src/types.ts` (JIRA settings fields, `JiraIssueInfo` interface), `src/main.ts` (instantiation + cache-clear on save), `src/ui/TaskBuJoView.ts` (subscribe/unsubscribe + fingerprint + threading), `src/settings.ts` (JIRA section + test button), `src/ui/components/TopicCard.ts` (status/assignee chips), `src/ui/components/SprintView.ts` (prefetch + pass-through), `src/ui/components/TopicsOverviewView.ts` (prefetch + pass-through), `styles.css` (`.task-bujo-jira-*` chips)

---

### Topics as first-class prioritized items

A full reorganization around **Topics** as the unit of strategic prioritization, with the two matrices (Impact/Effort, Eisenhower) moved from tasks to topics and a dedicated Topics tab surfacing the entire topic backlog across sprints.

#### Added

##### Topics tab (`BuJoViewMode.Topics`)
- New top-level view, `src/ui/components/TopicsOverviewView.ts`, showing **all** topics in the vault — not just the active sprint's.
- **Three sub-modes** switchable from the view header:
  - **List** — grouped by Backlog (no sprint) / Open / In Progress / Done, with per-group counts.
  - **Impact / Effort** — 2×2 grid of Quick Wins / Big Bets / Fill-ins / Time Sinks, plus an Inbox for topics missing either field.
  - **Eisenhower** — 2×2 grid of Do Now / Plan Deep Work / Coordinate / Batch Later. Urgent = `dueDate` within `urgencyThresholdDays`; important = `impact ∈ {critical, high}` (falls back to `priority` when impact is unset). Topics without a due date land in a separate Unscheduled bucket.
- **Scope filter chips** (All / Active sprint / Backlog / Archived) scope the whole sub-mode at once.
- **Drag-and-drop** between sections in List mode:
  - Drop onto Backlog → clears the topic's sprint assignment (status preserved).
  - Drop onto a status section → sets status. If dragged from Backlog, the topic is auto-assigned to the active sprint. If no active sprint exists, a Notice is shown and nothing changes.
  - Dropping a blocked topic onto Done auto-clears the blocked flag (mirrors Sprint Kanban).
- **+ Topic** button opens the topic modal in backlog mode (no pre-assigned sprint).

##### New topic frontmatter fields (all optional)
- `impact: critical | high | medium | low` — strategic weight, drives matrix placement.
- `effort: xs | s | m | l | xl` — size estimate for Impact/Effort.
- `dueDate: YYYY-MM-DD` — Eisenhower urgency signal.
- `sprintHistory: <sprint-id>,<sprint-id>,…` — cumulative list of every sprint the topic has been assigned to, in insertion order. Append-only; never pruned by backlog moves or archives.

##### Sprint picker in `SprintTopicModal`
- New **Sprint** dropdown listing `(Backlog)` plus every sprint (with `· active` / `· completed` suffix). Lets users start a topic in Backlog or reassign between sprints without leaving the modal.
- New **Sprint history** read-only section (edit mode only) showing every past sprint as a chip (`Sprint 12 (2026-04-01 → 2026-04-14)`). The current sprint's chip is accent-highlighted. Deleted sprints show their ID plus `· deleted`.
- Added Impact / Effort / Due date inputs (dropdown / dropdown / date picker) to the same modal, wired through to create + update paths.

##### Shared topic card component
- New `src/ui/components/TopicCard.ts` — single renderer used by both `SprintView` (Kanban) and `TopicsOverviewView` (all three sub-modes). Takes an options object for draggability, click handlers, and an optional matrix-metadata chip row (`Impact: … · Effort: … · Due: …`).

##### Service API additions (`SprintTopicService`)
- `setTopicImpact(filePath, impact | null)`
- `setTopicEffort(filePath, effort | null)`
- `setTopicDueDate(filePath, dueDate | null)`
- `assignTopicToSprint(filePath, sprintId)` — central sprint-change helper. Reads current `sprint` and `sprintHistory` from frontmatter, merges old + new sprint into history, writes atomically. Passing `''` moves the topic to backlog.
- `moveTopicToBacklog(filePath)` — thin wrapper over `assignTopicToSprint(filePath, '')`.
- `carryForwardTopic`, `archiveTopic`, `cancelTopic` — now all route through `assignTopicToSprint` so the departing sprint is captured into history before being cleared.

##### Settings migration
- `main.ts` rewrites any saved `defaultViewMode` of `'eisenhower'` or `'impactEffort'` to `BuJoViewMode.Topics` on load. Users who had those modes pinned will land on Topics instead of crashing on a missing switch case.

#### Changed

- **`serializeFrontmatter`** now *omits* keys whose value is `null`/`undefined` rather than emitting empty `key: ` lines. Keeps topic YAML tidy. Reading old files with blank values still works (parsed as `null`).
- **`updateTopicFrontmatter`** now *deletes* a key when passed `null`, rather than setting it to the empty string. All in-tree callers use this semantics.
- **`SprintView.renderTopicCard`** removed — the Kanban now delegates to the shared `TopicCard` renderer. No visual change.
- `ViewSwitcher` tab order: Daily / Weekly / Monthly / Calendar / Sprint / **Topics** / Overdue / Overview / Analytics.

#### Removed

- **`src/ui/components/EisenhowerView.ts`** — task-level Eisenhower matrix deleted. The same concept lives on under Topics.
- **`src/ui/components/ImpactEffortView.ts`** — task-level Impact/Effort matrix deleted. Same.
- **`BuJoViewMode.Eisenhower`** and **`BuJoViewMode.ImpactEffort`** enum values.
- **`TaskItem.effort`** field and the `EFFORT_REGEX` constant. Task-level `#effort/…` tags in existing files remain as literal text (they were never rendered anyway).
- `#effort/S|M|L` row from the Syntax Reference modal.
- `effort` field from `InsertTaskModal`.

#### Kept (reused for topics)

- `PluginSettings.urgencyThresholdDays` — drives the new Topic-level Eisenhower urgency calculation.

#### Backwards compatibility

- **Topic files on disk** are not touched on load. Rewrites happen only on explicit user actions (save, drag/drop, sprint close).
- **Missing frontmatter keys** (`impact`, `effort`, `dueDate`, `sprintHistory`) parse to `null` / `[]` — legacy topics load cleanly.
- **Legacy topics with a current `sprint` but no `sprintHistory`** get an in-memory backfill of `[sprintId]` so the current sprint shows in the modal chip list immediately. Nothing is persisted until the user actually reassigns the topic — at which point `assignTopicToSprint` defensively captures the departing sprint into history before writing the new one. Historical sprints before tracking began are not reconstructed (expected).
- **Saved `defaultViewMode` of the removed modes** is rewritten to `Topics` on load.
- **Task-level `#effort/…` tags** in user files become plain text; they were previously only consumed by the removed Impact/Effort task view.

#### Files

**New**
- `src/ui/components/TopicsOverviewView.ts`
- `src/ui/components/TopicCard.ts`

**Deleted**
- `src/ui/components/EisenhowerView.ts`
- `src/ui/components/ImpactEffortView.ts`

**Modified** (highlights)
- `src/types.ts` — added `TopicImpact`, `TopicEffort`, `BuJoViewMode.Topics`, extended `SprintTopic`, removed task-level effort enums.
- `src/main.ts` — `defaultViewMode` migration.
- `src/parser/topicParser.ts` — parse impact / effort / dueDate / sprintHistory, null-omit serializer.
- `src/services/sprintTopicService.ts` — extended `createTopic`, new setters, central `assignTopicToSprint` with history merge.
- `src/ui/SprintTopicModal.ts` — sprint picker, history chips, impact / effort / due-date inputs.
- `src/ui/components/SprintView.ts` — delegates to `TopicCard`.
- `src/ui/components/ViewSwitcher.ts` — Topics tab added, Eisenhower / ImpactEffort tabs removed.
- `src/ui/TaskBuJoView.ts` — routes `BuJoViewMode.Topics`, exposes backlog-topic + edit-topic modal helpers, passes shared `isDragging` flag through to the Topics view.
- `styles.css` — `task-bujo-topicmx-*` and `task-bujo-topics-*` namespaces (ported from the old `task-bujo-eisenhower-*` / `task-bujo-ie-*` rules), plus drop-zone highlight and sprint-history chip styles.
