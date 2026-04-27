import { Plugin, WorkspaceLeaf, Editor, MarkdownView, Menu, Notice } from 'obsidian';
import { PluginData, DEFAULT_PLUGIN_DATA, PluginSettings, TaskStatus, WeeklySnapshot, MonthlySnapshot, FridayViewMode } from './types';
import { VIEW_TYPE_FRIDAY, VIEW_TYPE_JIRA_DASHBOARD, VIEW_TYPE_TEAM_DASHBOARD, PRIORITY_TAG_REGEX, DUE_DATE_REGEX } from './constants';
import { FridaySettingTab } from './settings';
import { VaultScanner } from './services/vaultScanner';
import { TaskStore } from './services/taskStore';
import { TaskWriter } from './services/taskWriter';
import { DailyNoteService } from './services/dailyNoteService';
import { SprintService } from './services/sprintService';
import { SprintTopicService } from './services/sprintTopicService';
import { MigrationService } from './services/migrationService';
import { AnalyticsService } from './services/analyticsService';
import { MonthlyNoteService } from './services/monthlyNoteService';
import { MonthlyAnalyticsService } from './services/monthlyAnalyticsService';
import { ArchiveService } from './services/archiveService';
import { JiraService } from './services/jiraService';
import { JiraDashboardService } from './services/jiraDashboardService';
import { JiraTeamService } from './services/jiraTeamService';
import { TeamMemberService } from './services/teamMemberService';
import { FridayView } from './ui/FridayView';
import { JiraDashboardView } from './ui/JiraDashboardView';
import { TeamDashboardView } from './ui/TeamDashboardView';
import { MigrationModal } from './ui/MigrationModal';
import { OneOnOneModal } from './ui/OneOnOneModal';
import { WeeklyReviewModal } from './ui/WeeklyReviewModal';
import { MonthlyReviewModal } from './ui/MonthlyReviewModal';
import { InsertTaskModal, buildTaskLine, buildTaskBlock } from './ui/InsertTaskModal';
import { QuickCaptureModal } from './ui/QuickCaptureModal';
import { DueDateModal } from './ui/DueDateModal';
import { SyntaxReferenceModal } from './ui/components/SyntaxReference';
import { getWeekId } from './utils/dateUtils';

export default class FridayPlugin extends Plugin {
	data: PluginData;
	settings: PluginSettings;

	private scanner: VaultScanner;
	private store: TaskStore;
	private writer: TaskWriter;
	private dailyNoteService: DailyNoteService;
	private sprintService: SprintService;
	private sprintTopicService: SprintTopicService;
	private migrationService: MigrationService;
	private analyticsService: AnalyticsService;
	private monthlyNoteService: MonthlyNoteService;
	private monthlyAnalyticsService: MonthlyAnalyticsService;
	private archiveService: ArchiveService;
	jiraService: JiraService;
	jiraDashboardService: JiraDashboardService;
	jiraTeamService: JiraTeamService;
	teamMemberService: TeamMemberService;
	private statusBarEl: HTMLElement;

	async onload(): Promise<void> {
		const saved = await this.loadData();
		this.data = Object.assign({}, DEFAULT_PLUGIN_DATA, saved);
		// Deep-merge settings so new defaults are applied to old saved data
		this.data.settings = Object.assign({}, DEFAULT_PLUGIN_DATA.settings, saved?.settings);
		this.data.weeklyHistory = this.data.weeklyHistory ?? [];
		this.data.lastWeeklyReviewWeek = this.data.lastWeeklyReviewWeek ?? null;
		this.data.monthlyHistory = this.data.monthlyHistory ?? [];

		// Migrate removed view modes: Eisenhower and ImpactEffort (task-level) were repurposed
		// for Topics. Rewrite stale defaultViewMode values so users don't land on a missing case.
		const staleModes = ['eisenhower', 'impactEffort'];
		if (staleModes.includes(this.data.settings.defaultViewMode as string)) {
			this.data.settings.defaultViewMode = FridayViewMode.Topics;
		}
		// `team` was briefly a tab in the Friday view; now a standalone workspace view.
		// Redirect the default so users who had it pinned land on Daily instead of
		// hitting a removed switch case.
		if ((this.data.settings.defaultViewMode as string) === 'team') {
			this.data.settings.defaultViewMode = FridayViewMode.Daily;
		}

		this.settings = this.data.settings;

		this.store = new TaskStore();
		this.writer = new TaskWriter(this.app.vault);
		this.scanner = new VaultScanner(this.app.vault, () => this.settings);
		this.scanner.setWriter(this.writer);
		this.dailyNoteService = new DailyNoteService(this.app.vault, () => this.settings);
		this.sprintService = new SprintService(() => this.data, () => this.saveSettings());
		this.sprintTopicService = new SprintTopicService(this.app.vault, () => this.settings);
		this.migrationService = new MigrationService(
			this.store,
			this.writer,
			this.dailyNoteService,
			() => this.data,
			() => this.saveSettings(),
			() => this.settings
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
				leaf, this.store, this.writer, this.sprintService,
				this.sprintTopicService, this.scanner,
				this.migrationService, this.analyticsService,
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
				() => this.settings,
				// Scanner has no unsubscribe API; the view guards on `contentContainer`
				// being non-null so closures fired post-close are safe.
				(cb) => this.scanner.onTeamChange(cb),
				() => this.activateJiraTeamTab(),
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
				this.sprintService,
				(cb) => this.scanner.onTopicsChange(cb),
				this.jiraTeamService,
			)
		);

		const refs = this.scanner.registerEvents();
		refs.forEach(ref => this.registerEvent(ref));

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
			id: 'run-daily-migration',
			name: 'Run Daily Migration',
			callback: () => this.showMigrationModal(),
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
						// No active editor — append to today's daily note
						await this.dailyNoteService.addRawTaskLine(block, new Date());
						new Notice('Task added to today\'s daily note');
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
				}
			})
		);

		this.addSettingTab(new FridaySettingTab(this.app, this));

		this.app.workspace.onLayoutReady(async () => {
			await this.scanner.fullScan();
			this.store.setTasks(this.scanner.getAllTasks());
			this.updateStatusBar();
			await this.autoGenerateTeamPagesIfNeeded();
			this.checkMigration();
			this.checkWeeklyReview();
		});
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
				const file = await this.teamMemberService.startOneOnOne(member, new Date());
				const leaf = this.app.workspace.getLeaf(false);
				await leaf.openFile(file);
				this.app.workspace.revealLeaf(leaf);
			} catch (e) {
				new Notice(`Could not start 1:1: ${e instanceof Error ? e.message : 'unknown error'}`);
			}
		}).open();
	}

	private checkMigration(): void {
		if (this.settings.migrationPromptOnStartup && this.migrationService.needsMigration()) {
			this.showMigrationModal();
		}
	}

	private showMigrationModal(): void {
		const reviewData = this.migrationService.getMorningReviewData();

		new MigrationModal(
			this.app,
			this.migrationService,
			this.dailyNoteService,
			this.store,
			reviewData,
			(_result) => {
				// Migration completed — views will auto-refresh via store events
			},
			this.teamMemberService,
			this.sprintTopicService,
			this.settings,
		).open();
	}

	private updateStatusBar(): void {
		this.statusBarEl.setText(`${this.store.getPendingCount()} pending`);
	}

	private showWeeklyReview(): void {
		new WeeklyReviewModal(
			this.app,
			this.analyticsService,
			this.settings,
			this.data.weeklyHistory,
			(snapshot) => this.saveWeeklySnapshot(snapshot),
		).open();
	}

	/** Check if a new week has started and auto-prompt weekly review */
	private checkWeeklyReview(): void {
		const currentWeekId = getWeekId(new Date());
		if (this.data.lastWeeklyReviewWeek === currentWeekId) return;

		// New week detected — auto-snapshot previous week if there's data
		if (this.data.lastWeeklyReviewWeek !== null) {
			// Compute stats for previous week and show review
			this.showWeeklyReview();
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

	onunload(): void {
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_FRIDAY);
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_JIRA_DASHBOARD);
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_TEAM_DASHBOARD);
		this.scanner.destroy();
	}
}
