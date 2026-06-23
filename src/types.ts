/** Status characters used in markdown checkboxes: - [x], - [ ], - [>], etc. */
export enum TaskStatus {
	Open = ' ',
	Done = 'x',
	Migrated = '>',
	Scheduled = '<',
	Cancelled = '-',
}

/** Classification of a checkbox item based on heading context or inline tag. */
export enum ItemCategory {
	Task = 'task',
	OpenPoint = 'openpoint',
	Inbox = 'inbox',
	Uncategorized = 'uncategorized',
}

export enum Priority {
	High = 'high',
	Medium = 'medium',
	Low = 'low',
	None = 'none',
}

export enum GroupMode {
	ByPage = 'byPage',
	ByPriority = 'byPriority',
	ByDueDate = 'byDueDate',
}

export enum FridayViewMode {
	Daily = 'daily',
	Weekly = 'weekly',
	Monthly = 'monthly',
	Calendar = 'calendar',
	Topics = 'topics',
	Overview = 'overview',
	Overdue = 'overdue',
	Inbox = 'inbox',
	Unscheduled = 'unscheduled',
	Analytics = 'analytics',
}

// ─── Team management types ─────────────────────────────────────────
/** Person-page lifecycle state. Drives visibility on the overview and the
 *  cadence-overdue signal. `on_leave` suspends the 1:1 cadence; `departed`
 *  hides the person entirely but preserves the folder for history. */
export type TeamMemberStatus = 'active' | 'on_leave' | 'departed';

/** How often a 1:1 should happen. `skip` disables the cadence entirely. */
export type OneOnOneCadence = 'weekly' | 'biweekly' | 'monthly' | 'skip';

/** A person page parsed from {teamFolderPath}/{Name}/{Name}.md. `lastOneOnOne`
 *  is derived from `1on1/*.md` filenames, not stored in frontmatter. */
export interface TeamMemberPage {
	/** Canonical .md file path */
	filePath: string;
	/** Containing folder (the person's folder) */
	folderPath: string;
	/** Display name (folder basename) */
	name: string;
	status: TeamMemberStatus;
	role: string | null;
	email: string | null;
	/** Date parsed from frontmatter `start_date` (YYYY-MM-DD). */
	startDate: Date | null;
	cadence: OneOnOneCadence;
	/** JIRA identity (usually email). Used to cross-link to the JIRA Team tab. */
	jiraIdentity: string | null;
	/** Max ISO date across child `1on1/*.md` filenames. Null when no sessions yet. */
	lastOneOnOne: Date | null;
	/** Paths of session files belonging to this person (under `1on1/`). */
	sessionPaths: string[];
	/** First non-empty line under `## Current Focus` in the page body. Null when absent. */
	currentFocus: string | null;
}

/** A 1:1 session file at {memberFolder}/1on1/YYYY-MM-DD.md. The scanner stores
 *  only the path + derived date — the body is not parsed. */
export interface OneOnOneSession {
	filePath: string;
	/** The parent person folder (everything before `/1on1/`). */
	memberFolderPath: string;
	/** Date parsed from the filename, or null if filename isn't YYYY-MM-DD. */
	sessionDate: Date | null;
}

export interface TaskItem {
	/** Unique ID: `${sourcePath}:${lineNumber}` */
	id: string;
	/** Display text (with priority/due/type tags stripped) */
	text: string;
	/** Raw markdown line for write-back */
	rawLine: string;
	status: TaskStatus;
	category: ItemCategory;
	priority: Priority;
	/** Parsed due date, or null if none */
	dueDate: Date | null;
	/** Raw due date string as written in the file (for write-back) */
	dueDateRaw: string | null;
	/** Vault-relative path to the source file */
	sourcePath: string;
	/** 0-based line number in the source file */
	lineNumber: number;
	/** The category-defining heading this item falls under (e.g. "Tasks") */
	headingContext: string | null;
	/** The immediate sub-heading under the category heading (e.g. "Backend" under "## Tasks > ### Backend") */
	subHeading: string | null;
	/** Path of the file this task was migrated to (if migrated) */
	migratedTo: string | null;
	/** Original source if this task was migrated from another file */
	migratedFrom: string | null;
	/** Work type classification (e.g. "Deep Work", "Review") */
	workType: string | null;
	/** Purpose classification (e.g. "Delivery", "Capability") */
	purpose: string | null;
	/** Indentation level: 0 = root, 1 = one tab/indent, etc. */
	indentLevel: number;
	/** ID of the parent task, or null if root-level */
	parentId: string | null;
	/** IDs of direct children tasks */
	childrenIds: string[];
	/** Multi-line description text from indented non-checkbox lines below the task */
	description: string | null;
}

/** Kanban column a topic sits in. 'open' renders as "To Do" in the UI;
 *  'backlog' is uncommitted work (replaces the old "no sprint" bucket). */
export type TopicStatus = 'backlog' | 'open' | 'in-progress' | 'done';

/** Strategic impact level for a topic (used in Impact/Effort and Eisenhower matrices) */
export type TopicImpact = 'critical' | 'high' | 'medium' | 'low';

/** Size estimate for a topic (used in Impact/Effort matrix) */
export type TopicEffort = 'xs' | 's' | 'm' | 'l' | 'xl';

/** A Sprint Topic stored as a markdown file with YAML frontmatter */
export interface SprintTopic {
	/** Vault-relative path to the topic .md file */
	filePath: string;
	/** Display title (from the H1 heading) */
	title: string;
	status: TopicStatus;
	/** JIRA issue keys linked to this topic. Empty array = no link.
	 *  Multi-key topics write `jira: PROJ-1, PROJ-2` in frontmatter;
	 *  legacy single-key `jira: PROJ-1` parses to `['PROJ-1']` transparently. */
	jira: string[];
	priority: Priority;
	blocked: boolean;
	/** Manual sort order within its column (lower = higher position) */
	sortOrder: number;
	/** Wiki-links extracted from ## Linked Pages section */
	linkedPages: string[];
	/** Total checkbox count from ## Tasks section */
	taskTotal: number;
	/** Done checkbox count from ## Tasks section */
	taskDone: number;
	/** Strategic impact (for Impact/Effort and Eisenhower matrices). Null when not set. */
	impact: TopicImpact | null;
	/** Size estimate (for Impact/Effort matrix). Null when not set. */
	effort: TopicEffort | null;
	/** Due date (ISO YYYY-MM-DD) used for Eisenhower urgency. Null when not set. */
	dueDate: string | null;
	/** ISO YYYY-MM-DD the topic entered its current status (aging-WIP signal). Null on legacy topics. */
	statusSince: string | null;
	/** ISO YYYY-MM-DD the topic first entered 'in-progress' (cycle-time start). Never overwritten. Null if never started. */
	startedAt: string | null;
	/** ISO YYYY-MM-DD the topic entered 'done' (cycle-time end / throughput source). Cleared if reopened. Null if not done. */
	doneAt: string | null;
	/** Email of the assigned team member (matches `TeamMember.email`). Null when unassigned. */
	assignee: string | null;
	/** Who we're waiting on. Either a team member email (resolves via settings.teamMembers)
	 *  or free text (e.g. "Legal", "Vendor X"). Null when not waiting on anyone. */
	waitingOn: string | null;
	/** ISO YYYY-MM-DD of the last nudge/follow-up. Null when never nudged or not waiting. */
	lastNudged: string | null;
	/** External reference links (Confluence pages, Figma files, SAP transactions, etc.).
	 *  Empty array when none. Stored in frontmatter as a folded scalar of `label | url`
	 *  lines. Distinct from `jira` (issue keys) and `linkedPages` (Obsidian wiki-links). */
	refs: Array<{ label: string; url: string }>;
	/** File paths of topics that block this one (this topic is blocked-by them). The inverse
	 *  ("blocks") is derived at read time, never stored. Persisted as a folded-scalar
	 *  (newline-separated) frontmatter value so paths can safely contain commas. */
	blockedBy: string[];
}

/** Three-state folder scanning state */
export type FolderState = 'include' | 'exclude' | 'inherit';

/** A configurable tag category with display name and short code */
export interface TagCategory {
	name: string;
	shortCode: string;
}

export interface PluginSettings {
	/** Per-folder scanning state. Keys are vault-relative folder paths. 
	 *  Missing folders default to 'include'. */
	folderStates: Record<string, FolderState>;
	/** Whether to show completed (done) tasks in views */
	showCompletedTasks: boolean;
	/** Default grouping mode for task views */
	defaultGroupMode: GroupMode;
	/** Default view mode on plugin open */
	defaultViewMode: FridayViewMode;
	/** Folder path for daily log notes */
	dailyNotePath: string;
	/** Show migration prompt on startup if there are pending migrations */
	migrationPromptOnStartup: boolean;
	/** Heading names that classify items as Tasks (case-insensitive) */
	taskHeadings: string[];
	/** Heading names that classify items as Open Points (case-insensitive) */
	openPointHeadings: string[];
	/** Heading names that classify items as Inbox (case-insensitive).
	 *  Inbox items are the "drop zone" for quick-capture stuff that needs triage later. */
	inboxHeadings: string[];
	/** Where AddTaskBar writes quick-added tasks by default: under `## Tasks` or `## Inbox`. */
	defaultQuickAddTarget: 'tasks' | 'inbox';
	/** Configurable work type categories */
	workTypes: TagCategory[];
	/** Configurable purpose categories */
	purposes: TagCategory[];
	/** Week start day: 0=Sunday, 1=Monday, ... 6=Saturday */
	weekStartDay: number;
	/** Folder path for monthly log notes */
	monthlyNotePath: string;
	/** Folder path for topic files (the Kanban board reads/writes here). */
	sprintTopicsPath: string;
	/** Folder path for archived completed tasks */
	archiveFolderPath: string;
	/** How archived tasks are grouped into files */
	archiveGroupBy: 'month' | 'source';
	/** Number of days before due date to consider a task "urgent" in Eisenhower view */
	urgencyThresholdDays: number;
	/** Number of days after `lastNudged` before a waiting-on topic is shown in the
	 *  morning migration modal as "stale". Default 7. */
	nudgeThresholdDays: number;
	/** Per-column WIP (work-in-progress) limits for the Kanban board. null = no limit.
	 *  The board warns (does not block) when a column exceeds its limit. */
	wipLimits: Record<TopicStatus, number | null>;
	/** Days a non-done topic can sit in its current column before it's flagged as aging
	 *  work-in-progress in the Flow analytics. Default 7. */
	agingWipThresholdDays: number;
	/** Folder path for team member person pages. Each person lives in its own subfolder:
	 *  `{teamFolderPath}/Alice Smith/Alice Smith.md`, with 1:1s under `1on1/YYYY-MM-DD.md`. */
	teamFolderPath: string;
	/** Default target concurrent items per member (when not set per-member). Drives the
	 *  workload "committed vs. capacity" band on the Team Dashboard. Default 5. */
	defaultTargetConcurrentItems: number;

	// ─── JIRA Integration Module ──────────────────────────────────
	// All JIRA-related behavior is gated by jiraEnabled. When false,
	// nothing is fetched and no JIRA UI appears on cards.

	/** Master switch for the JIRA integration module */
	jiraEnabled: boolean;
	/** JIRA Cloud base URL, e.g. https://mycompany.atlassian.net (no trailing slash) */
	jiraBaseUrl: string;
	/** Atlassian account email (used as the username half of Basic auth) */
	jiraEmail: string;
	/** Personal API token — stored in plugin data.json, as sensitive as the rest of the vault */
	jiraApiToken: string;
	/** Minutes to cache fetched issue data before re-hitting the API */
	jiraCacheTtlMinutes: number;
	/** Project keys (e.g. ["PROJ", "DEV"]) the JIRA Dashboard scopes its search to.
	 *  Empty array = no project filter (all projects the user can see). */
	jiraDashboardProjects: string[];
	/** Minutes to cache the JIRA Dashboard JQL result. Auto-refresh fires when the view
	 *  is visible AND the cache is older than this. Separate from single-issue TTL. */
	jiraDashboardTtlMinutes: number;
	/** Atlassian Cloud JIRA custom field ID for the Sprint field (usually "customfield_10020").
	 *  Varies per instance \u2014 users can override if their JIRA uses a different field. */
	jiraSprintFieldId: string;
	/** Atlassian Cloud custom field ID for the Flagged (impediment) field. Usually
	 *  "customfield_10021". Used to derive topic blocking from linked JIRA issues. */
	jiraFlaggedFieldId: string;
	/** Sticky collapsed state for dashboard sections. Keys are section IDs, value = collapsed. */
	jiraDashboardCollapsedSections: Record<string, boolean>;

	// ─── Team tracking (lead-analyst mode) ────────────────────────
	// Configured list of team members. Email is the identity key used in team-scoped
	// JQL (`assignee in (...)`). When jiraTeamEnabled is true AND at least one active
	// member is configured, the JIRA Dashboard renders a workload heatmap and one
	// collapsible section per person below the personal sections.

	/** Master switch for the team block on the JIRA Dashboard. Off by default. */
	jiraTeamEnabled: boolean;
	/** List of team members. Order is not meaningful — the dashboard sorts by workload. */
	teamMembers: TeamMember[];
	/** Which JIRA Dashboard tab is active. Sticky so a relaunch lands back on the
	 *  last-used view. 'team' is silently coerced to 'mine' when team tracking is off. */
	jiraDashboardActiveTab: 'mine' | 'team';

	// ─── MCP Server ──────────────────────────────────────────────
	// Embedded HTTP MCP server that exposes a subset of plugin operations
	// (tasks, sprints, topics) to MCP-aware clients like Claude Desktop / Claude Code.
	// Off by default — opt-in. Desktop-only; no-ops on mobile.

	/** Master switch for the embedded MCP server */
	mcpEnabled: boolean;
	/** Bind address (default 127.0.0.1). Change only if you need LAN access. */
	mcpHost: string;
	/** TCP port for the MCP server. Default 27225 (avoids 27124 used by Local REST API). */
	mcpPort: number;
	/** Bearer token required on every MCP request. Generated on first enable. */
	mcpToken: string;
}

/** A configured team member. Email is the JIRA identity (used in `assignee = "email"`
 *  JQL clauses). Nickname is a short display label used in UI chips and bar segments. */
export interface TeamMember {
	/** Full display name, e.g. "Tomáš Nováček" */
	fullName: string;
	/** Short label shown in heatmap bars and section headers, e.g. "Tom" */
	nickname: string;
	/** Atlassian account email — used as the JIRA identity key */
	email: string;
	/** Tombstone flag. When false the member is hidden from dashboard but preserved
	 *  in the list (so historical tickets still match if we ever join back on email). */
	active: boolean;
	/** Target number of concurrent (To Do + In Progress) items before the member reads as
	 *  over capacity. Falls back to `defaultTargetConcurrentItems` when unset. */
	targetConcurrentItems?: number;
	/** Availability percent (0–100) for part-time / OOO. Scales the effective target. Default 100. */
	availabilityPercent?: number;
}

/** A richer JIRA issue shape fetched by JiraDashboardService. Carries the fields
 *  needed for dashboard row rendering. Never written to disk. */
export interface JiraDashboardIssue {
	key: string;
	summary: string;
	status: string;
	statusCategory: 'new' | 'indeterminate' | 'done' | 'unknown';
	issueType: string;
	/** URL for the issue's type icon, served by JIRA. May be null if not provided. */
	issueTypeIconUrl: string | null;
	priority: string | null;
	/** Priority icon URL from JIRA, if present. */
	priorityIconUrl: string | null;
	assignee: string | null;
	/** Assignee's email address from JIRA, when the tenant exposes it. Used to bucket
	 *  issues into per-team-member sections by matching against `TeamMember.email`.
	 *  Many Cloud instances hide this by default (GDPR) — fall back to accountId. */
	assigneeEmail: string | null;
	/** Atlassian account ID for the assignee. Always present when there's an assignee
	 *  (even when emailAddress is hidden). Future JQL upgrades can target this directly. */
	assigneeAccountId: string | null;
	reporter: string | null;
	/** ISO YYYY-MM-DD, or null if unset. */
	dueDate: string | null;
	/** Resolution date (ISO) — used to hide stale done items. Null if unresolved. */
	resolutionDate: string | null;
	/** ISO timestamp of last update. */
	updatedAt: string;
	labels: string[];
	/** Parent epic/issue key + summary, if any. */
	parentKey: string | null;
	parentSummary: string | null;
	/** Active sprint name (current), if the issue is in one. */
	sprintName: string | null;
	/** True if any sprint on this issue is currently active. */
	sprintActive: boolean;
	/** Seconds spent, null if none tracked. */
	timeSpentSeconds: number | null;
	/** Remaining estimate in seconds, null if not tracked. */
	timeRemainingSeconds: number | null;
	/** True if JIRA's Flagged field (impediment) is set. */
	flagged: boolean;
	issueUrl: string;
}

/** Snapshot of a JIRA issue's live data, cached in-memory by JiraService.
 *  Never written to disk — fetched on demand and refreshed per the cache TTL. */
export interface JiraIssueInfo {
	/** The issue key (e.g. "PROJ-123") */
	key: string;
	/** Short summary/title from JIRA */
	summary: string;
	/** Human-readable status name (e.g. "In Progress") */
	status: string;
	/** Atlassian's coarse categorization of the status — drives color coding */
	statusCategory: 'new' | 'indeterminate' | 'done' | 'unknown';
	/** Assignee display name, or null if unassigned */
	assignee: string | null;
	/** True if JIRA's Flagged (impediment) field is set on this issue. */
	flagged: boolean;
	/** Inward "is blocked by" issue links — the issues blocking this one, with done state. */
	blockingLinks: Array<{ key: string; done: boolean }>;
	/** Browser URL for the issue, derived from base URL */
	issueUrl: string;
	/** Unix ms when this info was fetched — used for TTL checks */
	fetchedAt: number;
}

export const DEFAULT_WORK_TYPES: TagCategory[] = [
	{ name: 'Deep Work', shortCode: 'DW' },
	{ name: 'Review', shortCode: 'RV' },
	{ name: 'Coordination', shortCode: 'CO' },
	{ name: 'Admin', shortCode: 'AD' },
	{ name: 'Learning', shortCode: 'LN' },
	{ name: 'Leadership', shortCode: 'LD' },
];

export const DEFAULT_PURPOSES: TagCategory[] = [
	{ name: 'Delivery', shortCode: 'D' },
	{ name: 'Capability', shortCode: 'CA' },
	{ name: 'Strategy', shortCode: 'ST' },
	{ name: 'Support', shortCode: 'SU' },
];

export const DEFAULT_SETTINGS: PluginSettings = {
	folderStates: {},
	showCompletedTasks: true,
	defaultGroupMode: GroupMode.ByPage,
	defaultViewMode: FridayViewMode.Topics,
	dailyNotePath: 'BuJo/Daily',
	migrationPromptOnStartup: true,
	taskHeadings: ['Tasks', 'TODO', 'Action Items'],
	openPointHeadings: ['Open Points', 'Questions', 'Discussion Points'],
	inboxHeadings: ['Inbox', 'Triage'],
	defaultQuickAddTarget: 'tasks',
	workTypes: DEFAULT_WORK_TYPES,
	purposes: DEFAULT_PURPOSES,
	weekStartDay: 1,
	monthlyNotePath: 'BuJo/Monthly',
	sprintTopicsPath: 'BuJo/Sprints/Topics',
	archiveFolderPath: 'BuJo/Archive',
	archiveGroupBy: 'month',
	urgencyThresholdDays: 2,
	nudgeThresholdDays: 7,
	wipLimits: { backlog: null, open: null, 'in-progress': 5, done: null },
	agingWipThresholdDays: 7,
	teamFolderPath: 'BuJo/Team',
	defaultTargetConcurrentItems: 5,
	// JIRA module defaults — OFF until explicitly configured
	jiraEnabled: false,
	jiraBaseUrl: '',
	jiraEmail: '',
	jiraApiToken: '',
	jiraCacheTtlMinutes: 10,
	jiraDashboardProjects: [],
	jiraDashboardTtlMinutes: 10,
	jiraSprintFieldId: 'customfield_10020',
	jiraFlaggedFieldId: 'customfield_10021',
	jiraDashboardCollapsedSections: {},
	// Team tracking defaults — OFF until you add members + toggle on
	jiraTeamEnabled: false,
	teamMembers: [],
	jiraDashboardActiveTab: 'mine',
	// MCP server — OFF until explicitly enabled in settings
	mcpEnabled: false,
	mcpHost: '127.0.0.1',
	mcpPort: 27225,
	mcpToken: '',
};

/** Snapshot of weekly analytics for historical tracking */
export interface WeeklySnapshot {
	/** Week identifier in WW-YYYY format (e.g. "12-2026") */
	weekId: string;
	/** ISO date of the week start */
	weekStart: string;
	/** Total tasks planned for the week */
	totalPlanned: number;
	/** Tasks completed */
	totalCompleted: number;
	/** Tasks migrated (carried forward) */
	totalMigrated: number;
	/** Tasks cancelled */
	totalCancelled: number;
	/** Breakdown by work type: { "Deep Work": { planned: 5, completed: 3 }, ... } */
	workTypeBreakdown: Record<string, { planned: number; completed: number }>;
	/** Breakdown by purpose */
	purposeBreakdown: Record<string, { planned: number; completed: number }>;
	/** Timestamp when snapshot was saved */
	savedAt: string;
}

/** Snapshot of monthly analytics for historical tracking */
export interface MonthlySnapshot {
	/** Month identifier in YYYY-MM format (e.g. "2026-03") */
	monthId: string;
	/** Total tasks planned for the month */
	totalPlanned: number;
	/** Tasks completed */
	totalCompleted: number;
	/** Tasks migrated (carried forward) */
	totalMigrated: number;
	/** Tasks cancelled */
	totalCancelled: number;
	/** Completion rate percentage */
	completionRate: number;
	/** Free-form reflections text */
	reflections: string;
	/** Timestamp when snapshot was saved */
	savedAt: string;
}

/** Per-member work counts for the team roll-up + workload snapshots. */
export interface WorkloadCounts {
	jiraBlocked: number;
	jiraInProgress: number;
	jiraOpen: number;
	jiraDone: number;
	topicsBlocked: number;
	topicsInProgress: number;
	topicsOpen: number;
	topicsDone: number;
}

/** Committed-vs-capacity signal for one member. `out` = availability 0 (on leave/OOO). */
export interface LoadSignal {
	committed: number;
	target: number;
	ratio: number | null;
	band: 'light' | 'balanced' | 'heavy' | 'overloaded' | 'out';
}

export interface MemberRollup {
	email: string;
	displayName: string;
	onLeave: boolean;
	cadenceState: string | null;
	cadenceDays: number | null;
	drivingJira: JiraDashboardIssue[];
	drivingTopics: SprintTopic[];
	/** All JIRA issues bucketed to this member (powers drill-down + 1:1 agenda). */
	jiraIssues: JiraDashboardIssue[];
	/** All topics assigned to this member, any status. */
	topics: SprintTopic[];
	counts: WorkloadCounts;
	load: LoadSignal;
}

export interface BlockerEntry {
	kind: 'jira' | 'topic-blocked' | 'topic-waiting';
	ownerName: string | null;
	title: string;
	ref: string;
	url: string | null;
	detail: string | null;
}

export interface RiskEntry {
	kind: 'jira' | 'topic';
	ownerName: string | null;
	title: string;
	ref: string;
	url: string | null;
	dueDate: string;
	daysUntilDue: number;
}

export interface OverdueOneOnOneEntry {
	name: string;
	daysOverdue: number;
}

/** Full team status roll-up — combines JIRA team issues, assigned topics, and 1:1 cadence. */
export interface TeamRollup {
	generatedAt: number;
	jiraIncluded: boolean;
	members: MemberRollup[];
	topBlockers: BlockerEntry[];
	atRisk: RiskEntry[];
	overdueOneOnOnes: OverdueOneOnOneEntry[];
}

/** A point-in-time workload snapshot for trending. Keyed by ISO week. */
export interface WorkloadSnapshot {
	weekId: string;
	capturedAt: string;
	jiraIncluded: boolean;
	members: Record<string, { displayName: string; committed: number; blocked: number; inProgress: number; open: number; done: number }>;
	totals: { committed: number; blocked: number; inProgress: number; open: number; done: number };
}

export interface PluginData {
	settings: PluginSettings;
	/** True once the one-time sprint→Kanban migration has run. */
	kanbanMigrationDone: boolean;
	lastMigrationDate: string | null; // ISO date YYYY-MM-DD
	/** Historical weekly analytics snapshots */
	weeklyHistory: WeeklySnapshot[];
	/** Last week that was reviewed (WW-YYYY), prevents re-prompting */
	lastWeeklyReviewWeek: string | null;
	/** Historical monthly analytics snapshots */
	monthlyHistory: MonthlySnapshot[];
	/** Point-in-time team workload snapshots for trending (most recent last). */
	workloadHistory: WorkloadSnapshot[];
	/** Last ISO week a workload snapshot was captured (prevents duplicate weekly auto-captures). */
	lastWorkloadSnapshotWeek: string | null;
}

export const DEFAULT_PLUGIN_DATA: PluginData = {
	settings: DEFAULT_SETTINGS,
	kanbanMigrationDone: false,
	lastMigrationDate: null,
	weeklyHistory: [],
	lastWeeklyReviewWeek: null,
	monthlyHistory: [],
	workloadHistory: [],
	lastWorkloadSnapshotWeek: null,
};

/** Event types emitted by the task store */
export type StoreEventType = 'tasks-updated' | 'sprint-updated';
export type StoreEventCallback = (type: StoreEventType) => void;
