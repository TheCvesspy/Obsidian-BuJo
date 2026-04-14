import { Plugin, WorkspaceLeaf, Editor, MarkdownView, Menu, Notice } from 'obsidian';
import { PluginData, DEFAULT_PLUGIN_DATA, PluginSettings, TaskStatus, WeeklySnapshot, MonthlySnapshot, BuJoViewMode } from './types';
import { VIEW_TYPE_TASK_BUJO, VIEW_TYPE_JIRA_DASHBOARD, PRIORITY_TAG_REGEX, DUE_DATE_REGEX } from './constants';
import { TaskBuJoSettingTab } from './settings';
import { VaultScanner } from './services/vaultScanner';
import { TaskStore } from './services/taskStore';
import { TaskWriter } from './services/taskWriter';
import { DailyNoteService } from './services/dailyNoteService';
import { SprintService } from './services/sprintService';
import { SprintTopicService } from './services/sprintTopicService';
import { MigrationService } from './services/migrationService';
import { AnalyticsService } from './services/analyticsService';
import { MonthlyNoteService } from './services/monthlyNoteService';
import { MonthlyMigrationService } from './services/monthlyMigrationService';
import { MonthlyAnalyticsService } from './services/monthlyAnalyticsService';
import { ArchiveService } from './services/archiveService';
import { JiraService } from './services/jiraService';
import { JiraDashboardService } from './services/jiraDashboardService';
import { TaskBuJoView } from './ui/TaskBuJoView';
import { JiraDashboardView } from './ui/JiraDashboardView';
import { MigrationModal } from './ui/MigrationModal';
import { WeeklyReviewModal } from './ui/WeeklyReviewModal';
import { MonthlyMigrationModal } from './ui/MonthlyMigrationModal';
import { MonthlyReviewModal } from './ui/MonthlyReviewModal';
import { InsertTaskModal, buildTaskLine, buildTaskBlock } from './ui/InsertTaskModal';
import { DueDateModal } from './ui/DueDateModal';
import { SyntaxReferenceModal } from './ui/components/SyntaxReference';
import { getWeekId } from './utils/dateUtils';

export default class TaskBuJoPlugin extends Plugin {
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
	private monthlyMigrationService: MonthlyMigrationService;
	private monthlyAnalyticsService: MonthlyAnalyticsService;
	private archiveService: ArchiveService;
	jiraService: JiraService;
	jiraDashboardService: JiraDashboardService;
	private statusBarEl: HTMLElement;

	async onload(): Promise<void> {
		const saved = await this.loadData();
		this.data = Object.assign({}, DEFAULT_PLUGIN_DATA, saved);
		// Deep-merge settings so new defaults are applied to old saved data
		this.data.settings = Object.assign({}, DEFAULT_PLUGIN_DATA.settings, saved?.settings);
		this.data.weeklyHistory = this.data.weeklyHistory ?? [];
		this.data.lastWeeklyReviewWeek = this.data.lastWeeklyReviewWeek ?? null;
		this.data.lastMonthlyMigrationMonth = this.data.lastMonthlyMigrationMonth ?? null;
		this.data.monthlyHistory = this.data.monthlyHistory ?? [];

		// Migrate removed view modes: Eisenhower and ImpactEffort (task-level) were repurposed
		// for Topics. Rewrite stale defaultViewMode values so users don't land on a missing case.
		const staleModes = ['eisenhower', 'impactEffort'];
		if (staleModes.includes(this.data.settings.defaultViewMode as string)) {
			this.data.settings.defaultViewMode = BuJoViewMode.Topics;
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
		this.monthlyMigrationService = new MonthlyMigrationService(
			this.store,
			this.writer,
			this.monthlyNoteService,
			() => this.data,
			() => this.saveSettings(false),
			() => this.settings,
		);
		this.monthlyAnalyticsService = new MonthlyAnalyticsService(
			this.store,
			() => this.settings,
			() => this.data,
		);
		this.archiveService = new ArchiveService(this.app.vault, this.store, () => this.settings);
		this.jiraService = new JiraService(() => this.settings);
		this.jiraDashboardService = new JiraDashboardService(() => this.settings);

		this.scanner.onChange(() => {
			this.store.setTasks(this.scanner.getAllTasks());
			this.updateStatusBar();
		});

		// Topic changes also trigger view refresh — bump store version to invalidate fingerprint
		this.scanner.onTopicsChange(() => {
			this.store.setTasks(this.scanner.getAllTasks());
		});

		this.registerView(VIEW_TYPE_TASK_BUJO, (leaf) =>
			new TaskBuJoView(
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
			)
		);

		const refs = this.scanner.registerEvents();
		refs.forEach(ref => this.registerEvent(ref));

		this.addRibbonIcon('check-square', 'Open BuJo', () => this.activateView());
		this.addRibbonIcon('layout-dashboard', 'Open JIRA Dashboard', () => this.activateJiraDashboard());

		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.setText('BuJo ...');

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
			id: 'refresh-jira-dashboard',
			name: 'Refresh JIRA Dashboard',
			callback: () => this.jiraDashboardService.refresh(),
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
			id: 'run-monthly-migration',
			name: 'Run Monthly Migration',
			callback: () => this.showMonthlyMigrationModal(),
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
			id: 'archive-completed',
			name: 'Archive Completed Tasks',
			callback: async () => {
				const result = await this.archiveService.archiveCompleted();
				if (result.archived === 0) {
					new Notice('No completed tasks to archive.');
				} else {
					new Notice(`Archived ${result.archived} task(s) to ${result.files.length} file(s).`);
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

		// Right-click editor context menu
		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu: Menu, editor: Editor) => {
				// Always offer "Quick create task"
				menu.addItem(item => {
					item.setTitle('BuJo: Quick create task')
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
						item.setTitle(isDone ? 'BuJo: Mark as open' : 'BuJo: Mark as done')
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
							item.setTitle(`BuJo: ${label}`)
								.setIcon(icon)
								.onClick(() => {
									this.setLinePriority(editor, cursor.line, val);
								});
						});
					}

					menu.addItem(item => {
						item.setTitle('BuJo: Remove priority')
							.setIcon('x')
							.onClick(() => {
								this.setLinePriority(editor, cursor.line, null);
							});
					});

					// Set due date
					menu.addItem(item => {
						item.setTitle('BuJo: Set due date')
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

		this.addSettingTab(new TaskBuJoSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(async () => {
			await this.scanner.fullScan();
			this.store.setTasks(this.scanner.getAllTasks());
			this.updateStatusBar();
			this.checkMigration();
			this.checkWeeklyReview();
			this.checkMonthlyMigration();
		});
	}

	async activateView(newTab = false): Promise<void> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(VIEW_TYPE_TASK_BUJO);

		if (leaves.length > 0 && !newTab) {
			leaf = leaves[0];
		} else {
			leaf = workspace.getLeaf(true);
			if (leaf) await leaf.setViewState({ type: VIEW_TYPE_TASK_BUJO, active: true });
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

	private checkMigration(): void {
		if (this.settings.migrationPromptOnStartup && this.migrationService.needsMigration()) {
			this.showMigrationModal();
		}
	}

	private showMigrationModal(): void {
		const reviewData = this.migrationService.getMorningReviewData();

		new MigrationModal(this.app, this.migrationService, this.dailyNoteService, this.store, reviewData, (_result) => {
			// Migration completed — views will auto-refresh via store events
		}).open();
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
		this.updateStatusBar();
	}

	private checkMonthlyMigration(): void {
		if (this.settings.monthlyMigrationPromptOnStartup && this.monthlyMigrationService.needsMonthlyMigration()) {
			this.showMonthlyMigrationModal();
		}
	}

	private showMonthlyMigrationModal(): void {
		const reviewData = this.monthlyMigrationService.getMonthlyReviewData();

		new MonthlyMigrationModal(this.app, this.monthlyMigrationService, this.store, reviewData, (_result) => {
			// Monthly migration completed — views will auto-refresh via store events
		}).open();
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
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_TASK_BUJO);
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_JIRA_DASHBOARD);
		this.scanner.destroy();
	}
}
