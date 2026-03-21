import { TaskStatus, PluginSettings, GroupMode } from '../../types';
import { TaskStore } from '../../services/taskStore';
import { TaskItemRowCallbacks } from './TaskItemRow';
import { TaskList } from './TaskList';

export type OverviewSubView = 'tasks' | 'openPoints';

export class OverviewView {
	private el: HTMLElement;
	private activeSubView: OverviewSubView = 'tasks';

	constructor(
		private container: HTMLElement,
		private store: TaskStore,
		private settings: PluginSettings,
		private callbacks: TaskItemRowCallbacks,
		private groupMode: GroupMode,
		private searchQuery: string = '',
		private collapsedGroups?: Set<string>
	) {
		this.el = container.createDiv({ cls: 'task-bujo-overview-view' });
	}

	render(): void {
		this.el.empty();

		// Sub-view toggle bar
		const toggleBar = this.el.createDiv({ cls: 'task-bujo-overview-toggle' });
		const tabs: { key: OverviewSubView; label: string }[] = [
			{ key: 'tasks', label: 'All Tasks' },
			{ key: 'openPoints', label: 'Open Points' },
		];
		for (const { key, label } of tabs) {
			const btn = toggleBar.createEl('button', {
				cls: 'task-bujo-overview-toggle-btn',
				text: label,
			});
			if (key === this.activeSubView) {
				btn.addClass('task-bujo-overview-toggle-active');
			}
			btn.addEventListener('click', () => {
				if (this.activeSubView !== key) {
					this.activeSubView = key;
					this.render();
				}
			});
		}

		if (this.activeSubView === 'tasks') {
			this.renderAllTasks();
		} else {
			this.renderOpenPoints();
		}
	}

	private renderAllTasks(): void {
		const allTasks = this.store.getTasks();
		let tasks = this.store.filterCompleted(allTasks, this.settings.showCompletedTasks);

		// Apply search
		if (this.searchQuery) {
			const q = this.searchQuery.toLowerCase();
			tasks = tasks.filter(t => t.text.toLowerCase().includes(q));
		}

		const openCount = tasks.filter(t => t.status === TaskStatus.Open).length;

		// Header
		const header = this.el.createDiv({ cls: 'task-bujo-view-header' });
		header.createSpan({ text: 'All Tasks' });
		header.createSpan({ cls: 'task-bujo-pending-count', text: ` (${openCount} open, ${tasks.length} total)` });

		if (tasks.length === 0) {
			this.el.createDiv({ cls: 'task-bujo-empty', text: 'No tasks found' });
			return;
		}

		// Group and render
		const grouped = this.store.groupTasks(tasks, this.groupMode, this.settings.weekStartDay);
		new TaskList(this.el, grouped, this.callbacks, true, this.collapsedGroups, allTasks);
	}

	private renderOpenPoints(): void {
		let openPoints = this.store.filterCompleted(
			this.store.getOpenPoints(),
			this.settings.showCompletedTasks
		);
		let uncategorized = this.store.filterCompleted(
			this.store.getUncategorized(),
			this.settings.showCompletedTasks
		);

		// Apply search
		if (this.searchQuery) {
			const q = this.searchQuery.toLowerCase();
			openPoints = openPoints.filter(t => t.text.toLowerCase().includes(q));
			uncategorized = uncategorized.filter(t => t.text.toLowerCase().includes(q));
		}

		const totalCount = openPoints.length + uncategorized.length;

		// Header
		const header = this.el.createDiv({ cls: 'task-bujo-view-header' });
		header.createSpan({ text: 'Open Points' });
		header.createSpan({ cls: 'task-bujo-pending-count', text: ` (${totalCount})` });

		// Open points grouped
		const allStoreTasks = [...this.store.getOpenPoints(), ...this.store.getUncategorized()];
		const groupedOpenPoints = this.store.groupTasks(openPoints, this.groupMode, this.settings.weekStartDay);
		new TaskList(this.el, groupedOpenPoints, this.callbacks, true, this.collapsedGroups, allStoreTasks);

		// Uncategorized section
		if (uncategorized.length > 0) {
			this.el.createEl('hr', { cls: 'task-bujo-separator' });

			const uncatHeader = this.el.createDiv({ cls: 'task-bujo-view-subheader' });
			uncatHeader.createSpan({ text: `Uncategorized (${uncategorized.length})` });

			const groupedUncat = this.store.groupTasks(uncategorized, this.groupMode, this.settings.weekStartDay);
			new TaskList(this.el, groupedUncat, this.callbacks, true, this.collapsedGroups, allStoreTasks);
		}
	}

	destroy(): void {
		this.el.empty();
	}
}
