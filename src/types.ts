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
	Goal = 'goal',
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

export enum BuJoViewMode {
	Daily = 'daily',
	Weekly = 'weekly',
	Monthly = 'monthly',
	Sprint = 'sprint',
	Overview = 'overview',
	Overdue = 'overdue',
	Analytics = 'analytics',
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
}

export interface Sprint {
	id: string;
	name: string;
	startDate: string; // ISO date string YYYY-MM-DD
	endDate: string;   // ISO date string YYYY-MM-DD
	status: 'active' | 'completed' | 'planned';
}

/** Status of a sprint topic on the Kanban board */
export type TopicStatus = 'open' | 'in-progress' | 'done';

/** Action taken on a topic when closing a sprint */
export type SprintCloseAction = 'carry-forward' | 'archive' | 'cancel';

/** A Sprint Topic stored as a markdown file with YAML frontmatter */
export interface SprintTopic {
	/** Vault-relative path to the topic .md file */
	filePath: string;
	/** Display title (from the H1 heading) */
	title: string;
	status: TopicStatus;
	jira: string | null;
	priority: Priority;
	blocked: boolean;
	/** Sprint ID this topic is linked to */
	sprintId: string | null;
	/** Manual sort order within its column (lower = higher position) */
	sortOrder: number;
	/** Wiki-links extracted from ## Linked Pages section */
	linkedPages: string[];
	/** Total checkbox count from ## Tasks section */
	taskTotal: number;
	/** Done checkbox count from ## Tasks section */
	taskDone: number;
}

/** Decision for a single topic when closing a sprint */
export interface SprintCloseDecision {
	topic: SprintTopic;
	action: SprintCloseAction;
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
	defaultViewMode: BuJoViewMode;
	/** Folder path for daily log notes */
	dailyNotePath: string;
	/** Default sprint length in days */
	defaultSprintLength: number;
	/** Auto-create next sprint when current one ends */
	autoStartNextSprint: boolean;
	/** Show migration prompt on startup if there are pending migrations */
	migrationPromptOnStartup: boolean;
	/** Heading names that classify items as Tasks (case-insensitive) */
	taskHeadings: string[];
	/** Heading names that classify items as Open Points (case-insensitive) */
	openPointHeadings: string[];
	/** Configurable work type categories */
	workTypes: TagCategory[];
	/** Configurable purpose categories */
	purposes: TagCategory[];
	/** Week start day: 0=Sunday, 1=Monday, ... 6=Saturday */
	weekStartDay: number;
	/** Folder path for monthly log notes */
	monthlyNotePath: string;
	/** Show monthly migration prompt on startup at month boundaries */
	monthlyMigrationPromptOnStartup: boolean;
	/** Heading names that classify items as Goals (case-insensitive) */
	goalHeadings: string[];
	/** Folder path for sprint topic files */
	sprintTopicsPath: string;
	/** Only count work days (Mon-Fri) for sprint duration and remaining days */
	sprintWorkDaysOnly: boolean;
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
	defaultViewMode: BuJoViewMode.Daily,
	dailyNotePath: 'BuJo/Daily',
	defaultSprintLength: 14,
	autoStartNextSprint: true,
	migrationPromptOnStartup: true,
	taskHeadings: ['Tasks', 'TODO', 'Action Items'],
	openPointHeadings: ['Open Points', 'Questions', 'Discussion Points'],
	workTypes: DEFAULT_WORK_TYPES,
	purposes: DEFAULT_PURPOSES,
	weekStartDay: 1,
	monthlyNotePath: 'BuJo/Monthly',
	monthlyMigrationPromptOnStartup: true,
	goalHeadings: ['Goals'],
	sprintTopicsPath: 'BuJo/Sprints/Topics',
	sprintWorkDaysOnly: false,
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
	/** Total goals for the month */
	goalsTotal: number;
	/** Goals completed */
	goalsCompleted: number;
	/** Completion rate percentage */
	completionRate: number;
	/** Free-form reflections text */
	reflections: string;
	/** Timestamp when snapshot was saved */
	savedAt: string;
}

export interface PluginData {
	settings: PluginSettings;
	sprints: Sprint[];
	lastMigrationDate: string | null; // ISO date YYYY-MM-DD
	/** Historical weekly analytics snapshots */
	weeklyHistory: WeeklySnapshot[];
	/** Last week that was reviewed (WW-YYYY), prevents re-prompting */
	lastWeeklyReviewWeek: string | null;
	/** Last month that monthly migration was run (YYYY-MM), prevents re-prompting */
	lastMonthlyMigrationMonth: string | null;
	/** Historical monthly analytics snapshots */
	monthlyHistory: MonthlySnapshot[];
}

export const DEFAULT_PLUGIN_DATA: PluginData = {
	settings: DEFAULT_SETTINGS,
	sprints: [],
	lastMigrationDate: null,
	weeklyHistory: [],
	lastWeeklyReviewWeek: null,
	lastMonthlyMigrationMonth: null,
	monthlyHistory: [],
};

/** Event types emitted by the task store */
export type StoreEventType = 'tasks-updated' | 'sprint-updated';
export type StoreEventCallback = (type: StoreEventType) => void;
