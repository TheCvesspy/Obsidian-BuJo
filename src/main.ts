import { Plugin, WorkspaceLeaf, Editor, MarkdownView, Menu, Notice, Platform, TFile } from 'obsidian';
import { PluginData, DEFAULT_PLUGIN_DATA, PluginSettings, TaskStatus, WeeklySnapshot, MonthlySnapshot, FridayViewMode, TopicStatus, WorkloadSnapshot, SprintTopic } from './types';
import { VIEW_TYPE_FRIDAY, VIEW_TYPE_JIRA_DASHBOARD, VIEW_TYPE_TEAM_DASHBOARD, PRIORITY_TAG_REGEX, DUE_DATE_REGEX, SNOOZE_DATE_REGEX, SOMEDAY_TAG_REGEX } from './constants';
import { FridaySettingTab } from './settings';
import { VaultScanner } from './services/vaultScanner';
import { TaskStore } from './services/taskStore';
import { TaskWriter } from './services/taskWriter';
import { DailyNoteService } from './services/dailyNoteService';
import { TasksInboxService } from './services/tasksInboxService';
import { SprintTopicService } from './services/sprintTopicService';
import { MorningReviewService } from './services/morningReviewService';
import { AnalyticsService, WeeklyStats } from './services/analyticsService';
import { MonthlyNoteService } from './services/monthlyNoteService';
import { MonthlyAnalyticsService } from './services/monthlyAnalyticsService';
import { ArchiveService } from './services/archiveService';
import { JiraService } from './services/jiraService';
import { createTopicFromJiraInfo, syncTopicDependenciesFromJira } from './services/topicFromJira';
import { JiraDashboardService } from './services/jiraDashboardService';
import { JiraTeamService } from './services/jiraTeamService';
import { TeamMemberService } from './services/teamMemberService';
import { TeamRollupService, buildOneOnOneAgenda } from './services/teamRollupService';
import { TeamDigestService } from './services/teamDigestService';
import { FridayView } from './ui/FridayView';
import { TopicsSubMode } from './ui/components/TopicsOverviewView';
import { JiraDashboardView } from './ui/JiraDashboardView';
import { TeamDashboardView } from './ui/TeamDashboardView';
import { MorningReviewModal } from './ui/MorningReviewModal';
import { OneOnOneModal } from './ui/OneOnOneModal';
import { WeeklyReviewModal } from './ui/WeeklyReviewModal';
import { MonthlyReviewModal } from './ui/MonthlyReviewModal';
import { InsertTaskModal, buildTaskLine, buildTaskBlock } from './ui/InsertTaskModal';
import { QuickCaptureModal } from './ui/QuickCaptureModal';
import { DueDateModal } from './ui/DueDateModal';
import { SyntaxReferenceModal } from './ui/components/SyntaxReference';
import { SprintTopicModal } from './ui/SprintTopicModal';
import { JiraKeyPromptModal } from './ui/JiraKeyPromptModal';
import { TopicSwitcherModal } from './ui/TopicSwitcherModal';
import { pickFromList } from './ui/pickers';
import { getWeekId, getWeekStartConfigurable, isoToPluginDate, pluginDateToIso } from './utils/dateUtils';
import { McpServer, generateMcpToken, noticeForError } from './mcp/server';
import { taskTools } from './mcp/tools/tasks';
import { topicTools } from './mcp/tools/topics';
import { teamTools } from './mcp/tools/team';

export default class FridayPlugin extends Plugin {
	data: PluginData;
	settings: PluginSettings;

	private scanner: VaultScanner;
	private store: TaskStore;
	private writer: TaskWriter;
	private dailyNoteService: DailyNoteService;
	private tasksInboxService: TasksInboxService;
	private sprintTopicService: SprintTopicService;
	private morningReviewService: MorningReviewService;
	private analyticsService: AnalyticsService;
	private monthlyNoteService: MonthlyNoteService;
	private monthlyAnalyticsService: MonthlyAnalyticsService;
	private archiveService: ArchiveService;
	jiraService: JiraService;
	jiraDashboardService: JiraDashboardService;
	jiraTeamService: JiraTeamService;
	teamMemberService: TeamMemberService;
	private teamRollupService: TeamRollupService;
	private teamDigestService: TeamDigestService;
	mcpServer: McpServer;
	private statusBarEl: HTMLElement;

	async onload(): Promise<void> {
		const saved = await this.loadData();
		this.data = Object.assign({}, DEFAULT_PLUGIN_DATA, saved);
		// Deep-merge settings so new defaults are applied to old saved data
		this.data.settings = Object.assign({}, DEFAULT_PLUGIN_DATA.settings, saved?.settings);
		// v3: `migrationPromptOnStartup` was renamed to `morningReviewOnStartup` when the
		// daily-migration morning-shuffle was repurposed into the Morning Review nudge
		// surface. Carry the old opt-in over, then drop the stale key.
		const legacySettings = this.data.settings as unknown as Record<string, unknown>;
		const legacyPrompt = legacySettings.migrationPromptOnStartup;
		if (typeof legacyPrompt === 'boolean' && !this.data.settings.morningReviewOnStartup) {
			this.data.settings.morningReviewOnStartup = legacyPrompt;
		}
		delete legacySettings.migrationPromptOnStartup;
		// `lastMigrationDate` (the old once-per-day guard) became `lastMorningReviewDate`.
		const legacyData = this.data as unknown as Record<string, unknown>;
		this.data.lastMorningReviewDate =
			this.data.lastMorningReviewDate ??
			(legacyData.lastMigrationDate as string | null | undefined) ??
			null;
		delete legacyData.lastMigrationDate;
		this.data.weeklyHistory = this.data.weeklyHistory ?? [];
		this.data.lastWeeklyReviewWeek = this.data.lastWeeklyReviewWeek ?? null;
		this.data.monthlyHistory = this.data.monthlyHistory ?? [];
		this.data.kanbanMigrationDone = this.data.kanbanMigrationDone ?? false;
		this.data.workloadHistory = this.data.workloadHistory ?? [];
		this.data.lastWorkloadSnapshotWeek = this.data.lastWorkloadSnapshotWeek ?? null;

		// Migrate removed view modes: Eisenhower and ImpactEffort (task-level) were repurposed
		// for Topics; Sprint was removed when the plugin moved to a continuous Kanban model.
		// Rewrite stale defaultViewMode values so users don't land on a missing case.
		// v3 retired the task-side tabs (Daily/Weekly/Monthly/Overdue/Overview/Inbox/
		// Unscheduled/Analytics) in favor of Today/Upcoming/Triage/Someday. Redirect those
		// plus the older removed modes so a stale saved default never opens a hidden tab.
		const staleModes = [
			'eisenhower', 'impactEffort', 'sprint',
			'daily', 'weekly', 'monthly', 'overdue', 'overview', 'inbox', 'unscheduled', 'analytics',
		];
		if (staleModes.includes(this.data.settings.defaultViewMode as string)) {
			this.data.settings.defaultViewMode = FridayViewMode.Today;
		}
		// `team` was briefly a tab in the Friday view; now a standalone workspace view.
		// Redirect the default so users who had it pinned land on Daily instead of
		// hitting a removed switch case.
		if ((this.data.settings.defaultViewMode as string) === 'team') {
			this.data.settings.defaultViewMode = FridayViewMode.Today;
		}

		this.settings = this.data.settings;

		this.store = new TaskStore();
		this.writer = new TaskWriter(this.app.vault);
		this.scanner = new VaultScanner(this.app.vault, () => this.settings);
		this.scanner.setWriter(this.writer);
		this.dailyNoteService = new DailyNoteService(this.app.vault, () => this.settings);
		this.tasksInboxService = new TasksInboxService(this.app.vault, () => this.settings);
		this.sprintTopicService = new SprintTopicService(this.app.vault, () => this.settings, this.app);
		this.morningReviewService = new MorningReviewService(
			() => this.data,
			() => this.saveSettings(),
		);
		this.analyticsService = new AnalyticsService(this.store, () => this.settings);
		this.monthlyNoteService = new MonthlyNoteService(this.app.vault, () => this.settings);
		this.monthlyAnalyticsService = new MonthlyAnalyticsService(
			this.store,
			() => this.settings,
			() => this.data,
		);
		this.archiveService = new ArchiveService(this.app.vault, this.store, () => this.settings);
		this.jiraService = new JiraService(() => this.settings);
		this.jiraDashboardService = new JiraDashboardService(() => this.settings);
		this.jiraTeamService = new JiraTeamService(() => this.settings);
		this.teamMemberService = new TeamMemberService(this.app.vault, this.scanner, () => this.settings);
		this.teamRollupService = new TeamRollupService(
			() => this.settings,
			this.teamMemberService,
			this.jiraTeamService,
			() => this.scanner.getAllTopics(),
		);
		this.teamDigestService = new TeamDigestService(
			this.app.vault,
			() => this.settings,
			this.teamRollupService,
			this.jiraTeamService,
		);

		// Embedded MCP server — opt-in via settings, desktop only. The tool layer is wired
		// up here so the same instance handles every tool call without re-binding state on
		// each request. The server starts/stops based on settings; tools are static.
		this.mcpServer = new McpServer();
		this.mcpServer.setTools([
			...taskTools({
				store: this.store,
				writer: this.writer,
				dailyNoteService: this.dailyNoteService,
				tasksInboxService: this.tasksInboxService,
				sprintTopicService: this.sprintTopicService,
				getSettings: () => this.settings,
			}),
			...topicTools({
				sprintTopicService: this.sprintTopicService,
				jiraService: this.jiraService,
				getSettings: () => this.settings,
			}),
			...teamTools({
				teamMemberService: this.teamMemberService,
				scanner: this.scanner,
			}),
		]);

		this.scanner.onChange(() => {
			this.store.setTasks(this.scanner.getAllTasks());
			this.updateStatusBar();
		});

		// Topic changes also trigger view refresh — bump store version to invalidate fingerprint
		this.scanner.onTopicsChange(() => {
			this.store.setTasks(this.scanner.getAllTasks());
		});

		this.registerView(VIEW_TYPE_FRIDAY, (leaf) =>
			new FridayView(
				leaf, this.store, this.writer,
				this.sprintTopicService, this.scanner,
				this.analyticsService,
				this.monthlyAnalyticsService, this.monthlyNoteService,
				this.jiraService,
				this.settings,
				() => this.data,
				(snapshot) => this.saveWeeklySnapshot(snapshot),
				(snapshot) => this.saveMonthlySnapshot(snapshot),
			)
		);

		this.registerView(VIEW_TYPE_TEAM_DASHBOARD, (leaf) =>
			new TeamDashboardView(
				leaf,
				this.teamMemberService,
				this.teamRollupService,
				this.teamDigestService,
				this.jiraTeamService,
				() => this.settings,
				// Scanner has no unsubscribe API; the view guards on `contentContainer`
				// being non-null so closures fired post-close are safe.
				(cb) => this.scanner.onTeamChange(cb),
				(cb) => this.scanner.onTopicsChange(cb),
				() => this.activateJiraTeamTab(),
				() => this.data,
			)
		);

		this.registerView(VIEW_TYPE_JIRA_DASHBOARD, (leaf) =>
			new JiraDashboardView(
				leaf,
				this.jiraDashboardService,
				() => this.settings,
				// Sticky UI-state saves (collapsed sections) must not trigger the
				// cache-invalidation side effect that saveSettings() runs, or every
				// section toggle would wipe the dashboard result set.
				() => this.saveData(this.data),
				() => this.scanner.getAllTopics(),
				this.sprintTopicService,
				(cb) => this.scanner.onTopicsChange(cb),
				this.jiraTeamService,
			)
		);

		const refs = this.scanner.registerEvents();
		refs.forEach(ref => this.registerEvent(ref));

		// Keep blockedBy dependency edges intact when a topic file is renamed —
		// whether via the edit modal or manually in the file explorer.
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				const topicsFolder = this.settings.sprintTopicsPath + '/';
				if (file instanceof TFile && oldPath.startsWith(topicsFolder)) {
					void this.sprintTopicService.handleTopicRename(oldPath, file.path);
				}
			})
		);

		this.addRibbonIcon('check-square', 'Open Friday', () => this.activateView());
		this.addRibbonIcon('layout-dashboard', 'Open JIRA Dashboard', () => this.activateJiraDashboard());
		this.addRibbonIcon('users', 'Open Team Dashboard', () => this.activateTeamDashboard());

		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.setText('Friday ...');

		this.addCommand({
			id: 'open-bujo',
			name: 'Open',
			callback: () => this.activateView(),
		});

		this.addCommand({
			id: 'open-bujo-new-tab',
			name: 'Open in New Tab',
			callback: () => this.activateView(true),
		});

		this.addCommand({
			id: 'open-jira-dashboard',
			name: 'Open JIRA Dashboard',
			callback: () => this.activateJiraDashboard(),
		});

		this.addCommand({
			id: 'open-team-dashboard',
			name: 'Open Team Dashboard',
			callback: () => this.activateTeamDashboard(),
		});

		this.addCommand({
			id: 'refresh-jira-dashboard',
			name: 'Refresh JIRA Dashboard',
			// Refresh both in parallel — if the team service is disabled it no-ops.
			callback: () => {
				this.jiraDashboardService.refresh();
				this.jiraTeamService.refresh();
			},
		});

		this.addCommand({
			id: 'open-morning-review',
			name: 'Morning Review',
			callback: () => this.showMorningReview(),
		});

		this.addCommand({
			id: 'weekly-review',
			name: 'Weekly Review',
			callback: () => this.showWeeklyReview(),
		});

		this.addCommand({
			id: 'syntax-reference',
			name: 'Syntax Reference',
			callback: () => new SyntaxReferenceModal(this.app).open(),
		});

		// ── Topic quick-switcher & palette commands (Kanban-aware) ──
		this.addCommand({
			id: 'go-to-topic',
			name: 'Go to topic',
			callback: () => {
				const topics = this.scanner.getAllTopics();
				if (topics.length === 0) { new Notice('No topics found.'); return; }
				new TopicSwitcherModal(this.app, topics, (t) => { void this.openTopicFile(t.filePath); }, this.settings).open();
			},
		});

		this.addCommand({
			id: 'create-topic',
			name: 'Create topic',
			callback: () => {
				// Scanner picks up the new file and re-renders open views; no manual refresh needed.
				new SprintTopicModal(this.app, this.sprintTopicService, () => { /* no-op */ }, undefined, undefined, this.settings, this.scanner.getAllTopics()).open();
			},
		});

		this.addCommand({
			id: 'create-topic-from-jira',
			name: 'Create topic from JIRA issue',
			callback: () => {
				if (!this.jiraService.isEnabled()) {
					new Notice('Enable the JIRA module in Settings to create topics from issues.');
					return;
				}
				// Prompt accepts one or more keys. A single key creates the topic and opens the new
				// note for review; several batch-create and report a summary. Keys already linked to a
				// topic are skipped (no duplicates); the shared helper fills basic info + wires blockers.
				new JiraKeyPromptModal(this.app, async (raw) => {
					const keys = this.jiraService.extractAllIssueKeys(raw.toUpperCase());
					if (keys.length === 0) return `No JIRA issue key found in "${raw}" (expected e.g. PROJ-123).`;

					const allTopics = this.scanner.getAllTopics();
					const todayIso = new Date().toISOString().slice(0, 10);
					const created: SprintTopic[] = [];
					const linked: { key: string; topic: SprintTopic }[] = [];
					const failed: { key: string; reason: string }[] = [];

					for (const key of keys) {
						const existing = allTopics.find(t => t.jira.includes(key));
						if (existing) { linked.push({ key, topic: existing }); continue; }
						const info = await this.jiraService.fetchIssue(key);
						if (!info) {
							failed.push({ key, reason: this.jiraService.getError(key) ?? 'fetch failed' });
							continue;
						}
						try {
							const topic = await createTopicFromJiraInfo(this.sprintTopicService, info, {
								teamMembers: this.settings.teamMembers ?? [],
								todayIso,
							});
							created.push(topic);
							allTopics.push(topic); // later keys can dedupe against this one
						} catch (e) {
							failed.push({ key, reason: e instanceof Error ? e.message : 'create failed' });
						}
					}

					// Single key: act and close, unless it hard-failed (keep the prompt open with the reason).
					if (keys.length === 1) {
						if (created.length === 1) {
							new Notice(`Topic created from ${keys[0]}: ${created[0].title}`);
							void this.openTopicFile(created[0].filePath);
							return null;
						}
						if (linked.length === 1) {
							new Notice(`${keys[0]} is already linked — opening existing topic.`);
							void this.openTopicFile(linked[0].topic.filePath);
							return null;
						}
						return `Couldn't create from ${keys[0]} — ${failed[0]?.reason ?? 'unknown error'}.`;
					}

					// Bulk: summarize and close (unless nothing happened at all).
					const parts: string[] = [];
					if (created.length) parts.push(`created ${created.length}`);
					if (linked.length) parts.push(`skipped ${linked.length} already-linked`);
					if (failed.length) parts.push(`${failed.length} failed`);
					new Notice(`JIRA → topics: ${parts.join(', ')}.`);
					if (created.length === 0 && linked.length === 0) {
						return `None created. ${failed.map(f => `${f.key}: ${f.reason}`).join('; ')}`;
					}
					return null;
				}).open();
			},
		});

		this.addCommand({
			id: 'sync-topic-dependencies-from-jira',
			name: 'Sync topic dependencies from JIRA',
			callback: async () => {
				if (!this.jiraService.isEnabled()) {
					new Notice('Enable the JIRA module in Settings to sync dependencies.');
					return;
				}
				const topics = this.scanner.getAllTopics();
				const linkedCount = topics.filter(t => t.jira.length > 0).length;
				if (linkedCount === 0) { new Notice('No topics are linked to JIRA issues.'); return; }

				new Notice(`Syncing dependencies from JIRA for ${linkedCount} topic(s)…`);
				const { added, rejected } = await syncTopicDependenciesFromJira(
					this.sprintTopicService, this.jiraService, topics,
				);
				const tail = rejected > 0 ? ` (${rejected} skipped — cycle/invalid)` : '';
				new Notice(added > 0 ? `Dependency sync: added ${added} link(s)${tail}.` : `Dependency sync: nothing new${tail}.`);
			},
		});

		this.addCommand({
			id: 'move-topic-to-column',
			name: 'Move topic to column',
			callback: async () => {
				const topics = this.scanner.getAllTopics();
				if (topics.length === 0) { new Notice('No topics found.'); return; }
				const topic = await pickFromList(this.app, topics.map(t => ({
					text: t.title, value: t, hint: this.topicColumnLabel(t.status),
				})), { placeholder: 'Pick a topic…' });
				if (!topic) return;
				const status = await pickFromList<TopicStatus>(this.app, [
					{ text: 'Backlog', value: 'backlog' },
					{ text: 'To Do', value: 'open' },
					{ text: 'In Progress', value: 'in-progress' },
					{ text: 'Done', value: 'done' },
				], { placeholder: `Move "${topic.title}" to…` });
				if (status === null) return;
				await this.sprintTopicService.setTopicStatus(topic.filePath, status);
				new Notice(`Moved "${topic.title}" → ${this.topicColumnLabel(status)}`);
			},
		});

		this.addCommand({
			id: 'toggle-topic-blocked',
			name: 'Toggle topic blocked',
			callback: async () => {
				const topics = this.scanner.getAllTopics();
				if (topics.length === 0) { new Notice('No topics found.'); return; }
				const topic = await pickFromList(this.app, topics.map(t => ({
					text: t.title, value: t, hint: t.blocked ? 'blocked' : '',
				})), { placeholder: 'Toggle blocked on…' });
				if (!topic) return;
				await this.sprintTopicService.setTopicBlocked(topic.filePath, !topic.blocked);
				new Notice(`${topic.blocked ? 'Unblocked' : 'Blocked'}: ${topic.title}`);
			},
		});

		this.addCommand({
			id: 'set-topic-due-date',
			name: 'Set topic due date',
			callback: async () => {
				const topics = this.scanner.getAllTopics();
				if (topics.length === 0) { new Notice('No topics found.'); return; }
				const topic = await pickFromList(this.app, topics.map(t => ({
					text: t.title, value: t, hint: t.dueDate ?? '',
				})), { placeholder: 'Set due date on…' });
				if (!topic) return;
				const current = topic.dueDate ? isoToPluginDate(topic.dueDate) : '';
				new DueDateModal(this.app, current, async (pluginDate) => {
					const iso = pluginDate ? pluginDateToIso(pluginDate) : null;
					await this.sprintTopicService.setTopicDueDate(topic.filePath, iso);
					new Notice(iso ? `Due ${iso}: ${topic.title}` : `Due date cleared: ${topic.title}`);
				}).open();
			},
		});

		this.addCommand({
			id: 'open-board',
			name: 'Open Board',
			callback: () => { void this.activateViewAtMode(FridayViewMode.Topics, 'board'); },
		});

		this.addCommand({
			id: 'open-roadmap',
			name: 'Open Roadmap',
			callback: () => { void this.activateViewAtMode(FridayViewMode.Topics, 'roadmap'); },
		});

		this.addCommand({
			id: 'monthly-review',
			name: 'Monthly Review',
			callback: () => this.showMonthlyReview(),
		});

		this.addCommand({
			id: 'create-monthly-note',
			name: 'Create Monthly Note',
			callback: () => this.monthlyNoteService.getOrCreateMonthlyNote(new Date()),
		});

		this.addCommand({
			id: 'start-1-on-1',
			name: 'Start 1:1',
			callback: () => this.openOneOnOnePicker(),
		});

		this.addCommand({
			id: 'generate-team-digest',
			name: 'Generate Team Status Digest',
			callback: async () => {
				try {
					const file = await this.teamDigestService.generateDigest(new Date());
					const leaf = this.app.workspace.getLeaf(false);
					await leaf.openFile(file);
					this.app.workspace.revealLeaf(leaf);
					new Notice('Team status digest generated.');
				} catch (e) {
					new Notice(`Could not generate digest: ${e instanceof Error ? e.message : 'error'}`);
				}
			},
		});

		this.addCommand({
			id: 'capture-workload-snapshot',
			name: 'Capture Workload Snapshot',
			callback: async () => {
				const ok = await this.captureWorkloadSnapshot(new Date());
				new Notice(ok ? 'Workload snapshot captured.' : 'No active team members to snapshot.');
			},
		});

		this.addCommand({
			id: 'archive-completed',
			name: 'Archive Completed Tasks',
			callback: async () => {
				const result = await this.archiveService.archiveCompleted();
				if (result.archived === 0 && result.skipped === 0) {
					new Notice('No completed tasks to archive.');
				} else {
					const parts = [`Archived ${result.archived} task(s) to ${result.files.length} file(s).`];
					if (result.skipped > 0) {
						parts.push(`${result.skipped} skipped (source file edited since last scan — try again).`);
					}
					new Notice(parts.join(' '));
				}
			},
		});

		this.addCommand({
			id: 'sweep-daily-inbox',
			name: 'Sweep daily Inbox → Tasks.md',
			callback: async () => {
				const path = this.tasksInboxService.todayDailyPath(new Date());
				const moved = await this.tasksInboxService.sweepDailyInbox(path);
				if (moved === 0) {
					new Notice('Nothing in today\'s Inbox to sweep.');
				} else {
					await this.scanner.fullScan();
					this.store.setTasks(this.scanner.getAllTasks());
					new Notice(`Swept ${moved} item(s) into Tasks.md.`);
				}
			},
		});

		// ── v3 postpone commands (operate on the checkbox line at the cursor) ──
		this.addCommand({
			id: 'snooze-task',
			name: 'Snooze task…',
			editorCallback: (editor: Editor) => {
				const line = editor.getCursor().line;
				if (!/^\s*-\s*\[[ x><!/-]\]/i.test(editor.getLine(line))) {
					new Notice('Put the cursor on a task line first.');
					return;
				}
				new DueDateModal(this.app, '', (pluginDate) => {
					if (!pluginDate) return;
					const iso = pluginDateToIso(pluginDate);
					this.setLineSnooze(editor, line, this.settings.dateFormat === 'dmy' ? pluginDate : iso);
				}).open();
			},
		});

		this.addCommand({
			id: 'send-to-someday',
			name: 'Send task to Someday',
			editorCallback: (editor: Editor) => {
				const line = editor.getCursor().line;
				if (!/^\s*-\s*\[[ x><!/-]\]/i.test(editor.getLine(line))) {
					new Notice('Put the cursor on a task line first.');
					return;
				}
				this.setLineSomeday(editor, line, true);
			},
		});

		this.addCommand({
			id: 'wake-task',
			name: 'Wake task (clear snooze / Someday)',
			editorCallback: (editor: Editor) => {
				const line = editor.getCursor().line;
				this.wakeLine(editor, line);
			},
		});

		// Quick create task command (works globally)
		this.addCommand({
			id: 'insert-task-with-details',
			name: 'Quick Create Task',
			hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 't' }],
			callback: () => {
				new InsertTaskModal(this.app, async (result) => {
					const block = buildTaskBlock(result.text, result.priority, result.dueDate, result.typeTag, result.workType, result.purpose, result.description);

					// Try to insert at active editor cursor
					const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
					if (activeView?.editor) {
						const editor = activeView.editor;
						const cursor = editor.getCursor();
						editor.replaceRange(block + '\n', { line: cursor.line + 1, ch: 0 });
						const insertedLines = block.split('\n').length;
						editor.setCursor({ line: cursor.line + insertedLines, ch: 0 });
					} else {
						// No active editor — land in the central Tasks.md inbox (v3).
						await this.tasksInboxService.appendLines(block.split('\n'));
						new Notice('Task added to Tasks.md');
					}
				}, this.settings.workTypes, this.settings.purposes).open();
			},
		});

		this.addCommand({
			id: 'quick-capture-inbox',
			name: 'Quick Capture to Inbox',
			hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'i' }],
			callback: () => {
				new QuickCaptureModal(this.app, async (text) => {
					// First line becomes the checkbox; subsequent lines are indented so they
					// render as continuation of the same list item rather than breaking out.
					const lines = text.split('\n');
					const first = lines[0];
					const rest = lines.slice(1).map(l => `    ${l}`).join('\n');
					const block = rest ? `- [ ] ${first}\n${rest}` : `- [ ] ${first}`;
					await this.dailyNoteService.addRawInboxLine(block, new Date());
					new Notice('Captured to today\'s Inbox');
				}).open();
			},
		});

		// Right-click editor context menu
		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu: Menu, editor: Editor) => {
				// Always offer "Quick create task"
				menu.addItem(item => {
					item.setTitle('Friday: Quick create task')
						.setIcon('check-square')
						.onClick(() => {
							new InsertTaskModal(this.app, (result) => {
								const block = buildTaskBlock(result.text, result.priority, result.dueDate, result.typeTag, result.workType, result.purpose, result.description);
								const cursor = editor.getCursor();
								editor.replaceRange(block + '\n', { line: cursor.line + 1, ch: 0 });
								const insertedLines = block.split('\n').length;
								editor.setCursor({ line: cursor.line + insertedLines, ch: 0 });
							}, this.settings.workTypes, this.settings.purposes).open();
						});
				});

				// Context-sensitive items for existing checkbox lines
				const cursor = editor.getCursor();
				const currentLine = editor.getLine(cursor.line);
				const checkboxMatch = currentLine.match(/^(\s*)-\s*\[([ x><!-])\]\s+(.*)/i);

				if (checkboxMatch) {
					menu.addSeparator();

					// Toggle done/open
					const isDone = checkboxMatch[2].toLowerCase() === 'x';
					menu.addItem(item => {
						item.setTitle(isDone ? 'Friday: Mark as open' : 'Friday: Mark as done')
							.setIcon(isDone ? 'circle' : 'check')
							.onClick(() => {
								const newChar = isDone ? ' ' : 'x';
								const newLine = currentLine.replace(/\[([ x><!-])\]/i, `[${newChar}]`);
								editor.setLine(cursor.line, newLine);
							});
					});

					// Set priority — individual menu items
					const priorities: [string, string, string][] = [
						['high', 'High Priority', 'alert-triangle'],
						['medium', 'Medium Priority', 'alert-circle'],
						['low', 'Low Priority', 'info'],
					];

					for (const [val, label, icon] of priorities) {
						menu.addItem(item => {
							item.setTitle(`Friday: ${label}`)
								.setIcon(icon)
								.onClick(() => {
									this.setLinePriority(editor, cursor.line, val);
								});
						});
					}

					menu.addItem(item => {
						item.setTitle('Friday: Remove priority')
							.setIcon('x')
							.onClick(() => {
								this.setLinePriority(editor, cursor.line, null);
							});
					});

					// Set due date
					menu.addItem(item => {
						item.setTitle('Friday: Set due date')
							.setIcon('calendar')
							.onClick(() => {
								const existing = currentLine.match(DUE_DATE_REGEX)?.[1] || '';
								new DueDateModal(this.app, existing, (newDate) => {
									let updated = currentLine.replace(DUE_DATE_REGEX, '').replace(/\s{2,}/g, ' ').trimEnd();
									if (newDate) updated += ` @due ${newDate}`;
									editor.setLine(cursor.line, updated);
								}).open();
							});
					});

					// ── v3 postpone actions ──
					menu.addSeparator();
					menu.addItem(item => {
						item.setTitle('Friday: Snooze…')
							.setIcon('alarm-clock')
							.onClick(() => {
								new DueDateModal(this.app, '', (pluginDate) => {
									if (!pluginDate) return;
									const iso = pluginDateToIso(pluginDate);
									this.setLineSnooze(editor, cursor.line, this.settings.dateFormat === 'dmy' ? pluginDate : iso);
								}).open();
							});
					});
					const isSomeday = SOMEDAY_TAG_REGEX.test(currentLine);
					const isSnoozed = SNOOZE_DATE_REGEX.test(currentLine);
					if (isSomeday || isSnoozed) {
						menu.addItem(item => {
							item.setTitle('Friday: Wake (clear snooze / Someday)')
								.setIcon('sun')
								.onClick(() => this.wakeLine(editor, cursor.line));
						});
					} else {
						menu.addItem(item => {
							item.setTitle('Friday: Send to Someday')
								.setIcon('moon')
								.onClick(() => this.setLineSomeday(editor, cursor.line, true));
						});
					}
				}
			})
		);

		this.addSettingTab(new FridaySettingTab(this.app, this));

		this.app.workspace.onLayoutReady(async () => {
			await this.scanner.fullScan();
			this.store.setTasks(this.scanner.getAllTasks());
			this.updateStatusBar();
			await this.runKanbanMigrationIfNeeded();
			await this.autoGenerateTeamPagesIfNeeded();
			await this.captureWorkloadSnapshotIfNeeded();
			await this.runInboxCleanupIfNeeded();
			await this.checkMorningReview();
			this.checkWeeklyReview();
			await this.applyMcpServerState();
		});
	}

	/** Start/stop the MCP server based on current settings. Idempotent — safe to call
	 *  from onload, after settings changes, and from manual UI buttons. No-op on mobile
	 *  (Node's http module is unavailable there). */
	async applyMcpServerState(): Promise<void> {
		if (!Platform.isDesktop) return;
		if (this.settings.mcpEnabled) {
			if (!this.settings.mcpToken) {
				this.settings.mcpToken = generateMcpToken();
				await this.saveData(this.data);
			}
			try {
				await this.mcpServer.start({
					mcpHost: this.settings.mcpHost,
					mcpPort: this.settings.mcpPort,
					mcpToken: this.settings.mcpToken,
				});
			} catch {
				// Server posted an error status; surface it once via Notice.
				noticeForError(this.mcpServer.getStatus());
			}
		} else {
			await this.mcpServer.stop();
		}
	}

	/** One-time sprint→Kanban data migration. Rewrites topic frontmatter (backlog status +
	 *  strips dead sprint keys) once, guarded by a persisted flag so it never re-runs. */
	private async runKanbanMigrationIfNeeded(): Promise<void> {
		if (this.data.kanbanMigrationDone) return;
		try {
			const changed = await this.sprintTopicService.migrateToKanban();
			this.data.kanbanMigrationDone = true;
			await this.saveData(this.data);
			if (changed > 0) {
				await this.scanner.fullScan();
				this.store.setTasks(this.scanner.getAllTasks());
				new Notice(`Friday: migrated ${changed} topic(s) to the Kanban board.`);
			}
		} catch (e) {
			console.error('[Friday] Kanban migration failed:', e);
		}
	}

	/** Capture a workload snapshot from the current roll-up. Awaits a JIRA refresh when
	 *  enabled+stale; records jiraIncluded=false rather than logging zeros if unavailable.
	 *  Returns false (no-op) when there are no active team members. */
	private async captureWorkloadSnapshot(now: Date = new Date()): Promise<boolean> {
		const active = (this.settings.teamMembers ?? []).filter(m => m.active && m.email);
		if (active.length === 0) return false;
		if (this.jiraTeamService.isEnabled() && this.jiraTeamService.isStale()) {
			try { await this.jiraTeamService.refresh(); } catch { /* tolerate — snapshot falls back to topics */ }
		}
		const rollup = this.teamRollupService.buildRollup(now);
		const members: WorkloadSnapshot['members'] = {};
		const totals = { committed: 0, blocked: 0, inProgress: 0, open: 0, done: 0 };
		for (const m of rollup.members) {
			const c = m.counts;
			const blocked = c.jiraBlocked + c.topicsBlocked;
			const inProgress = c.jiraInProgress + c.topicsInProgress;
			const open = c.jiraOpen + c.topicsOpen;
			const done = c.jiraDone + c.topicsDone;
			members[m.email] = { displayName: m.displayName, committed: m.load.committed, blocked, inProgress, open, done };
			// On-leave / OOO members ('out' band) are excluded from team totals so their frozen
			// pre-leave backlog doesn't make the team trend look busier than it is during the leave.
			if (m.load.band !== 'out') {
				totals.committed += m.load.committed;
				totals.blocked += blocked;
				totals.inProgress += inProgress;
				totals.open += open;
				totals.done += done;
			}
		}
		await this.saveWorkloadSnapshot({
			weekId: getWeekId(now),
			capturedAt: now.toISOString(),
			jiraIncluded: rollup.jiraIncluded,
			members,
			totals,
		});
		return true;
	}

	private async saveWorkloadSnapshot(snapshot: WorkloadSnapshot): Promise<void> {
		const MAX_HISTORY = 104;
		const idx = this.data.workloadHistory.findIndex(s => s.weekId === snapshot.weekId);
		if (idx >= 0) this.data.workloadHistory[idx] = snapshot;
		else this.data.workloadHistory.push(snapshot);
		if (this.data.workloadHistory.length > MAX_HISTORY) {
			this.data.workloadHistory = this.data.workloadHistory.slice(-MAX_HISTORY);
		}
		this.data.lastWorkloadSnapshotWeek = snapshot.weekId;
		await this.saveData(this.data);
	}

	/** Weekly opportunistic capture — once per ISO week, when there are active members. */
	private async captureWorkloadSnapshotIfNeeded(): Promise<void> {
		if (this.data.lastWorkloadSnapshotWeek === getWeekId(new Date())) return;
		await this.captureWorkloadSnapshot(new Date());
	}

	/** One-shot: if the user has a populated `teamMembers[]` list from the JIRA
	 *  team-tracking feature but no person pages in `teamFolderPath`, create
	 *  skeleton pages automatically. Idempotent — safe on every startup.
	 *  Skipped when the team folder already contains at least one person page so
	 *  a user who's curated their own layout isn't disturbed. */
	private async autoGenerateTeamPagesIfNeeded(): Promise<void> {
		const members = this.settings.teamMembers;
		if (!members || members.length === 0) return;
		if (this.teamMemberService.getAllMembers().length > 0) return; // pages already exist

		let created = 0;
		for (const m of members) {
			if (!m.fullName) continue;
			try {
				if (await this.teamMemberService.ensurePageFromSettings(m)) created++;
			} catch {
				// Swallow per-member errors so one bad name doesn't abort the batch.
			}
		}
		if (created > 0) {
			// Kick the scanner so the Team view picks up the new files without waiting
			// for the user to trigger an edit.
			await this.scanner.fullScan();
			this.store.setTasks(this.scanner.getAllTasks());
			new Notice(`Friday: generated ${created} person page(s) in ${this.settings.teamFolderPath}/. Open them to fill in details.`);
		}
	}

	async activateView(newTab = false): Promise<void> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(VIEW_TYPE_FRIDAY);

		if (leaves.length > 0 && !newTab) {
			leaf = leaves[0];
		} else {
			leaf = workspace.getLeaf(true);
			if (leaf) await leaf.setViewState({ type: VIEW_TYPE_FRIDAY, active: true });
		}

		if (leaf) workspace.revealLeaf(leaf);
	}

	async activateJiraDashboard(): Promise<void> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(VIEW_TYPE_JIRA_DASHBOARD);
		if (leaves.length > 0) {
			leaf = leaves[0];
		} else {
			leaf = workspace.getLeaf(true);
			if (leaf) await leaf.setViewState({ type: VIEW_TYPE_JIRA_DASHBOARD, active: true });
		}
		if (leaf) workspace.revealLeaf(leaf);
	}

	async activateTeamDashboard(): Promise<void> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(VIEW_TYPE_TEAM_DASHBOARD);
		if (leaves.length > 0) {
			leaf = leaves[0];
		} else {
			leaf = workspace.getLeaf(true);
			if (leaf) await leaf.setViewState({ type: VIEW_TYPE_TEAM_DASHBOARD, active: true });
		}
		if (leaf) workspace.revealLeaf(leaf);
	}

	/** Open the JIRA Dashboard with the Team tab pre-selected. Called from the
	 *  Team Overview "JIRA workload" chip on each person card. Uses the sticky-state
	 *  save path so fetched caches aren't wiped. */
	async activateJiraTeamTab(): Promise<void> {
		if (this.settings.jiraDashboardActiveTab !== 'team') {
			this.settings.jiraDashboardActiveTab = 'team';
			await this.saveData(this.data);
		}
		await this.activateJiraDashboard();
	}

	/** Open (or focus) the Friday view and switch it to a specific mode. */
	private async activateViewAtMode(mode: FridayViewMode, topicsSubMode?: TopicsSubMode): Promise<void> {
		await this.activateView();
		const view = this.app.workspace.getLeavesOfType(VIEW_TYPE_FRIDAY)[0]?.view;
		if (view instanceof FridayView) view.setViewMode(mode, topicsSubMode);
	}

	/** Open a topic markdown file in the active leaf. */
	private async openTopicFile(path: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) { new Notice('Topic file not found.'); return; }
		const leaf = this.app.workspace.getLeaf(false);
		await leaf.openFile(file);
		this.app.workspace.revealLeaf(leaf);
	}

	private topicColumnLabel(status: TopicStatus): string {
		switch (status) {
			case 'backlog': return 'Backlog';
			case 'open': return 'To Do';
			case 'in-progress': return 'In Progress';
			case 'done': return 'Done';
			default: return status;
		}
	}

	/** Open the fuzzy picker for 1:1 start. Separates the "pick" from "start"
	 *  so the same flow is reachable from a keyboard shortcut (no view open)
	 *  as well as from the Team Overview button. Scopes to active members —
	 *  on-leave teammates can still be reached via the per-card button on the
	 *  Team tab if an urgent 1:1 is needed. */
	private openOneOnOnePicker(): void {
		const members = this.teamMemberService.getActiveMembers();
		if (members.length === 0) {
			new Notice('No active team members found. Create a person page under ' + this.settings.teamFolderPath + '/.');
			return;
		}
		new OneOnOneModal(this.app, members, async (member) => {
			try {
				const rollup = this.teamRollupService.buildRollup();
				const r = rollup.members.find(x => x.email.toLowerCase() === (member.email ?? '').toLowerCase());
				const agenda = r ? buildOneOnOneAgenda(r) : undefined;
				const file = await this.teamMemberService.startOneOnOne(member, new Date(), agenda);
				const leaf = this.app.workspace.getLeaf(false);
				await leaf.openFile(file);
				this.app.workspace.revealLeaf(leaf);
			} catch (e) {
				new Notice(`Could not start 1:1: ${e instanceof Error ? e.message : 'unknown error'}`);
			}
		}).open();
	}

	/** v3 auto-cleaning: on startup, sweep completed tasks that have aged out of the central
	 *  Tasks.md into the archive so the inbox only ever shows live work. No-op when the
	 *  threshold is 0 (manual-only) or there's nothing to move. */
	private async runInboxCleanupIfNeeded(): Promise<void> {
		const days = this.settings.archiveCompletedAfterDays;
		if (days == null || days <= 0) return;
		try {
			const result = await this.archiveService.cleanupInbox(days, this.settings.tasksFilePath);
			if (result.archived > 0) {
				await this.scanner.fullScan();
				this.store.setTasks(this.scanner.getAllTasks());
				new Notice(`Friday: archived ${result.archived} completed task(s) from ${this.settings.tasksFilePath.split('/').pop()}.`);
			}
		} catch (e) {
			console.error('[Friday] Inbox cleanup failed:', e);
		}
	}

	private async checkMorningReview(): Promise<void> {
		if (!this.settings.morningReviewOnStartup) return;
		if (this.morningReviewService.alreadyReviewedToday()) return;
		// Stamp before opening so a skipped review does not re-pop for the rest of the day.
		await this.morningReviewService.markReviewedToday();
		this.showMorningReview();
	}

	private showMorningReview(): void {
		new MorningReviewModal(
			this.app,
			this.dailyNoteService,
			this.teamMemberService,
			this.sprintTopicService,
			this.settings,
		).open();
	}

	private updateStatusBar(): void {
		this.statusBarEl.setText(`${this.store.getPendingCount()} pending`);
	}

	private showWeeklyReview(precomputedStats?: WeeklyStats): void {
		new WeeklyReviewModal(
			this.app,
			this.analyticsService,
			this.settings,
			this.data.weeklyHistory,
			(snapshot) => this.saveWeeklySnapshot(snapshot),
			precomputedStats,
		).open();
	}

	/** Check if a new week has started and auto-prompt weekly review */
	private checkWeeklyReview(): void {
		const currentWeekId = getWeekId(new Date());
		if (this.data.lastWeeklyReviewWeek === currentWeekId) return;

		// New week detected — auto-snapshot the just-ended (previous) week if there's data.
		// Pass the previous week's stats explicitly; without them the modal would fall back
		// to getCurrentWeekStats() and snapshot the new, nearly-empty week instead.
		if (this.data.lastWeeklyReviewWeek !== null) {
			const prevWeekStart = getWeekStartConfigurable(new Date(), this.settings.weekStartDay);
			prevWeekStart.setDate(prevWeekStart.getDate() - 7);
			this.showWeeklyReview(this.analyticsService.getStatsForWeek(prevWeekStart));
		}
	}

	/** Save a weekly snapshot to persistent data */
	private async saveWeeklySnapshot(snapshot: WeeklySnapshot): Promise<void> {
		const MAX_HISTORY = 104; // 2 years of weekly snapshots
		// Replace existing snapshot for same week, or append
		const idx = this.data.weeklyHistory.findIndex(s => s.weekId === snapshot.weekId);
		if (idx >= 0) {
			this.data.weeklyHistory[idx] = snapshot;
		} else {
			this.data.weeklyHistory.push(snapshot);
		}
		// Prune oldest entries if over limit
		if (this.data.weeklyHistory.length > MAX_HISTORY) {
			this.data.weeklyHistory = this.data.weeklyHistory.slice(-MAX_HISTORY);
		}
		this.data.lastWeeklyReviewWeek = snapshot.weekId;
		await this.saveData(this.data);
	}

	async saveSettings(requiresRescan: boolean = true): Promise<void> {
		this.data.settings = this.settings;
		await this.saveData(this.data);
		if (requiresRescan) {
			this.scanner.invalidateClassifier();
			await this.scanner.fullScan();
			this.store.setTasks(this.scanner.getAllTasks());
		}
		// JIRA cache is keyed by URL/token, so any settings save could have invalidated it.
		// Cheap to clear; worst case views re-fetch the next time they render.
		this.jiraService?.clearCache();
		this.jiraDashboardService?.clearCache();
		this.jiraTeamService?.clearCache();
		this.updateStatusBar();
	}

	private showMonthlyReview(): void {
		new MonthlyReviewModal(
			this.app,
			this.monthlyAnalyticsService,
			this.monthlyNoteService,
			this.store,
			this.settings,
			this.data.monthlyHistory,
			(snapshot) => this.saveMonthlySnapshot(snapshot),
		).open();
	}

	private async saveMonthlySnapshot(snapshot: MonthlySnapshot): Promise<void> {
		const MAX_HISTORY = 24; // 2 years of monthly snapshots
		const idx = this.data.monthlyHistory.findIndex(s => s.monthId === snapshot.monthId);
		if (idx >= 0) {
			this.data.monthlyHistory[idx] = snapshot;
		} else {
			this.data.monthlyHistory.push(snapshot);
		}
		if (this.data.monthlyHistory.length > MAX_HISTORY) {
			this.data.monthlyHistory = this.data.monthlyHistory.slice(-MAX_HISTORY);
		}
		await this.saveData(this.data);
	}

	/** Set or remove priority tag on a line in the editor */
	private setLinePriority(editor: Editor, lineNum: number, priority: string | null): void {
		let line = editor.getLine(lineNum);
		// Remove existing priority tag
		line = line.replace(PRIORITY_TAG_REGEX, '').replace(/\s{2,}/g, ' ').trimEnd();
		// Add new priority if specified
		if (priority) line += ` #priority/${priority}`;
		editor.setLine(lineNum, line);
	}

	/** Add or replace the @snooze annotation on a line (v3). Leaves @due untouched. */
	private setLineSnooze(editor: Editor, lineNum: number, dateRaw: string): void {
		let line = editor.getLine(lineNum);
		line = SNOOZE_DATE_REGEX.test(line)
			? line.replace(SNOOZE_DATE_REGEX, `@snooze ${dateRaw}`)
			: `${line.trimEnd()} @snooze ${dateRaw}`;
		editor.setLine(lineNum, line.replace(/\s{2,}/g, ' ').trimEnd());
		new Notice('Task snoozed.');
	}

	/** Toggle #someday on a line (v3). Turning on strips @due and @snooze (Someday is dateless). */
	private setLineSomeday(editor: Editor, lineNum: number, on: boolean): void {
		let line = editor.getLine(lineNum);
		if (on) {
			line = line.replace(DUE_DATE_REGEX, '').replace(SNOOZE_DATE_REGEX, '');
			if (!SOMEDAY_TAG_REGEX.test(line)) line = `${line.replace(/\s{2,}/g, ' ').trimEnd()} #someday`;
		} else {
			line = line.replace(SOMEDAY_TAG_REGEX, '');
		}
		editor.setLine(lineNum, line.replace(/\s{2,}/g, ' ').trimEnd());
		new Notice(on ? 'Sent to Someday.' : 'Removed from Someday.');
	}

	/** Remove any @snooze and #someday from a line (v3), reactivating the task. */
	private wakeLine(editor: Editor, lineNum: number): void {
		const line = editor.getLine(lineNum);
		const woken = line.replace(SNOOZE_DATE_REGEX, '').replace(SOMEDAY_TAG_REGEX, '').replace(/\s{2,}/g, ' ').trimEnd();
		if (woken === line) { new Notice('Nothing to wake on this line.'); return; }
		editor.setLine(lineNum, woken);
		new Notice('Task woken.');
	}

	onunload(): void {
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_FRIDAY);
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_JIRA_DASHBOARD);
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_TEAM_DASHBOARD);
		this.scanner.destroy();
		// Fire-and-forget — Obsidian doesn't await onunload, but we still want the
		// listening socket released so the next reload can rebind the same port.
		void this.mcpServer?.stop();
	}
}
