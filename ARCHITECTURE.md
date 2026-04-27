# Friday — Obsidian Plugin

## Developer Documentation

> **Plugin ID**: `obsidian-task-bujo` *(unchanged from BuJo era — preserves user data)* · **Name**: Friday · **Version**: 2.1.0  
> **Min Obsidian**: 1.0.0 · **License**: MIT · **Desktop Only**: No  
> **Entry Point**: `main.js` (built from `src/main.ts`)  
> **Dependencies**: `obsidian`, `typescript ^5.3`, `esbuild ^0.19`, `@types/node ^20.11`

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [File-by-File Reference](#2-file-by-file-reference)
3. [Data Flow](#3-data-flow)
4. [Plugin Settings](#4-plugin-settings)
5. [Commands & Interactions](#5-commands--interactions)
6. [View Modes](#6-view-modes)
7. [Friday Markdown Syntax](#7-friday-markdown-syntax)
8. [Migration & Forwarding Flow](#8-migration--forwarding-flow)
9. [Analytics](#9-analytics)
10. [Task Archiving](#10-task-archiving)
11. [Two-Way Sync](#11-two-way-sync)
12. [Performance Optimizations](#12-performance-optimizations)
13. [Constants Reference](#13-constants-reference)
14. [Build & Release](#14-build--release)
15. [Topics & Sprint Prioritization](#15-topics--sprint-prioritization)
16. [JIRA Integration (Optional Module)](#16-jira-integration-optional-module)
17. [JIRA Dashboard (read-only personal dashboard)](#17-jira-dashboard-read-only-personal-dashboard)

---

## 1. Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│                      main.ts (Plugin)                        │
│   Orchestrates lifecycle, commands, context menus, events    │
├─────────────┬──────────────┬─────────────┬──────────────────┤
│   Parser    │   Services   │     UI      │     Utils        │
├─────────────┼──────────────┼─────────────┼──────────────────┤
│ taskParser  │ vaultScanner │ FridayView    │ dateUtils        │
│ headingCls  │ taskStore    │ Modals (5)  │ pathUtils        │
│ dateParser  │ taskWriter   │ Views  (10) │                  │
│             │ migration    │ Components  │                  │
│             │ dailyNote    │   (17 files)│                  │
│             │ sprint       │             │                  │
│             │ analytics    │             │                  │
│             │ archive      │             │                  │
└─────────────┴──────────────┴─────────────┴──────────────────┘
```

**Total**: ~38 source files, ~5,100 lines of TypeScript + ~1,400 lines of CSS.

### Layer Responsibilities

| Layer | Purpose |
|-------|---------|
| **Parser** | Converts markdown content → `TaskItem[]` structured data |
| **Services** | Business logic, file I/O, in-memory state, event system |
| **UI** | Obsidian `ItemView`, modals, reusable components |
| **Utils** | Date math, path resolution helpers |

---

## 2. File-by-File Reference

### Core Files

#### `src/main.ts` (~312 lines) — Plugin Entry Point
- **Class**: `FridayPlugin extends Plugin`
- **Responsibilities**: Bootstraps all services, registers commands/views/events, manages lifecycle
- **Key fields**: `data: PluginData`, `settings: PluginSettings`, 7 private service instances
- **Lifecycle**:
  - `onload()`: loads persisted data (deep-merges settings), instantiates all services, wires scanner→store pipeline, registers view/commands/ribbon/context menus, triggers `fullScan()` on layout ready, then checks migration & weekly review
  - `onunload()`: detaches views, destroys scanner

#### `src/types.ts` (~210 lines) — Type Definitions & Defaults
- **Enums**: `TaskStatus`, `ItemCategory`, `Priority`, `GroupMode`, `FridayViewMode` (includes `Calendar`, `Topics`). The old task-level `Eisenhower` / `ImpactEffort` modes were removed — those matrices now apply to Topics.
- **Interfaces**: `TaskItem` (includes `description`), `Sprint`, `SprintTopic` (includes `impact`, `effort`, `dueDate`, `sprintHistory[]`), `TagCategory`, `PluginSettings` (includes archive settings, `urgencyThresholdDays` — now used by the Topic Eisenhower sub-mode), `WeeklySnapshot`, `PluginData`
- **Type aliases**: `TopicImpact = 'critical' | 'high' | 'medium' | 'low'`, `TopicEffort = 'xs' | 's' | 'm' | 'l' | 'xl'`
- **Type aliases**: `FolderState`, `StoreEventType`, `StoreEventCallback`
- **Constants**: `DEFAULT_WORK_TYPES`, `DEFAULT_PURPOSES`, `DEFAULT_SETTINGS`, `DEFAULT_PLUGIN_DATA`

#### `src/constants.ts` (~43 lines) — Regex & Tuning Constants
All regex patterns for parsing and timing constants for debouncing. See [§13](#13-constants-reference).

#### `src/settings.ts` (~439 lines) — Settings Tab UI
- **Class**: `FridaySettingTab extends PluginSettingTab`
- Interactive settings page with folder tree (recursive, collapsible, tri-state include/exclude/inherit cycle), dropdowns, toggles, and text inputs with debounced saves

### Parser Layer (`src/parser/`)

#### `taskParser.ts` (~190 lines) — Markdown → TaskItem[]
- **Function**: `parseTasksFromContent(content, sourcePath, classifier, workTypes?, purposes?)`
- Iterates lines tracking heading context (category, sub-headings). For each checkbox line extracts: status, priority, type tag, due date, migration annotation, work type, purpose, effort
- **Description collection**: non-checkbox, non-heading lines indented deeper than the preceding task are collected into `TaskItem.description` (multi-line, joined with `\n`)
- **Helper**: `resolveTagCategory(value, categories)` — matches by name or shortCode (case-insensitive)

#### `headingClassifier.ts` (~34 lines) — Heading → Category Mapping
- **Class**: `HeadingClassifier`
- `classify(headingText, inlineTypeTag)` → `ItemCategory`
- Priority: inline `#type/` tag > heading substring match > Uncategorized

#### `dateParser.ts` (~140 lines) — Due Date String Parsing
- **Function**: `parseDueDate(raw: string): Date | null`
- **Natural language dates** (tried first via `parseNaturalDate()`):
  - Keywords: `today`, `tomorrow`, `yesterday`
  - Weekdays: `monday`..`sunday`, `next monday`..`next sunday`
  - Relative: `in N days`, `in N weeks`, `in N months`
  - Periods: `next week` (→ Monday), `next month` (→ 1st), `end of week`/`eow` (→ Friday), `end of month`/`eom`
- **Numeric formats** (fallback): `DD-MM-YYYY` (absolute) or `DD-MM` (nearest future occurrence)
- Validates date overflow (e.g., Feb 30 → null)

### Service Layer (`src/services/`)

#### `vaultScanner.ts` (~218 lines) — File System Watcher & Parser Orchestrator
- **Class**: `VaultScanner`
- **State**: `tasksByFile: Map<string, TaskItem[]>`, `cachedAllTasks`, `debounceTimers: Map`, `cachedClassifier`
- **Key methods**:
  - `fullScan()`: reads all included `.md` files in parallel batches of `SCAN_BATCH_SIZE` (50) via `vault.cachedRead()`
  - `registerEvents()`: hooks `modify`, `delete`, `rename`, `create` vault events
  - `debounceScanFile(file)`: per-file debounce at `SCAN_DEBOUNCE_MS` (300ms)
  - `scanFile(file)`: incremental re-parse via `vault.read()` (not cached); skips if `writer.isSyncing`
  - `detectAndSyncStatusChanges()`: compares old vs new tasks; triggers two-way sync when migrated tasks change status

#### `taskStore.ts` (~239 lines) — In-Memory Task Repository & Query Engine
- **Class**: `TaskStore`
- **State**: `tasks[]`, `_version` (monotonic counter), category indices (`taskItems`, `openPointItems`, `uncategorizedItems`)
- **Event system**: `on(event, callback)` / `off()` / `emit()` — events: `'tasks-updated'`
- **Query methods**: `getTasks()`, `getOpenPoints()`, `getUncategorized()`, `getTasksForDate()`, `getTasksForDateRange()`, `getTasksForSprint()`, `getOverdueTasks()`, `getUnscheduledTasks()`, `getPendingCount()`
- **Filtering**: `filterCompleted(tasks, showCompleted)` — migrated tasks always hidden; optionally hides done/scheduled/cancelled
- **Grouping**: `groupTasks(tasks, mode, weekStartDay?)` → `Map<string, TaskItem[]>` — modes: ByPage, ByPriority, ByDueDate (buckets: Overdue/Today/This Week/Later/No Date)

#### `taskWriter.ts` (~128 lines) — Markdown Write-Back Engine
- **Class**: `TaskWriter`
- **State**: `syncing: boolean` (guards against re-scan loops)
- **Methods**:
  - `setStatus(task, newStatus)`: replaces checkbox character in source file
  - `updateDueDate(task, newDateRaw)`: replaces or appends `@due` tag
  - `syncOriginalStatus(task, newStatus)`: two-way sync — finds original via `migratedFrom` wiki-link, replaces `[>]` status. Sets `syncing=true` during write
  - `findTaskLine()`: tries recorded `lineNumber` first (O(1)), falls back to `indexOf` scan
  - `resolveWikiLink()`: resolves by exact path, then basename

#### `migrationService.ts` (~240 lines) — Daily Migration & Morning Review
- **Class**: `MigrationService`
- **Types**: `MigrationAction`, `MigrationDecision`, `MigrationResult`, `MorningReviewData`
- **Key methods**:
  - `needsMigration()`: true if `lastMigrationDate ≠ today` AND there are actionable tasks
  - `getMorningReviewData()`: buckets all open tasks into yesterdayTasks (sourced from the **most recent prior daily note**, not literal `today − 1`), overdueTasks, todayTasks, availableTasks, availableOpenPoints. Deduplicates across daily notes. Also returns `yesterdayDate: string | null` (ISO date of the prior note, used by `MigrationModal` to label the section)
  - `executeMigrations(decisions[])`: forward/reschedule/done/cancel
  - `deduplicateDailyTasks()`: groups by normalized text, keeps most recent daily note copy
  - `markMigrationDone()`: persists today's date

#### `dailyNoteService.ts` (~135 lines) — Daily Note CRUD
- **Class**: `DailyNoteService`
- **Methods**:
  - `getDailyNotePath(date)`: returns `{dailyNotePath}/{YYYY-MM-DD}.md`
  - `getMostRecentPriorDailyNotePath(today)`: scans the configured daily-notes folder for `YYYY-MM-DD.md` files, returns the path of the newest one strictly before `today`, or `null` if none exists. Resilient to weekends/vacations/skipped days. Powers the Morning Review's "yesterday's incomplete" lookup
  - `getOrCreateDailyNote(date)`: creates folders + file with template
  - `addTaskToDaily()`: inserts under `## Tasks`
  - `addMigratedTask()`: inserts under `## Migrated Tasks` (preserves multi-hop `migratedFrom`)
  - `addRawTaskLine()`: inserts raw line under `## Tasks`

#### `sprintService.ts` (~114 lines) — Sprint Lifecycle Management
- **Class**: `SprintService`
- CRUD for sprints, auto-creates next if `autoStartNextSprint` is enabled
- Sprint IDs: `sprint-{Date.now()}`

#### `sprintTopicService.ts` (~230 lines) — Topic CRUD & Frontmatter
- **Class**: `SprintTopicService`
- CRUD for topic files in `{sprintTopicsPath}/` + frontmatter field setters
- Key methods: `createTopic(title, jira, priority, linkedPages, sprintId, impact?, effort?, dueDate?)`, `setTopicStatus`, `setTopicBlocked`, `setTopicImpact`, `setTopicEffort`, `setTopicDueDate`, `updateSortOrder`
- **Central sprint-change helper**: `assignTopicToSprint(filePath, sprintId)` — reads current `sprint` + `sprintHistory`, merges old+new into history, writes atomically. Every sprint-change path routes through this (including `moveTopicToBacklog`, `carryForwardTopic`, `archiveTopic`, `cancelTopic`) so history is never lost
- `updateTopicFrontmatter(filePath, updates)` — generic updater; `null` deletes the key, everything else stringifies
- See §15 for full schema and prioritization semantics

#### `src/parser/topicParser.ts` (~150 lines) — Topic Frontmatter Parser
- **Exports**: `parseTopicFile(content, filePath) → SprintTopic`, `parseFrontmatter(content)`, `serializeFrontmatter(fields)`
- Tolerates missing optional keys (`impact`, `effort`, `dueDate`, `sprintHistory`) → `null` / `[]`
- Validates enum-like keys against allowed values; unknown strings parse to `null`
- `serializeFrontmatter` **omits** keys whose value is `null`/`undefined` (keeps YAML tidy)
- `sprintHistory` stored as comma-separated IDs; when empty but `sprint` is set, parser returns `[sprintId]` as an in-memory backfill for legacy topics

#### `archiveService.ts` (~170 lines) — Task Archiving
- **Class**: `ArchiveService`
- **Method**: `archiveCompleted()` → `Promise<ArchiveResult>` — archives all Done/Cancelled tasks
- **Flow**: collects completed tasks → groups by archive file path → appends to archive files (with source annotation) → removes lines from source files (including description lines)
- **Grouping modes**: By month (`2026-03.md`) or by source file name
- **Archive file format**: Heading with source wiki-links, original task lines preserved

#### `analyticsService.ts` (~150 lines) — Weekly Analytics Engine
- **Class**: `AnalyticsService`
- **Cache**: `statsCache` keyed by `storeVersion + weekId`
- **Methods**: `getCurrentWeekStats()`, `getStatsForWeek(weekStart)`, `createSnapshot(stats)`, `computeStats()`

### UI Layer (`src/ui/`)

#### `FridayView.ts` (~244 lines) — Main Plugin View
- **Class**: `FridayView extends ItemView`
- View type: `friday-view`, icon: `check-square`, display: "Friday"
- **State**: `currentMode`, `currentGroupMode`, `searchQuery`, `collapsedGroups`, `lastStoreVersion`, `lastViewFingerprint`
- **Fingerprinting**: `refresh()` computes `"${mode}|${groupMode}|${searchQuery}|${storeVersion}"` — skips DOM rebuild if unchanged
- **Layout**: ViewSwitcher → Toolbar → Content (mode-specific) → AddTaskBar → Syntax Reference button
- **Tab reuse**: `onClickSource` iterates all leaves to find existing tab with the target file

#### `MigrationModal.ts` (~410 lines) — Morning Review Modal
- On open: proactively calls `dailyNotes.getOrCreateDailyNote(today)` so today's daily note exists even if the user takes no action in the dialog
- 3 sections: Incomplete from {prior date} (actionable; label built from `reviewData.yesterdayDate` via `formatDateDisplay`, falls back to "Yesterday's Incomplete" only when no prior note exists), Overdue (actionable), Due Today (preview)
- Each actionable task: Forward / Reschedule / Done / Cancel buttons (default: Forward)
- Task/Open Point pickers with debounced search (max 50 visible)
- Quick-add form to create new tasks for today
- Timer leak prevention: `pickerSearchTimers[]` cleared in `onClose()`

#### `WeeklyReviewModal.ts` (~115 lines) — Weekly Review Modal
- Summary cards, work type/purpose breakdowns with progress bars
- Recent 4 weeks comparison from `weeklyHistory`
- "Save Snapshot & Close" persists to `PluginData`

#### `InsertTaskModal.ts` (~170 lines) — Quick Create Task Modal (Editor)
- Fields: text, priority, date picker, type tag, work type, purpose, description (textarea)
- **Exported**: `buildTaskLine()` — constructs markdown checkbox line; `buildTaskBlock()` — task line + indented description lines
- **Interface**: `InsertTaskResult` — typed result object passed to callback

#### `SprintTopicModal.ts` (~260 lines) — Create/Edit Topic Modal
- Fields: title, JIRA, **Sprint** dropdown (`(Backlog)` + all sprints), priority, impact (critical/high/medium/low), effort (xs/s/m/l/xl), due date, linked pages (fuzzy page picker)
- **Sprint history** panel (edit mode only) — read-only list of every sprint the topic has been assigned to, with name + date range. Current sprint is accent-highlighted
- Sprint changes route through `SprintTopicService.assignTopicToSprint` so `sprintHistory` captures old + new sprint atomically
- Takes optional `SprintService` ref — when omitted, Sprint picker and history panel are hidden (safe for legacy callers)

#### `DueDateModal.ts` (~61 lines) — Due Date Picker Modal
- Date input with Set/Remove buttons, Enter key support
- Converts between ISO and plugin date format

#### `SprintModal.ts` (~120 lines) — Create/Edit Sprint Modal

#### `icons.ts` (~64 lines) — UI Helper Factory Functions
- `setFridayIcon()`, `createPriorityDot()`, `createDueBadge()`, `createSourceLink()`, `createStatusMarker()`
- Status display: `x→✓`, `>→→`, `<→←`, `-→—`

### UI Components (`src/ui/components/`)

| File | Lines | Purpose |
|------|-------|---------|
| `DailyView.ts` | ~92 | 4 sections: Overdue / Carried Over / Due Today / Unscheduled |
| `WeeklyView.ts` | ~86 | 7-day calendar (Mon–Sun) with per-day progress bars |
| `CalendarView.ts` | ~190 | Month grid with day cells, priority-colored task dots, click-to-expand detail panel |
| `SprintView.ts` | ~215 | Active sprint Kanban (Open/In Progress/Done columns) with drag-and-drop. Delegates card rendering to `TopicCard` |
| `TopicsOverviewView.ts` | ~410 | Top-level Topics tab: scope-filtered list of all topics with three sub-modes (List, Impact/Effort, Eisenhower). Drag-and-drop between Backlog ↔ status sections in List mode |
| `TopicCard.ts` | ~145 | Shared topic card renderer used by both `SprintView` and `TopicsOverviewView`. Options: draggable, click handlers, matrix-metadata chip row |
| `OpenPointsView.ts` | ~65 | Open points grouped by page + uncategorized section |
| `OverdueView.ts` | ~56 | Overdue tasks with configurable grouping |
| `AnalyticsView.ts` | ~147 | Summary cards, bar charts, 8-week trend table |
| `TaskList.ts` | ~49 | Renders `Map<string, TaskItem[]>` with `GroupHeader` + `TaskItemRow` |
| `TaskItemRow.ts` | ~120 | Checkbox + status marker + priority dot + text + description toggle + due badge + source link |
| `Toolbar.ts` | ~87 | Search input (debounced) + group mode buttons |
| `ViewSwitcher.ts` | ~57 | 9-tab bar (Daily / Weekly / Monthly / Calendar / Sprint / Topics / Overdue / Overview / Analytics) |
| `GroupHeader.ts` | ~69 | Collapsible header with chevron, label, count badge |
| `AddTaskBar.ts` | ~130 | Inline quick-add form (text + priority + date) |
| `SyntaxReference.ts` | ~90 | Modal with full syntax table, NL date examples, work types, purposes |

### Utility Layer (`src/utils/`)

#### `dateUtils.ts` (~198 lines)
- **Predicates**: `isToday()`, `isThisWeek()`, `isOverdue()`, `isSameDay()`
- **Constructors**: `todayStart()`, `getWeekStart()`, `getWeekDays()`, `getWeekStartConfigurable()`, `getWeekDaysConfigurable()`
- **Formatters**: `formatDateDMY()`, `formatDateISO()`, `formatDateDisplay()` (e.g., "Mon, Mar 16")
- **Converters**: `isoToPluginDate()` / `pluginDateToIso()` — bidirectional YYYY-MM-DD ↔ DD-MM-YYYY
- **ISO Week**: `getISOWeekNumber()`, `getISOWeekYear()`, `getWeekId()` (WW-YYYY), `formatWeekId()` (W12-2026)
- **Performance**: Many functions accept optional precomputed reference dates to avoid `new Date()` in loops

#### `pathUtils.ts` (~43 lines)
- `getEffectiveState(filePath, folderStates)`: walks folder hierarchy, returns first explicit include/exclude
- `shouldIncludeFile(filePath, folderStates)`: convenience wrapper

---

## 3. Data Flow

```
Markdown Files in Vault
        │
        ▼
┌─────────────────────────┐    On startup: fullScan() reads all .md
│    VaultScanner          │    On edit: debounceScanFile() re-parses single file
│    (vault events)        │    Uses vault.cachedRead() for bulk, vault.read() for incremental
└──────────┬──────────────┘
           │ parseTasksFromContent() per file
           ▼
┌─────────────────────────┐
│    TaskStore             │    In-memory array + category indices
│    (version counter)     │    Emits 'tasks-updated' events
└──────────┬──────────────┘
           │ Store events trigger UI refresh (debounced 100ms)
           ▼
┌─────────────────────────┐
│    FridayView          │    Renders mode-specific view components
│    (fingerprinting)      │    Coalesces rapid events, skips unchanged rebuilds
└──────────┬──────────────┘
           │ User actions (checkbox toggle, set due date, etc.)
           ▼
┌─────────────────────────┐
│    TaskWriter            │    Modifies source .md files at specific lines
│    (line-level edits)    │    Status change, due date, two-way sync
└──────────┬──────────────┘
           │ File modify triggers VaultScanner → cycle repeats
           ▼
      (cycle continues)
```

### Write-back Details
- `TaskWriter.findTaskLine()` first checks the recorded `lineNumber` with exact `rawLine` match (O(1) fast path)
- Falls back to full-content `indexOf` search if line number is stale
- Two-way sync sets `syncing=true` to prevent re-scan loops

---

## 4. Plugin Settings

| Setting | Type | Default | Controls |
|---------|------|---------|----------|
| `folderStates` | `Record<string, FolderState>` | `{}` | Per-folder include/exclude/inherit for scanning |
| `showCompletedTasks` | `boolean` | `true` | Whether done tasks appear in views |
| `defaultGroupMode` | `GroupMode` | `ByPage` | Default grouping mode |
| `defaultViewMode` | `FridayViewMode` | `Daily` | View shown on plugin open |
| `dailyNotePath` | `string` | `'BuJo/Daily'` | Folder for daily note files |
| `defaultSprintLength` | `number` | `14` | Sprint duration in days |
| `autoStartNextSprint` | `boolean` | `true` | Auto-create next sprint on completion |
| `migrationPromptOnStartup` | `boolean` | `true` | Show migration modal on startup |
| `taskHeadings` | `string[]` | `['Tasks', 'TODO', 'Action Items']` | Headings that classify items as Tasks |
| `openPointHeadings` | `string[]` | `['Open Points', 'Questions', 'Discussion Points']` | Headings for Open Points |
| `workTypes` | `TagCategory[]` | 6 defaults | Work type categories |
| `purposes` | `TagCategory[]` | 4 defaults | Purpose categories |
| `weekStartDay` | `number` | `1` (Monday) | First day of week (0=Sun…6=Sat) |
| `archiveFolderPath` | `string` | `'BuJo/Archive'` | Folder for archived completed tasks |
| `archiveGroupBy` | `'month' \| 'source'` | `'month'` | How archived tasks are grouped into files |
| `urgencyThresholdDays` | `number` | `2` | Days before due date to consider "urgent" in the Topics → Eisenhower sub-mode |

### Default Work Types
| Name | Short Code |
|------|-----------|
| Deep Work | DW |
| Review | RV |
| Coordination | CO |
| Admin | AD |
| Learning | LN |
| Leadership | LD |

### Default Purposes
| Name | Short Code |
|------|-----------|
| Delivery | D |
| Capability | CA |
| Strategy | ST |
| Support | SU |

### Persisted Plugin Data (`PluginData`)
| Field | Type | Purpose |
|-------|------|---------|
| `settings` | `PluginSettings` | All settings above |
| `sprints` | `Sprint[]` | Sprint definitions |
| `lastMigrationDate` | `string \| null` | ISO date of last migration run |
| `weeklyHistory` | `WeeklySnapshot[]` | Max 104 entries (2 years), FIFO pruned |
| `lastWeeklyReviewWeek` | `string \| null` | Week ID of last weekly review |

---

## 5. Commands & Interactions

### Registered Commands

| Command ID | Display Name | Type | Description |
|-----------|-------------|------|-------------|
| `open-bujo` | Friday: Open | callback | Opens/reveals the Friday view |
| `open-bujo-new-tab` | Friday: Open in New Tab | callback | Opens Friday in a new tab |
| `run-daily-migration` | Friday: Run Daily Migration | callback | Opens Morning Review modal |
| `weekly-review` | Friday: Weekly Review | callback | Opens Weekly Review modal |
| `syntax-reference` | Friday: Syntax Reference | callback | Opens syntax reference modal |
| `archive-completed` | Friday: Archive Completed Tasks | callback | Archives all Done/Cancelled tasks to archive folder |
| `insert-task-with-details` | Friday: Quick Create Task | editorCallback | Opens InsertTaskModal (with effort, description fields), inserts at cursor. Default hotkey: `Ctrl+Shift+T` |

### Ribbon & Context Menu

- **Ribbon icon**: `check-square` → opens Friday view
- **Editor context menu** (always): "Friday: Quick create task"
- **Editor context menu** (on checkbox lines): "Mark as done/open", "High/Medium/Low Priority", "Remove priority", "Set due date"

---

## 6. View Modes

| Mode | Enum | Description |
|------|------|-------------|
| **Daily** | `FridayViewMode.Daily` | 4 sections: Overdue → Carried Over → Due Today → Unscheduled. Shows pending count header. |
| **Weekly** | `FridayViewMode.Weekly` | 7-day calendar (Mon–Sun) with per-day task lists and progress bars (done/total %). |
| **Monthly** | `FridayViewMode.Monthly` | Goals progress, stats cards, month navigation, trends table, save snapshot. |
| **Calendar** | `FridayViewMode.Calendar` | Month grid with priority-colored task dots per day. Click a day to expand task detail below. Today highlighting. Month navigation + "Today" button. Respects `weekStartDay` setting. |
| **Sprint** | `FridayViewMode.Sprint` | Active sprint header (name, dates, days remaining), Kanban board (Open/In Progress/Done), drag-and-drop. Cards rendered via shared `TopicCard`. |
| **Topics** | `FridayViewMode.Topics` | Top-level Topic browser across **all** sprints and backlog. Scope chips: All / Active sprint / Backlog / Archived. Three sub-modes: **List** (grouped by Backlog + Open/In Progress/Done, drag-and-drop between sections), **Impact/Effort** (Quick Wins / Big Bets / Fill-ins / Time Sinks + Inbox), **Eisenhower** (Do Now / Plan Deep Work / Coordinate / Batch Later + Unscheduled). See §15. |
| **Overdue** | `FridayViewMode.Overdue` | Open tasks with past due dates. Supports all group modes. |
| **Overview** | `FridayViewMode.Overview` | All Tasks + Open Points sub-tabs, grouped by mode. |
| **Analytics** | `FridayViewMode.Analytics` | Summary cards, work type/purpose bar charts, 8-week trend table + chart. |

**Grouping** (Sprint, Overdue & Overview views only): By Page / By Priority / By Due Date

---

## 7. Friday Markdown Syntax

### Checkbox Statuses

| Marker | Status | Enum Value |
|--------|--------|------------|
| `- [ ]` | Open | `TaskStatus.Open` |
| `- [x]` or `- [X]` | Done | `TaskStatus.Done` |
| `- [>]` | Migrated (carried forward) | `TaskStatus.Migrated` |
| `- [<]` | Scheduled (future) | `TaskStatus.Scheduled` |
| `- [!]` | Open (treated as open) | `TaskStatus.Open` |
| `- [-]` | Cancelled / dropped | `TaskStatus.Cancelled` |

### Inline Tags (parsed & stripped from display text)

| Tag | Example | Description |
|-----|---------|-------------|
| `#priority/{level}` | `#priority/high` | Priority: high, medium, low |
| `#type/{category}` | `#type/openpoint` | Force category: task, openpoint |
| `@due {date}` | `@due 20-03-2026` or `@due 20-03` | Due date (DD-MM-YYYY or DD-MM) |
| `@due {natural}` | `@due tomorrow`, `@due next friday`, `@due in 3 days` | Natural language due date |
| `#work/{name}` or `#w/{code}` | `#w/DW` | Work type tag |
| `#purpose/{name}` or `#p/{code}` | `#p/D` | Purpose tag |
| `(from [[PageName]])` | `(from [[2026-03-15]])` | Migration source (auto-generated) |

> **Note**: The task-level `#effort/S|M|L` tag was removed when the Impact/Effort matrix was moved off tasks onto topics. Existing tags in user files become plain text. Effort estimation now lives on topic frontmatter (`effort: xs|s|m|l|xl`) — see §15.

### Natural Language Date Formats

| Expression | Resolves To |
|-----------|-------------|
| `today` | Today at midnight |
| `tomorrow` | Today + 1 day |
| `yesterday` | Today − 1 day |
| `monday`..`sunday` | Next occurrence of that weekday |
| `next monday`..`next sunday` | Same as above |
| `in N days` | Today + N days |
| `in N weeks` | Today + N×7 days |
| `in N months` | Today + N months |
| `next week` | Next Monday |
| `next month` | 1st of next month |
| `end of week` / `eow` | Next Friday |
| `end of month` / `eom` | Last day of current month |

### Task Descriptions

Indented non-checkbox lines immediately following a task are collected as that task's description:

```markdown
- [ ] Implement login flow #priority/high
    Need to support OAuth2 and SAML
    See design doc in [[Auth Design]]
- [ ] Write tests
```

The two indented lines become the description of "Implement login flow". Descriptions are shown in the Friday view via an expandable `…` toggle on the task row.

### Heading Classification

- Headings matching `taskHeadings` → items underneath are `ItemCategory.Task`
- Headings matching `openPointHeadings` → items are `ItemCategory.OpenPoint`
- Matching is **case-insensitive, substring** (e.g., "My Tasks List" matches "tasks")
- Deeper headings under a category heading are treated as **sub-headings** (preserved in `TaskItem.subHeading`)
- A same-level or higher non-matching heading **resets** the category context
- **Inline `#type/` tag always overrides** heading-based classification

### Tag Resolution
Work type and purpose values are resolved against configured `TagCategory[]`: matched by **name** (case-insensitive, spaces removed) or **shortCode** (case-insensitive). Unrecognized values are kept as-is.

---

## 8. Migration & Forwarding Flow

### Trigger Conditions
- **Auto on startup**: if `migrationPromptOnStartup=true` AND `lastMigrationDate ≠ today` AND there are actionable tasks
- **Manual**: via command `Friday: Run Daily Migration`

### Morning Review Data Collection (`getMorningReviewData()`)

1. **Prior-day tasks (`yesterdayTasks`)**: Open tasks from the **most recent daily note dated strictly before today**, resolved via `DailyNoteService.getMostRecentPriorDailyNotePath(today)` — not literal `today − 1`. Handles weekends, vacations, and any skipped days. The resolved ISO date is also returned as `yesterdayDate` so `MigrationModal` can label the section dynamically (e.g. "Incomplete from Thu, Mar 26"). When no prior daily note exists at all, `yesterdayTasks` is empty and `yesterdayDate` is `null`.
2. **Overdue tasks**: Open tasks with past due dates (excluding the prior-day set above)
3. **Today's tasks**: Open tasks due today (preview only)
4. **Available tasks**: All other open tasks (pickable for adding to today)
5. **Available open points**: All open points (pickable)
6. **Deduplication**: Tasks migrated across multiple daily notes → only most recent copy shown

### Migration Actions

| Action | Effect |
|--------|--------|
| **Forward** | Original marked `[>]`. Copy created in today's daily under `## Migrated Tasks` with `(from [[OriginalFile]])`. Priority/due date preserved. Multi-hop: preserves earliest `migratedFrom`. |
| **Reschedule** | Due date updated in source file via `@due` tag replacement |
| **Done** | Status changed to `[x]` in source file |
| **Cancel** | Status changed to `[-]` in source file |

### Daily Note Template
```markdown
# Daily Log — Mon, Mar 16, 2026

## Tasks

## Migrated Tasks
```

- `## Tasks` — for new tasks created manually or via quick-add
- `## Migrated Tasks` — for tasks forwarded from previous days or other pages

### Migrated Task Line Format
```markdown
- [ ] Task text #priority/high @due 20-03-2026 (from [[2026-03-15]])
```

### Deduplication Logic
When the same task is forwarded Day1→Day2→Day3, copies exist in multiple daily notes. `deduplicateDailyTasks()` groups by normalized text (strips `(from [[...]])`, case-insensitive) and keeps only the copy from the most recent daily note file.

---

## 9. Analytics

### Stats Tracked (per week)

| Metric | Description |
|--------|-------------|
| `totalPlanned` | Count of all tasks in the week window |
| `totalCompleted` | Tasks with status Done |
| `totalMigrated` | Tasks with status Migrated |
| `totalCancelled` | Tasks with status Cancelled |
| `completionRate` | `(completed / planned) * 100` |
| `workTypeBreakdown` | Per work type: `{ planned, completed }` |
| `purposeBreakdown` | Per purpose: `{ planned, completed }` |

Untagged tasks are grouped under `"Untagged"`.

### Task Selection for a Week
Tasks are included if:
1. Their `dueDate` falls within the week range, OR
2. They reside in a daily note file dated within the week (parsed from filename)

### Weekly Snapshots
- **Format**: `WeeklySnapshot` with `weekId` (WW-YYYY), ISO `weekStart`, all counts, breakdowns, `savedAt` timestamp
- **Storage**: `pluginData.weeklyHistory[]`, max **104 entries** (2 years), FIFO pruned
- **Auto-prompt**: on startup, if `lastWeeklyReviewWeek ≠ currentWeekId`, the review modal auto-opens
- **UI**: Last 4 weeks in WeeklyReviewModal, last 8 weeks in AnalyticsView trend chart

---

## 10. Task Archiving

### Purpose
Over months of use, completed tasks accumulate in daily notes and project pages. Archiving moves them to dedicated archive files, keeping the vault clean and scan performance fast.

### Trigger
- **Manual command**: `Friday: Archive Completed Tasks` — archives all Done and Cancelled tasks vault-wide

### Archive Flow (`ArchiveService.archiveCompleted()`)
1. Collects all Done/Cancelled tasks from every category (tasks, open points, goals, uncategorized)
2. Groups by archive file path based on `archiveGroupBy` setting:
   - **By month**: `{archiveFolderPath}/2026-03.md` (uses due date, or current date if none)
   - **By source**: `{archiveFolderPath}/{source-filename}.md`
3. Creates archive folder structure if needed
4. Appends task lines to archive files, grouped by source with `## From [[SourceName]]` headings
5. Removes archived lines from source files (including any description lines that followed them)
6. Shows notice: "Archived N task(s) to M file(s)"

### Archive File Format
```markdown
# Archived Tasks — 2026-03

## From [[2026-03-15]]

- [x] Complete login flow #priority/high @due 20-03-2026

## From [[ProjectNotes]]

- [x] Review API design #w/RV
- [-] Deprecated endpoint cleanup
```

### Recommended Setup
Exclude the archive folder from scanning (via Settings → Scanning → set archive folder to Exclude) so archived tasks don't appear in views.

---

## 11. Two-Way Sync

### Problem
When a task is migrated (forwarded) from File A to a daily note, completing it in the daily note should also update File A.

### Detection (`VaultScanner.detectAndSyncStatusChanges()`)
On every incremental file scan:
1. Compares old tasks vs new tasks for the modified file
2. For any task with `migratedFrom` that changed from `Open` → `Done` or `Cancelled`:
3. Calls `TaskWriter.syncOriginalStatus()` (fire-and-forget)

### Sync Execution (`TaskWriter.syncOriginalStatus()`)
1. Resolves `migratedFrom` (wiki-link name) to a `TFile` via basename lookup
2. Reads the original file, searches for a `[>]` (migrated) checkbox line with matching text (cleaned of tags)
3. Replaces the `[>]` with the new status character (`[x]` or `[-]`)
4. Sets `syncing = true` during write to prevent scanner re-scan

### Guard Against Re-scan Loops
- `VaultScanner.scanFile()` checks `this.writer?.isSyncing` — if true, **skips** scan entirely
- `syncing` is cleared after `SYNC_CLEAR_DELAY_MS` (500ms)

---

## 12. Performance Optimizations

### Caching

| Cache | Location | Invalidation |
|-------|----------|-------------|
| `cachedAllTasks` | VaultScanner | Set to `null` on any file change (scan/delete/rename) |
| `tasksByFile: Map` | VaultScanner | Per-file: only modified file re-parsed |
| `cachedClassifier` | VaultScanner | Invalidated when heading settings change |
| `statsCache` | AnalyticsService | Keyed by `storeVersion + weekId` |
| Category indices | TaskStore | Rebuilt on every `setTasks()` call |

### Debouncing

| Constant | Delay | Purpose |
|----------|-------|---------|
| `SCAN_DEBOUNCE_MS` | 300ms | Per-file vault change events |
| `SEARCH_DEBOUNCE_MS` | 200ms | Search input in toolbar & picker |
| `REFRESH_DEBOUNCE_MS` | 100ms | Coalesces rapid store events into single UI refresh |
| `SETTINGS_DEBOUNCE_MS` | 500ms | Text input changes in settings tab |
| `SYNC_CLEAR_DELAY_MS` | 500ms | Delay before clearing sync flag |

### Fingerprinting
- **View fingerprint**: `"${mode}|${groupMode}|${searchQuery}|${storeVersion}"` — skips DOM rebuild if unchanged
- **Store version**: monotonically increasing counter, bumped on every `setTasks()` — enables cheap equality checks

### Batch Processing
- `SCAN_BATCH_SIZE` = 50: files processed in parallel per batch during full scan via `Promise.all()`

### Read Optimization
- Full scan: `vault.cachedRead()` (Obsidian's cached file content)
- Incremental scan: `vault.read()` (fresh from disk)

### UI Optimizations
- Per-file debounce timers (`debounceTimers: Map`) — concurrent edits to different files don't cancel each other
- `collapsedGroups: Set<string>` persists across view refreshes
- Picker lists capped at 50 visible items with "use search to narrow" message
- Date utility functions accept optional precomputed reference dates to avoid `new Date()` in tight loops
- Single-pass bucketing in DailyView, WeeklyView, and MigrationService (replaced multiple `.filter()` calls)
- Toolbar timer cleanup in `onClose()`; MigrationModal picker timer cleanup in `onClose()`

---

## 13. Constants Reference

| Constant | Value | Usage |
|----------|-------|-------|
| `VIEW_TYPE_FRIDAY` | `'friday-view'` | View registration identifier |
| `CHECKBOX_REGEX` | `/^(\s*)-\s*\[([ x><!-])\]\s+(.*)$/i` | Matches checkbox lines |
| `HEADING_REGEX` | `/^(#{1,6})\s+(.+)$/` | Matches markdown headings |
| `PRIORITY_TAG_REGEX` | `/#priority\/(high\|medium\|low)/i` | Priority tags |
| `TYPE_TAG_REGEX` | `/#type\/(task\|openpoint)/i` | Category type tags |
| `DUE_DATE_REGEX` | `/@due\s+([\w\d\s\/-]+?)(?=\s+[@#(]\|$)/i` | Due date annotations (numeric + natural language) |
| `MIGRATED_FROM_REGEX` | `/\s*\(from\s+\[\[([^\]]+)\]\]\)\s*/` | Migration source links |
| `WORK_TYPE_REGEX` | `/#(?:work\|w)\/(\S+)/i` | Work type tags |
| `PURPOSE_REGEX` | `/#(?:purpose\|p)\/(\S+)/i` | Purpose tags |
| `EFFORT_REGEX` | `/#effort\/(S\|M\|L)/i` | Effort estimate tags |
| `SCAN_DEBOUNCE_MS` | `300` | File change debounce |
| `SEARCH_DEBOUNCE_MS` | `200` | Search input debounce |
| `REFRESH_DEBOUNCE_MS` | `100` | UI refresh coalescing |
| `SETTINGS_DEBOUNCE_MS` | `500` | Settings input debounce |
| `SYNC_CLEAR_DELAY_MS` | `500` | Sync flag clear delay |
| `SCAN_BATCH_SIZE` | `50` | Parallel file read batch size |

---

## 14. Build & Release

### Build Commands
```bash
# Development build (with sourcemaps)
node esbuild.config.mjs

# Production build (minified)
node esbuild.config.mjs production

# Type check only
npx tsc --noEmit --skipLibCheck
```

### Output Files
- `main.js` — bundled plugin code
- `styles.css` — plugin styles (copied as-is)
- `manifest.json` — plugin manifest

### Release Script
```bash
node release.mjs [major|minor|patch]
```
- Bumps version in `manifest.json`, `package.json`, `versions.json`
- Runs production build
- Copies `main.js`, `styles.css`, `manifest.json` to `_release/`

### Styles
`styles.css` (~1,700 lines) uses Obsidian CSS variables (`var(--text-muted)`, `var(--background-modifier-border)`, etc.) for full theme compatibility. All components are styled with `.friday-*` class prefix. Includes dedicated sections for Calendar grid, Topic matrices (`.friday-topicmx-*` — both Impact/Effort and Eisenhower share the quadrant layout), Topics list view with drop-zone highlighting (`.friday-topics-list-*`), sprint-history chips (`.friday-topic-sprint-history-*`), and task description toggles.

---

## 15. Topics & Sprint Prioritization

Topics are the strategic layer above individual tasks: each topic is a markdown file in `{sprintTopicsPath}/` (default `BuJo/Sprints/Topics/`) with YAML frontmatter and sections for linked pages, tasks, and notes. A topic can be assigned to a sprint or left in the **Backlog**; it can also carry Impact/Effort/Due-Date metadata used by the two prioritization matrices.

### Frontmatter schema

| Key | Type | Required | Notes |
|-----|------|----------|-------|
| `status` | `open \| in-progress \| done` | yes | Column in the Sprint Kanban and the Topics List sub-mode |
| `priority` | `none \| low \| medium \| high` | yes | Priority dot; used as Eisenhower fallback when `impact` is unset |
| `blocked` | `true \| false` | yes | Renders a BLOCKED badge on the card; auto-cleared when moved to Done |
| `sprint` | sprint ID or empty | yes | Empty = Backlog. Every `sprint-close`, `carryForward`, `archive`, `cancel`, and drag-drop routes through `SprintTopicService.assignTopicToSprint` |
| `sortOrder` | number | yes | Manual Kanban column ordering (default `999` = end) |
| `impact` | `critical \| high \| medium \| low` | no | Strategic weight. Drives Impact/Effort quadrant (High = {critical, high}) and Eisenhower importance |
| `effort` | `xs \| s \| m \| l \| xl` | no | Size estimate. Drives Impact/Effort quadrant (Small = {xs, s}) |
| `dueDate` | `YYYY-MM-DD` | no | Eisenhower urgency signal — urgent when within `urgencyThresholdDays` |
| `jira` | string | no | Displayed as ticket chip on the card |
| `sprintHistory` | comma-separated IDs | no | Append-only log of every sprint this topic has been assigned to |

Missing optional keys parse to `null` / `[]`. The serializer **omits null-valued keys** so topics with no matrix metadata keep a clean YAML header.

### Topics tab sub-modes

- **List** — sections: Backlog (no sprint) + Open / In Progress / Done. Empty Backlog is hidden when the scope filter is "Active sprint". Drag-and-drop:
  - Drop onto a status section → `setTopicStatus`. If dragged from Backlog, also `assignTopicToSprint(active)` first.
  - Drop onto Backlog → `moveTopicToBacklog` (clears `sprint`, preserves status).
  - Blocked → Done auto-clears the blocked flag.
  - If no active sprint exists when moving out of Backlog, a Notice explains and nothing is written.
- **Impact / Effort** — 2×2 grid. Quadrant assignment:
  - `highImpact = impact ∈ {critical, high}`, `smallEffort = effort ∈ {xs, s}`
  - Quick Wins (high + small), Big Bets (high + med/large), Fill-ins (low + small), Time Sinks (low + med/large)
  - Topics missing either field land in an **Inbox** below the grid.
- **Eisenhower** — 2×2 grid using `dueDate` for urgency and (`impact` ?? fallback to `priority`) for importance:
  - urgent = due within `urgencyThresholdDays`
  - important = `impact ∈ {critical, high}` if `impact` is set, else `priority ∈ {high, medium}`
  - Topics without `dueDate` go to an **Unscheduled** bucket.

### Scope filter

Chip row in the Topics header scopes every sub-mode:

| Chip | Predicate |
|------|-----------|
| All | (everything) |
| Active sprint | `sprintId === activeSprint.id` |
| Backlog | `!sprintId` |
| Archived | `status === 'done' && !sprintId` |

### Sprint history

`sprintHistory` is a cumulative list of every sprint a topic has been assigned to, in insertion order. All write paths that change the `sprint` frontmatter field go through **one helper** (`SprintTopicService.assignTopicToSprint`) that:

1. Reads the current `sprint` and `sprintHistory` from frontmatter.
2. Merges both the departing sprint (from step 1) and the new `sprintId` into history, de-duplicating.
3. Writes `sprint` + `sprintHistory` atomically via `updateTopicFrontmatter`.

This means moving a topic Backlog → Sprint A → Backlog → Sprint B produces `sprintHistory: A,B` — nothing is lost on backlog passes. `archiveTopic` and `cancelTopic` go through the same helper before setting `status: done`, so sprint membership is preserved on archival.

**Legacy topics** (frontmatter has `sprint: X` but no `sprintHistory`): the parser synthesizes `[X]` in memory so the current sprint still shows in the modal's history panel. Persisted history remains empty until the next reassignment, at which point the departing sprint is captured automatically. Historical sprints before tracking began are not reconstructed — this is expected.

### Service API surface (`SprintTopicService`)

| Method | What it writes |
|--------|----------------|
| `createTopic(…, sprintId, impact, effort, dueDate)` | Creates file with full frontmatter; `sprintHistory` seeded to `sprintId` when non-empty |
| `setTopicStatus`, `setTopicBlocked`, `setTopicImpact`, `setTopicEffort`, `setTopicDueDate`, `updateSortOrder` | Single-field setters — pass `null` to clear optional fields |
| `assignTopicToSprint(filePath, sprintId)` | **Canonical sprint-change entrypoint.** Handles history merge. `''` moves to Backlog |
| `moveTopicToBacklog(filePath)` | Thin wrapper over `assignTopicToSprint(filePath, '')` |
| `carryForwardTopic(filePath, newSprintId)` | Sprint-close flow — delegates to `assignTopicToSprint` |
| `archiveTopic`, `cancelTopic` | `assignTopicToSprint('')` then `setTopicStatus('done')` — history preserved |
| `updateTopicFrontmatter(filePath, updates)` | Generic updater. `null`/`undefined` values **delete** the key; everything else stringifies |

### Settings migration

`main.ts` rewrites any persisted `defaultViewMode` of `'eisenhower'` or `'impactEffort'` (the pre-refactor task-level modes) to `FridayViewMode.Topics` on load, so users who had those pinned land on the replacement view instead of hitting a missing switch case.

---

## 16. JIRA Integration (Optional Module)

An optional module that enriches topics with live status and assignee data from a configured JIRA Cloud instance. Fully gated by `settings.jiraEnabled` — when off, no fetches happen and no JIRA UI is rendered.

### Module boundary

- **Entry point**: `src/services/jiraService.ts` (`JiraService`). A single instance owned by the plugin, constructed with a `getSettings` callback so it always reads live config.
- **Everything is in-memory** — issue data is never persisted. The cache is wiped on any `saveSettings()` call (URL/token may have changed).
- **Views never talk to the JIRA API directly** — they call `jiraService.prefetchMany()` on render and read back `getCached(key)` / `isLoading(key)` / `getError(key)` synchronously. Updates arrive via the service's event bus.

### Settings fields (in `PluginSettings`)

| Field | Default | Description |
|---|---|---|
| `jiraEnabled` | `false` | Master switch. When false, every method on `JiraService` is a no-op. |
| `jiraBaseUrl` | `''` | Atlassian Cloud URL, e.g. `https://mycompany.atlassian.net` (no trailing slash). |
| `jiraEmail` | `''` | Atlassian account email (Basic-auth username). |
| `jiraApiToken` | `''` | Personal API token (password-masked in settings, plain text on disk). |
| `jiraCacheTtlMinutes` | `10` | How long to keep fetched issue data before re-hitting the API. |

`JiraService.isEnabled()` returns true only when the toggle is on **and** all three credential fields are non-empty.

### Fetch lifecycle

1. A view renders, calls `jiraService.prefetchMany(keys)` for every visible topic's `jira` frontmatter value.
2. `extractIssueKey()` pulls the first `[A-Z][A-Z0-9]+-\d+` match — the `jira:` field can be a bare key, a full URL, or any text containing a key.
3. For each new/stale key, a `GET /rest/api/3/issue/{key}?fields=summary,status,assignee` is fired via Obsidian's `requestUrl()` (bypasses CORS). `throw: false` lets non-2xx responses surface as structured `{kind: 'error'}` cache entries instead of uncaught rejections.
4. In-flight requests are tracked in an `inFlight: Map<key, Promise>` so simultaneous calls for the same key share one network round-trip.
5. On completion (success, HTTP error, or thrown exception), the cache entry transitions to `fresh` / `error`, the monotonic `version` counter bumps, and registered listeners are notified.

### View integration

`SprintView` and `TopicsOverviewView` both receive a nullable `JiraService` through their constructor. Each defines two helpers:

- `prefetchJiraKeys(topics)` — called once per render, no-op when disabled.
- `jiraOptsFor(topic)` — returns `{ jiraInfo, jiraLoading, jiraError }` spread into `TopicCard` options.

`FridayView.refresh()` folds `jiraService.version` into the render fingerprint, so JIRA-only cache mutations (fresh fetches, TTL expiry, clears on settings save) actually trigger a rebuild. The view subscribes to `JiraService.on()` in `onOpen()` and unsubscribes in `onClose()` — both are debounced through the same `scheduleRefresh` path the task store uses.

### TopicCard rendering

When `opts.jiraInfo` is provided, `TopicCard` renders a horizontal row containing:

- The **issue key** (clickable — opens `info.issueUrl` via `window.open()` in a new tab).
- A **status chip** with a class derived from `info.statusCategory` (`new` → grey, `indeterminate` → blue, `done` → green, `unknown` → muted).
- An **assignee chip** (`info.assignee ?? 'Unassigned'`).

Below the row, the issue **summary** is shown as a one-line muted subtitle (ellipsised on overflow).

While a fetch is pending, a subtle `…` chip appears. On the last-fetch error, a red `!` chip appears; the error message is in the chip's `title` attribute.

### Security posture

- The API token is stored in the plugin's `data.json`, the same location as every other vault-scoped setting. There is no at-rest encryption — the password-masked input exists only to prevent over-the-shoulder leaks during editing.
- `btoa(email:token)` is used for Basic auth (Electron/Chromium provides it natively). No third-party HTTP libraries are pulled in.
- No vault data or topic contents are ever sent to JIRA — the integration is strictly a one-way read of public-to-you issue metadata.

### Self-test

The settings tab includes a `Test connection` button that calls `jiraService.testConnection()`, which hits `GET /rest/api/3/myself`. Result surfaces as a `Notice` (display name on success, HTTP status or exception message on failure) — no view-state side effects.

### Disabling the module

Turning `jiraEnabled` off immediately:
- Causes every `JiraService` method to return null/false on the next call.
- Hides the chip row on the next `TopicCard` render (the `jiraInfo` lookup short-circuits to `{}`).
- The cache is cleared at the moment `saveSettings()` runs, freeing whatever issue data was held.

The topic's `jira:` frontmatter value itself is **never touched** — disabling the module just stops the enrichment. Re-enabling restores live data on the next render.

### Multi-key topics (many-to-many link with JIRA)

`SprintTopic.jira` is `string[]` on the model. The topic frontmatter accepts either a single key (`jira: PROJ-1`) or a comma-separated list (`jira: PROJ-1, PROJ-2`). `topicParser.ts` runs a global `[A-Z][A-Z0-9]+-\d+/g` regex against the raw value, deduplicating and preserving insertion order — so legacy single-key topics parse transparently into a one-element array.

`TopicCard` renders one JIRA row per element in `topic.jira[]`. Each row has its own cached state (fresh / loading / error), fetched independently by `prefetchMany()`. The **inverse direction** — one JIRA issue appearing under many topics — is exploited by the JIRA Dashboard (§17) via a forward index built from `scanner.getAllTopics()`.

---

## 17. JIRA Dashboard (read-only personal dashboard)

A separate workspace view — distinct from the Friday tab — that surfaces the user's active JIRA work without leaving Obsidian. Read-only: clicking a row opens the issue in the default browser; clicking a topic chip opens the topic file in the current leaf. Never writes to JIRA, never writes the dashboard result to disk.

### Module boundary

- **Entry points**: `src/services/jiraDashboardService.ts` (`JiraDashboardService`) and `src/ui/JiraDashboardView.ts` (`JiraDashboardView`).
- Registered as a separate `ItemView` (`VIEW_TYPE_JIRA_DASHBOARD`) with its own ribbon icon (`layout-dashboard`) and commands (`Open JIRA Dashboard`, `Refresh JIRA Dashboard`).
- Shares credentials with `JiraService` via `PluginSettings`, but keeps its own cache (a single result set, not a per-key map) and its own event bus.

### Settings fields (in `PluginSettings`)

| Field | Default | Description |
|---|---|---|
| `jiraDashboardProjects` | `[]` | Project keys scoping the JQL. Empty = all visible projects. |
| `jiraDashboardTtlMinutes` | `10` | Separate from per-issue TTL. Drives visibility-aware auto-refresh. |
| `jiraSprintFieldId` | `'customfield_10020'` | Custom field ID for JIRA's Sprint field. Varies per instance. |
| `jiraDashboardCollapsedSections` | `{}` | Per-section sticky collapsed state, keyed by section id. |

### Fetch lifecycle

1. `JiraDashboardService.refresh()` fires a single `GET /rest/api/3/search/jql` with `maxResults=100`. This is the successor to the deprecated `POST /rest/api/3/search` (removed per Atlassian changelog CHANGE-2046 — the old path now returns HTTP 410 Gone). GET is used instead of POST because some corporate tenants enforce XSRF on POSTs even with `X-Atlassian-Token: no-check`, and a 100-row dashboard URL is ~1KB — well under any gateway limit. The new endpoint rejects the `*all` magic token, so the field list is named explicitly: `summary, status, priority, assignee, reporter, duedate, resolutiondate, updated, labels, parent, issuetype, timespent, timeestimate, [sprint field], customfield_10021`.
2. The JQL is built from live settings:
   ```
   (assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser())
   [AND project in ("PROJ", "DEV")]
   AND (resolution = Unresolved OR resolutiondate >= -7d)
   ORDER BY updated DESC
   ```
3. Response is parsed into `JiraDashboardIssue[]` (see `types.ts`). The parser tolerates the sprint field being an array of objects **or** legacy comma-strings (`name=Sprint 12,state=ACTIVE,…`) — newer Cloud instances ship objects, older ones ship strings. Flagged detection reads `customfield_10021` (standard on Cloud) or a raw `flagged` field. Response bodies are run through a `safeParseJson` helper rather than `resp.json` (which is a getter that throws on non-JSON bodies — e.g. a plain-text `"XSRF check failed"` on a 403). This keeps a non-JSON error body from masking the real HTTP status with a parse exception.
4. In-flight dedup: a concurrent `refresh()` returns the same promise.
5. On completion, the service transitions state (`empty` → `loading` → `fresh`/`error`), bumps its `version` counter, and notifies listeners.

Cache is cleared on every `saveSettings()` call — URL/token/projects may have changed. Note: sticky UI-state saves from the dashboard (section collapse/expand) bypass `saveSettings` and go directly to `saveData(this.data)` from `main.ts` to avoid wiping the fetched result set on every section toggle.

### View layout

- **Header**: title · refresh button · `Refreshed Xm ago [· stale]` timestamp · live text-filter input (200ms debounce).
- **Sections** (each issue falls into exactly one, in declaration order):
  1. **Blocked / Flagged** — `issue.flagged === true`.
  2. **In Progress** — `statusCategory === 'indeterminate'`.
  3. **In Current Sprint** — `sprintActive === true`.
  4. **Reported by Me** — leftover bucket (everything else not yet placed). Hidden when empty.
  5. **Recently Done** — `statusCategory === 'done'`.
- Within each bucket: flagged first, then priority rank (Highest → Lowest → unknown), then due date asc, then `updatedAt` desc.
- **Sticky collapse state** per section, persisted in `jiraDashboardCollapsedSections`. `Reported by Me` and `Recently Done` default to collapsed on first open.

### Row rendering

Each `JiraDashboardIssue` becomes a compact two-row grid:
- **Left column**: issue-type icon (16×16) + key (clickable → browser).
- **Right column, row 1**: summary (clickable → browser), with optional parent line below (`↑ PROJ-100 — epic summary`).
- **Right column, row 2**: chip row — status, priority (with icon), flagged badge, assignee, due date (red when overdue), sprint name (accent when active), `⏱ Xh spent / Yh left`, first 5 labels, `+N` for the rest, then `↔ Topic` chips (one per topic that references this issue).

### Topic-link forward index

On every `renderContent()`, the view builds a one-pass `Map<issueKey, SprintTopic[]>` from `scanner.getAllTopics()`. Every element of each topic's `jira[]` array contributes to the map. One issue key with multiple topics renders multiple `↔ Topic` chips on the same row; each chip opens its topic file in the current leaf. The index is rebuilt per render — cheap enough given the scanner's in-memory topic cache and avoids stale-link bugs when topics are renamed or their `jira:` field is edited.

### Visibility-aware refresh

The dashboard does **no background polling**. `refresh()` runs in three scenarios:
- On `onOpen()` — when the cache is stale or empty.
- On `onResize()` — when the view becomes visible (tab/focus switch) and the cache has aged past the TTL.
- On user click of the `Refresh` button.

This keeps the dashboard fresh when actually being looked at, and zero-cost when hidden.

### JIRA → Topic actions (right-click on a row)

The dashboard is read-only against JIRA, but it doubles as a natural launch point for topic creation/linking since the user is already staring at the issue. Right-clicking any row opens a context menu with:

- **Create topic from this issue** — opens `SprintTopicModal` seeded via its optional `prefill` parameter (`{ title, jira, priority }`). Title ← `issue.summary` (fallback: issue key), JIRA field ← `issue.key`, priority ← `mapJiraPriority()` (Highest/High → `high`, Medium → `medium`, Low/Lowest → `low`, else `none`). Default sprint is the currently active sprint from `SprintService.getActiveSprint()`, falling back to Backlog if none. JIRA is source-of-truth for title/priority **on first create only** — no subsequent syncs rewrite the topic's frontmatter.
- **Link to existing topic…** — opens a `FuzzySuggestModal` (`TopicSuggestModal`) over every topic in the vault filtered to those not already carrying this key. Selecting one appends the key to the topic's existing `jira[]` array (dedup preserving insertion order) via `SprintTopicService.updateTopicFrontmatter`. Auto-disables when every topic already has this key.
- **Open topic: …** — one entry per already-linked topic, for quick nav to the topic file. Only appears when `topicIndex.get(issue.key)` is non-empty.

Both write paths route through the standard topic service (`createTopic` / `updateTopicFrontmatter`) so they participate in the normal file-watch → scanner → `onTopicsChange` → re-render cycle. The dashboard view subscribes to `VaultScanner.onTopicsChange` and rebuilds the forward topic index on each fired event, so a newly-created or re-linked topic's `↔ Topic` chip appears on the row without a manual refresh. The scanner has no explicit unsubscribe API, so the callback guards on `contentContainer` being non-null (set to `null` in `onClose`).

### Team tracking (lead-analyst mode)

Opt-in layer on top of the personal dashboard for leads who organize a team's work. Configure team members in `Settings → JIRA Integration → Team Members` (full name + nickname + email + active flag, stored on `PluginSettings.teamMembers`), flip the `jiraTeamEnabled` toggle, and the view grows a second **Team** tab (see *Tab layout* below). Email is the JIRA identity — used directly in `assignee in ("email1", "email2", …)` JQL clauses.

**Tab layout.** The header carries a tab bar with two tabs — **My Work** and **Team** — whenever team tracking is enabled. Selection persists via `PluginSettings.jiraDashboardActiveTab: 'mine' | 'team'` (default `'mine'`, written through the `saveData` UI-state bypass so switching tabs doesn't wipe fetched caches). `renderContent()` routes to `renderMineTab()` or `renderTeamTab()` based on the resolved active tab — only the selected block is built per render, so off-screen tab content costs zero layout. When team tracking is toggled off the tab bar hides entirely (`.is-hidden`) and `resolveActiveTab()` coerces a stale `'team'` selection back to `'mine'`, so the dashboard degrades gracefully to its pre-team-feature appearance. Switching tabs kicks a `refresh()` on the target service only if its cache is stale; already-fresh tabs switch instantly with no network.

**`JiraTeamService` (`src/services/jiraTeamService.ts`)** mirrors `JiraDashboardService`'s state machine, event bus, and fetch mechanics (GET `/search/jql`, explicit field list, `safeParseJson`, in-flight dedup). Separate rather than folded into one service so a team-fetch failure can never mask the user's own issues. `isEnabled()` short-circuits when the master toggle is off, team toggle is off, creds are missing, or no active member has a valid-looking email. Reuses `jiraDashboardProjects` + `jiraDashboardTtlMinutes` — same project scope and same visibility-aware auto-refresh cadence as the personal sections.

The Team tab renders its content in two parts:

1. **Workload heatmap** — one row per active member, sorted heaviest-first. Each row has a proportionally-sized segmented bar colored by status category (**red** blocked · **blue** in-progress · **grey** open · **faded green** done). Widths scale against the team max so the busiest member fills the track and others are visually relative. A compact count summary (`3 blocked · 5 in progress · 2 open`) sits to the right.
2. **Per-person sections** — one collapsible section per member, sorted by workload desc, reusing the existing `renderIssueRow` so right-click context menus (Create topic / Link to topic) work identically to personal rows. Sticky collapsed state keyed by `team:<email>` in `jiraDashboardCollapsedSections`.

**Bucketing**: each team-scoped issue is assigned to exactly one member by: (1) case-insensitive email match against `issue.assigneeEmail` (unambiguous when present — many Cloud tenants hide `emailAddress` for privacy), falling back to (2) case-insensitive `fullName` vs `issue.assignee` displayName match. Issues matching no member are dropped rather than bucketed into a catch-all. `JiraDashboardIssue` carries both `assigneeEmail` and `assigneeAccountId` now, populated by both parsers.

Everything in this layer is read-only against JIRA. The only writes are to local topic files, via the same right-click actions available on the personal rows.

### Performance posture

- **One JQL round-trip per refresh**, 100-row cap — per service. The personal and team services run independent fetches, so enabling the team block doubles the network round-trip count from 1 → 2 per refresh, no more.
- **No per-issue secondary fetches** — each service returns enough fields in one call (`summary, status, priority, assignee, reporter, duedate, resolutiondate, updated, labels, parent, issuetype, timespent, timeestimate, [sprint field], customfield_10021`).
- **Two independent event buses** (`JiraDashboardService` + `JiraTeamService`); the view subscribes to both and re-renders on either. Folds each service's `version` separately so a stale personal cache doesn't invalidate a fresh team cache or vice versa.
- **Read-only against JIRA** — no JIRA mutations, no transitions, no comments, no risk of the plugin silently changing a ticket. Topic writes are local-only and never round-trip to JIRA.

---

## Key Design Decisions

1. **No external dependencies** — pure Obsidian API + TypeScript
2. **Markdown-native** — all data lives in standard markdown files, no proprietary database
3. **Non-destructive** — plugin reads/writes standard checkbox syntax; removing the plugin leaves valid markdown
4. **Event-driven** — vault events → scanner → store → view, with debouncing at every boundary
5. **Single write point** — all markdown modifications go through `TaskWriter` to prevent conflicts
6. **BuJo-inspired** — migration, daily/weekly review, work categorization follow Bullet Journal methodology
7. **Theme-responsive** — all colors/spacing use Obsidian CSS variables
