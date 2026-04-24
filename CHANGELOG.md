# Changelog

All notable changes to the BuJo Obsidian plugin are tracked here.

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
