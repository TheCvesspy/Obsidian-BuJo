# BuJo — Obsidian Task Manager Plugin

## Developer Documentation

> **Plugin ID**: `obsidian-task-bujo` · **Name**: BuJo · **Version**: 1.0.0  
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
7. [BuJo Markdown Syntax](#7-bujo-markdown-syntax)
8. [Migration & Forwarding Flow](#8-migration--forwarding-flow)
9. [Analytics](#9-analytics)
10. [Two-Way Sync](#10-two-way-sync)
11. [Performance Optimizations](#11-performance-optimizations)
12. [Constants Reference](#12-constants-reference)
13. [Build & Release](#13-build--release)

---

## 1. Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│                      main.ts (Plugin)                        │
│   Orchestrates lifecycle, commands, context menus, events    │
├─────────────┬──────────────┬─────────────┬──────────────────┤
│   Parser    │   Services   │     UI      │     Utils        │
├─────────────┼──────────────┼─────────────┼──────────────────┤
│ taskParser  │ vaultScanner │ BuJoView    │ dateUtils        │
│ headingCls  │ taskStore    │ Modals (5)  │ pathUtils        │
│ dateParser  │ taskWriter   │ Views  (6)  │                  │
│             │ migration    │ Components  │                  │
│             │ dailyNote    │   (13 files)│                  │
│             │ sprint       │             │                  │
│             │ analytics    │             │                  │
└─────────────┴──────────────┴─────────────┴──────────────────┘
```

**Total**: ~35 source files, ~4,400 lines of TypeScript + ~1,150 lines of CSS.

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
- **Class**: `TaskBuJoPlugin extends Plugin`
- **Responsibilities**: Bootstraps all services, registers commands/views/events, manages lifecycle
- **Key fields**: `data: PluginData`, `settings: PluginSettings`, 7 private service instances
- **Lifecycle**:
  - `onload()`: loads persisted data (deep-merges settings), instantiates all services, wires scanner→store pipeline, registers view/commands/ribbon/context menus, triggers `fullScan()` on layout ready, then checks migration & weekly review
  - `onunload()`: detaches views, destroys scanner

#### `src/types.ts` (~193 lines) — Type Definitions & Defaults
- **Enums**: `TaskStatus`, `ItemCategory`, `Priority`, `GroupMode`, `BuJoViewMode`
- **Interfaces**: `TaskItem`, `Sprint`, `TagCategory`, `PluginSettings`, `WeeklySnapshot`, `PluginData`
- **Type aliases**: `FolderState`, `StoreEventType`, `StoreEventCallback`
- **Constants**: `DEFAULT_WORK_TYPES`, `DEFAULT_PURPOSES`, `DEFAULT_SETTINGS`, `DEFAULT_PLUGIN_DATA`

#### `src/constants.ts` (~43 lines) — Regex & Tuning Constants
All regex patterns for parsing and timing constants for debouncing. See [§12](#12-constants-reference).

#### `src/settings.ts` (~439 lines) — Settings Tab UI
- **Class**: `TaskBuJoSettingTab extends PluginSettingTab`
- Interactive settings page with folder tree (recursive, collapsible, tri-state include/exclude/inherit cycle), dropdowns, toggles, and text inputs with debounced saves

### Parser Layer (`src/parser/`)

#### `taskParser.ts` (~169 lines) — Markdown → TaskItem[]
- **Function**: `parseTasksFromContent(content, sourcePath, classifier, workTypes?, purposes?)`
- Iterates lines tracking heading context (category, sub-headings). For each checkbox line extracts: status, priority, type tag, due date, migration annotation, work type, purpose
- **Helper**: `resolveTagCategory(value, categories)` — matches by name or shortCode (case-insensitive)

#### `headingClassifier.ts` (~34 lines) — Heading → Category Mapping
- **Class**: `HeadingClassifier`
- `classify(headingText, inlineTypeTag)` → `ItemCategory`
- Priority: inline `#type/` tag > heading substring match > Uncategorized

#### `dateParser.ts` (~46 lines) — Due Date String Parsing
- **Function**: `parseDueDate(raw: string): Date | null`
- Accepts `DD-MM-YYYY` (absolute) or `DD-MM` (resolves to nearest future occurrence)
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

#### `migrationService.ts` (~238 lines) — Daily Migration & Morning Review
- **Class**: `MigrationService`
- **Types**: `MigrationAction`, `MigrationDecision`, `MigrationResult`, `MorningReviewData`
- **Key methods**:
  - `needsMigration()`: true if `lastMigrationDate ≠ today` AND there are actionable tasks
  - `getMorningReviewData()`: buckets all open tasks into yesterdayTasks, overdueTasks, todayTasks, availableTasks, availableOpenPoints. Deduplicates across daily notes
  - `executeMigrations(decisions[])`: forward/reschedule/done/cancel
  - `deduplicateDailyTasks()`: groups by normalized text, keeps most recent daily note copy
  - `markMigrationDone()`: persists today's date

#### `dailyNoteService.ts` (~106 lines) — Daily Note CRUD
- **Class**: `DailyNoteService`
- **Methods**:
  - `getDailyNotePath(date)`: returns `{dailyNotePath}/{YYYY-MM-DD}.md`
  - `getOrCreateDailyNote(date)`: creates folders + file with template
  - `addTaskToDaily()`: inserts under `## Tasks`
  - `addMigratedTask()`: inserts under `## Migrated Tasks` (preserves multi-hop `migratedFrom`)
  - `addRawTaskLine()`: inserts raw line under `## Tasks`

#### `sprintService.ts` (~114 lines) — Sprint Lifecycle Management
- **Class**: `SprintService`
- CRUD for sprints, auto-creates next if `autoStartNextSprint` is enabled
- Sprint IDs: `sprint-{Date.now()}`

#### `analyticsService.ts` (~150 lines) — Weekly Analytics Engine
- **Class**: `AnalyticsService`
- **Cache**: `statsCache` keyed by `storeVersion + weekId`
- **Methods**: `getCurrentWeekStats()`, `getStatsForWeek(weekStart)`, `createSnapshot(stats)`, `computeStats()`

### UI Layer (`src/ui/`)

#### `TaskBuJoView.ts` (~244 lines) — Main Plugin View
- **Class**: `TaskBuJoView extends ItemView`
- View type: `task-bujo-view`, icon: `check-square`, display: "BuJo"
- **State**: `currentMode`, `currentGroupMode`, `searchQuery`, `collapsedGroups`, `lastStoreVersion`, `lastViewFingerprint`
- **Fingerprinting**: `refresh()` computes `"${mode}|${groupMode}|${searchQuery}|${storeVersion}"` — skips DOM rebuild if unchanged
- **Layout**: ViewSwitcher → Toolbar → Content (mode-specific) → AddTaskBar → Syntax Reference button
- **Tab reuse**: `onClickSource` iterates all leaves to find existing tab with the target file

#### `MigrationModal.ts` (~398 lines) — Morning Review Modal
- 3 sections: Yesterday's Incomplete (actionable), Overdue (actionable), Due Today (preview)
- Each actionable task: Forward / Reschedule / Done / Cancel buttons (default: Forward)
- Task/Open Point pickers with debounced search (max 50 visible)
- Quick-add form to create new tasks for today
- Timer leak prevention: `pickerSearchTimers[]` cleared in `onClose()`

#### `WeeklyReviewModal.ts` (~115 lines) — Weekly Review Modal
- Summary cards, work type/purpose breakdowns with progress bars
- Recent 4 weeks comparison from `weeklyHistory`
- "Save Snapshot & Close" persists to `PluginData`

#### `InsertTaskModal.ts` (~122 lines) — Insert Task Modal (Editor)
- Fields: text, priority, date picker, type tag, work type, purpose
- **Exported**: `buildTaskLine()` — constructs complete markdown checkbox line

#### `DueDateModal.ts` (~61 lines) — Due Date Picker Modal
- Date input with Set/Remove buttons, Enter key support
- Converts between ISO and plugin date format

#### `SprintModal.ts` (~120 lines) — Create/Edit Sprint Modal

#### `icons.ts` (~64 lines) — UI Helper Factory Functions
- `setTaskBuJoIcon()`, `createPriorityDot()`, `createDueBadge()`, `createSourceLink()`, `createStatusMarker()`
- Status display: `x→✓`, `>→→`, `<→←`, `-→—`

### UI Components (`src/ui/components/`)

| File | Lines | Purpose |
|------|-------|---------|
| `DailyView.ts` | ~92 | 4 sections: Overdue / Carried Over / Due Today / Unscheduled |
| `WeeklyView.ts` | ~86 | 7-day calendar (Mon–Sun) with per-day progress bars |
| `SprintView.ts` | ~112 | Active sprint header, progress bar, grouped tasks |
| `OpenPointsView.ts` | ~65 | Open points grouped by page + uncategorized section |
| `OverdueView.ts` | ~56 | Overdue tasks with configurable grouping |
| `AnalyticsView.ts` | ~147 | Summary cards, bar charts, 8-week trend table |
| `TaskList.ts` | ~49 | Renders `Map<string, TaskItem[]>` with `GroupHeader` + `TaskItemRow` |
| `TaskItemRow.ts` | ~77 | Checkbox + status marker + priority dot + text + due badge + source link |
| `Toolbar.ts` | ~87 | Search input (debounced) + group mode buttons |
| `ViewSwitcher.ts` | ~57 | 6-tab bar |
| `GroupHeader.ts` | ~69 | Collapsible header with chevron, label, count badge |
| `AddTaskBar.ts` | ~130 | Inline quick-add form (text + priority + date) |
| `SyntaxReference.ts` | ~82 | Modal with full syntax table, work types, purposes |

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
│    TaskBuJoView          │    Renders mode-specific view components
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
| `defaultViewMode` | `BuJoViewMode` | `Daily` | View shown on plugin open |
| `dailyNotePath` | `string` | `'BuJo/Daily'` | Folder for daily note files |
| `defaultSprintLength` | `number` | `14` | Sprint duration in days |
| `autoStartNextSprint` | `boolean` | `true` | Auto-create next sprint on completion |
| `migrationPromptOnStartup` | `boolean` | `true` | Show migration modal on startup |
| `taskHeadings` | `string[]` | `['Tasks', 'TODO', 'Action Items']` | Headings that classify items as Tasks |
| `openPointHeadings` | `string[]` | `['Open Points', 'Questions', 'Discussion Points']` | Headings for Open Points |
| `workTypes` | `TagCategory[]` | 6 defaults | Work type categories |
| `purposes` | `TagCategory[]` | 4 defaults | Purpose categories |
| `weekStartDay` | `number` | `1` (Monday) | First day of week (0=Sun…6=Sat) |

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
| `open-bujo` | BuJo: Open | callback | Opens/reveals the BuJo view |
| `open-bujo-new-tab` | BuJo: Open in New Tab | callback | Opens BuJo in a new tab |
| `run-daily-migration` | BuJo: Run Daily Migration | callback | Opens Morning Review modal |
| `weekly-review` | BuJo: Weekly Review | callback | Opens Weekly Review modal |
| `syntax-reference` | BuJo: Syntax Reference | callback | Opens syntax reference modal |
| `insert-task-with-details` | BuJo: Insert Task with Priority & Due Date | editorCallback | Opens InsertTaskModal, inserts at cursor |

### Ribbon & Context Menu

- **Ribbon icon**: `check-square` → opens BuJo view
- **Editor context menu** (always): "BuJo: Insert task here"
- **Editor context menu** (on checkbox lines): "Mark as done/open", "High/Medium/Low Priority", "Remove priority", "Set due date"

---

## 6. View Modes

| Mode | Enum | Description |
|------|------|-------------|
| **Daily** | `BuJoViewMode.Daily` | 4 sections: Overdue → Carried Over → Due Today → Unscheduled. Shows pending count header. |
| **Weekly** | `BuJoViewMode.Weekly` | 7-day calendar (Mon–Sun) with per-day task lists and progress bars (done/total %). |
| **Sprint** | `BuJoViewMode.Sprint` | Active sprint header (name, dates, days remaining), progress bar, grouped tasks. End/New sprint buttons. |
| **Open Points** | `BuJoViewMode.OpenPoints` | All Open Points grouped by page. Uncategorized items shown separately. |
| **Overdue** | `BuJoViewMode.Overdue` | Open tasks with past due dates. Supports all group modes. |
| **Analytics** | `BuJoViewMode.Analytics` | Summary cards, work type/purpose bar charts, 8-week trend table + chart. |

**Grouping** (Sprint & Overdue views only): By Page / By Priority / By Due Date

---

## 7. BuJo Markdown Syntax

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
| `#work/{name}` or `#w/{code}` | `#w/DW` | Work type tag |
| `#purpose/{name}` or `#p/{code}` | `#p/D` | Purpose tag |
| `(from [[PageName]])` | `(from [[2026-03-15]])` | Migration source (auto-generated) |

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
- **Manual**: via command `BuJo: Run Daily Migration`

### Morning Review Data Collection (`getMorningReviewData()`)

1. **Yesterday's tasks**: Open tasks from `{dailyNotePath}/{yesterday}.md`
2. **Overdue tasks**: Open tasks with past due dates (excluding yesterday's)
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

## 10. Two-Way Sync

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

## 11. Performance Optimizations

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

## 12. Constants Reference

| Constant | Value | Usage |
|----------|-------|-------|
| `VIEW_TYPE_TASK_BUJO` | `'task-bujo-view'` | View registration identifier |
| `CHECKBOX_REGEX` | `/^(\s*)-\s*\[([ x><!-])\]\s+(.*)$/i` | Matches checkbox lines |
| `HEADING_REGEX` | `/^(#{1,6})\s+(.+)$/` | Matches markdown headings |
| `PRIORITY_TAG_REGEX` | `/#priority\/(high\|medium\|low)/i` | Priority tags |
| `TYPE_TAG_REGEX` | `/#type\/(task\|openpoint)/i` | Category type tags |
| `DUE_DATE_REGEX` | `/@due\s+(\d{1,2}-\d{1,2}(?:-\d{4})?)/i` | Due date annotations |
| `MIGRATED_FROM_REGEX` | `/\s*\(from\s+\[\[([^\]]+)\]\]\)\s*/` | Migration source links |
| `WORK_TYPE_REGEX` | `/#(?:work\|w)\/(\S+)/i` | Work type tags |
| `PURPOSE_REGEX` | `/#(?:purpose\|p)\/(\S+)/i` | Purpose tags |
| `SCAN_DEBOUNCE_MS` | `300` | File change debounce |
| `SEARCH_DEBOUNCE_MS` | `200` | Search input debounce |
| `REFRESH_DEBOUNCE_MS` | `100` | UI refresh coalescing |
| `SETTINGS_DEBOUNCE_MS` | `500` | Settings input debounce |
| `SYNC_CLEAR_DELAY_MS` | `500` | Sync flag clear delay |
| `SCAN_BATCH_SIZE` | `50` | Parallel file read batch size |

---

## 13. Build & Release

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
`styles.css` (~1,150 lines) uses Obsidian CSS variables (`var(--text-muted)`, `var(--background-modifier-border)`, etc.) for full theme compatibility. All components are styled with `.task-bujo-*` class prefix.

---

## Key Design Decisions

1. **No external dependencies** — pure Obsidian API + TypeScript
2. **Markdown-native** — all data lives in standard markdown files, no proprietary database
3. **Non-destructive** — plugin reads/writes standard checkbox syntax; removing the plugin leaves valid markdown
4. **Event-driven** — vault events → scanner → store → view, with debouncing at every boundary
5. **Single write point** — all markdown modifications go through `TaskWriter` to prevent conflicts
6. **BuJo-inspired** — migration, daily/weekly review, work categorization follow Bullet Journal methodology
7. **Theme-responsive** — all colors/spacing use Obsidian CSS variables
