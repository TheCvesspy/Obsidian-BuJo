import { ItemView, WorkspaceLeaf, MarkdownView } from 'obsidian';
import { BuJoViewMode, GroupMode, TaskItem, TaskStatus, PluginSettings, PluginData, Sprint, SprintTopic, WeeklySnapshot, MonthlySnapshot, StoreEventCallback } from '../types';
import { VIEW_TYPE_TASK_BUJO, REFRESH_DEBOUNCE_MS } from '../constants';
import { TaskStore } from '../services/taskStore';
import { TaskWriter } from '../services/taskWriter';
import { SprintService } from '../services/sprintService';
import { SprintTopicService } from '../services/sprintTopicService';
import { MigrationService } from '../services/migrationService';
import { AnalyticsService } from '../services/analyticsService';
import { MonthlyAnalyticsService } from '../services/monthlyAnalyticsService';
import { MonthlyNoteService } from '../services/monthlyNoteService';
import { VaultScanner } from '../services/vaultScanner';
import { ViewSwitcher } from './components/ViewSwitcher';
import { Toolbar } from './components/Toolbar';
import { DailyView } from './components/DailyView';
import { WeeklyView } from './components/WeeklyView';
import { MonthlyView } from './components/MonthlyView';
import { SprintView } from './components/SprintView';
import { OverviewView } from './components/OpenPointsView';
import { OverdueView } from './components/OverdueView';
import { AnalyticsView } from './components/AnalyticsView';
import { SyntaxReferenceModal } from './components/SyntaxReference';
import { AddTaskBar } from './components/AddTaskBar';
import { SprintModal } from './SprintModal';
import { SprintTopicModal } from './SprintTopicModal';
import { SprintCloseModal } from './SprintCloseModal';
import { TaskItemRowCallbacks } from './components/TaskItemRow';
import { SubtaskConfirmModal } from './SubtaskConfirmModal';

export class TaskBuJoView extends ItemView {
	private currentMode: BuJoViewMode;
	private currentGroupMode: GroupMode;
	private searchQuery: string = '';
	private contentContainer: HTMLElement;
	private toolbar: Toolbar | null = null;
	private storeCallback: StoreEventCallback | null = null;
	private refreshTimer: ReturnType<typeof setTimeout> | null = null;
	private collapsedGroups: Set<string> = new Set();
	private lastStoreVersion: number = -1;
	private lastViewFingerprint: string = '';
	private isDragging = { value: false };

	constructor(
		leaf: WorkspaceLeaf,
		private store: TaskStore,
		private writer: TaskWriter,
		private sprintService: SprintService,
		private sprintTopicService: SprintTopicService,
		private scanner: VaultScanner,
		private migrationService: MigrationService,
		private analyticsService: AnalyticsService,
		private monthlyAnalyticsService: MonthlyAnalyticsService,
		private monthlyNoteService: MonthlyNoteService,
		private settings: PluginSettings,
		private getData: () => PluginData,
		private onSaveSnapshot: (snapshot: WeeklySnapshot) => void,
		private onSaveMonthlySnapshot: (snapshot: MonthlySnapshot) => void,
	) {
		super(leaf);
		this.currentMode = settings.defaultViewMode;
		this.currentGroupMode = settings.defaultGroupMode;
	}

	getViewType(): string {
		return VIEW_TYPE_TASK_BUJO;
	}

	getDisplayText(): string {
		return 'BuJo';
	}

	getIcon(): string {
		return 'check-square';
	}

	async onOpen(): Promise<void> {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass('task-bujo-container');

		new ViewSwitcher(containerEl, this.currentMode, {
			onViewChange: (mode: BuJoViewMode) => {
				this.currentMode = mode;
				// Update toolbar for new view mode
				if (this.toolbar) {
					this.toolbar.setViewMode(mode);
				}
				this.refresh();
			},
		});

		this.toolbar = new Toolbar(containerEl, this.currentGroupMode, this.currentMode, {
			onGroupModeChange: (mode: GroupMode) => {
				this.currentGroupMode = mode;
				this.refresh();
			},
			onSearchChange: (query: string) => {
				this.searchQuery = query;
				this.refresh();
			},
		});

		this.contentContainer = containerEl.createDiv({ cls: 'task-bujo-content' });

		// Add Task quick-add bar
		new AddTaskBar(containerEl, this.app, () => this.settings, {
			onTaskAdded: () => this.refresh(),
		});

		// Syntax reference button
		const syntaxBtn = containerEl.createEl('button', {
			cls: 'task-bujo-syntax-toggle',
			text: 'Syntax Reference',
		});
		syntaxBtn.addEventListener('click', () => {
			new SyntaxReferenceModal(this.app).open();
		});

		this.storeCallback = () => this.scheduleRefresh();
		this.store.on(this.storeCallback);

		this.refresh();
	}

	private get taskCallbacks(): TaskItemRowCallbacks {
		return {
			onToggle: async (task: TaskItem) => {
				const newStatus = task.status === TaskStatus.Open
					? TaskStatus.Done
					: TaskStatus.Open;

				// If completing/cancelling a parent with open children, ask for confirmation
				if (newStatus === TaskStatus.Done && task.childrenIds.length > 0) {
					const openChildren = task.childrenIds
						.map(id => this.store.getTaskById(id))
						.filter((c): c is TaskItem => c !== undefined && c.status === TaskStatus.Open);

					if (openChildren.length > 0) {
						const modal = new SubtaskConfirmModal(this.app, task, openChildren.length, 'Complete');
						const result = await modal.waitForResult();
						if (result === 'cancel') return;
						if (result === 'all') {
							// Batch complete: parent + all open children
							await this.writer.setStatusBatch([task, ...openChildren], newStatus);
							return;
						}
						// 'parent-only': fall through to single setStatus
					}
				}

				await this.writer.setStatus(task, newStatus);
			},
			onClickSource: async (task: TaskItem) => {
				const file = this.app.vault.getAbstractFileByPath(task.sourcePath);
				if (!file) return;

				// Reuse existing leaf if the file is already open
				let leaf: WorkspaceLeaf | null = null;
				this.app.workspace.iterateAllLeaves(l => {
					if (!leaf && l.view instanceof MarkdownView && l.view.file?.path === task.sourcePath) {
						leaf = l;
					}
				});
				if (!leaf) {
					leaf = this.app.workspace.getLeaf(false);
				}

				await leaf.openFile(file as any);
				this.app.workspace.revealLeaf(leaf);
				const view = leaf.view as any;
				if (view?.editor) {
					view.editor.setCursor({ line: task.lineNumber, ch: 0 });
					view.editor.scrollIntoView(
						{ from: { line: task.lineNumber, ch: 0 }, to: { line: task.lineNumber, ch: 0 } },
						true
					);
				}
			},
		};
	}

	/** Coalesce rapid store events into a single refresh */
	private scheduleRefresh(): void {
		// Suppress refresh during drag-and-drop to prevent board rebuilds mid-drag
		if (this.isDragging.value) return;
		if (this.refreshTimer !== null) {
			clearTimeout(this.refreshTimer);
		}
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = null;
			this.refresh();
		}, REFRESH_DEBOUNCE_MS);
	}

	private refresh(): void {
		// Skip rebuild if data hasn't changed
		const fingerprint = `${this.currentMode}|${this.currentGroupMode}|${this.searchQuery}|${this.store.version}`;
		if (fingerprint === this.lastViewFingerprint) return;
		this.lastViewFingerprint = fingerprint;

		this.contentContainer.empty();

		switch (this.currentMode) {
			case BuJoViewMode.Daily: {
				const view = new DailyView(this.contentContainer, this.store, this.settings, this.taskCallbacks, this.searchQuery);
				view.render();
				break;
			}
			case BuJoViewMode.Weekly: {
				const view = new WeeklyView(this.contentContainer, this.store, this.settings, this.taskCallbacks, this.searchQuery);
				view.render();
				break;
			}
			case BuJoViewMode.Monthly: {
				const view = new MonthlyView(
					this.contentContainer,
					this.store,
					this.monthlyAnalyticsService,
					this.monthlyNoteService,
					this.settings,
					this.taskCallbacks,
					this.searchQuery,
					this.getData,
					this.onSaveMonthlySnapshot,
					this.collapsedGroups,
				);
				view.render();
				break;
			}
			case BuJoViewMode.Sprint: {
				const activeSprint = this.sprintService.getActiveSprint();
				const topics = activeSprint
					? this.scanner.getAllTopics().filter(t => t.sprintId === activeSprint.id)
					: [];
				const view = new SprintView(
					this.contentContainer,
					this.store,
					this.sprintService,
					this.sprintTopicService,
					topics,
					this.settings,
					() => this.onNewSprint(),
					(sprint: Sprint) => this.onEndSprint(sprint),
					() => this.onNewTopic(),
					(topic: SprintTopic) => this.onTopicClick(topic),
					this.isDragging,
					this.searchQuery,
				);
				view.render();
				break;
			}
			case BuJoViewMode.Overdue: {
				const view = new OverdueView(this.contentContainer, this.store, this.settings, this.taskCallbacks, this.currentGroupMode, this.searchQuery, this.collapsedGroups);
				view.render();
				break;
			}
			case BuJoViewMode.Overview: {
				const view = new OverviewView(this.contentContainer, this.store, this.settings, this.taskCallbacks, this.currentGroupMode, this.searchQuery, this.collapsedGroups);
				view.render();
				break;
			}
			case BuJoViewMode.Analytics: {
				const view = new AnalyticsView(
					this.contentContainer,
					this.store,
					this.analyticsService,
					this.settings,
					this.getData().weeklyHistory,
					this.onSaveSnapshot,
				);
				view.render();
				break;
			}
		}
	}

	private onNewSprint(): void {
		new SprintModal(this.app, this.sprintService, this.settings, (_sprint: Sprint) => {
			this.refresh();
		}).open();
	}

	private onEndSprint(sprint: Sprint): void {
		const topics = this.scanner.getAllTopics().filter(t => t.sprintId === sprint.id);
		new SprintCloseModal(
			this.app,
			sprint,
			topics,
			this.sprintService,
			this.sprintTopicService,
			() => this.refresh(),
		).open();
	}

	private onNewTopic(): void {
		const activeSprint = this.sprintService.getActiveSprint();
		if (!activeSprint) return;
		new SprintTopicModal(
			this.app,
			this.sprintTopicService,
			activeSprint.id,
			(_topic: SprintTopic) => this.refresh(),
		).open();
	}

	private async onTopicClick(topic: SprintTopic): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(topic.filePath);
		if (!file) return;

		const leaf = this.app.workspace.getLeaf(false);
		await leaf.openFile(file as any);
		this.app.workspace.revealLeaf(leaf);
	}

	async onClose(): Promise<void> {
		if (this.toolbar) {
			this.toolbar.destroy();
			this.toolbar = null;
		}
		if (this.refreshTimer !== null) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}
		if (this.storeCallback) {
			this.store.off(this.storeCallback);
			this.storeCallback = null;
		}
	}
}
