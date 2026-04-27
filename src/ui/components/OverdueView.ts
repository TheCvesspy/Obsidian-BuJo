import { PluginSettings, GroupMode } from '../../types';
import { TaskStore } from '../../services/taskStore';
import { TaskItemRowCallbacks } from './TaskItemRow';
import { TaskList } from './TaskList';

export class OverdueView {
	private el: HTMLElement;

	constructor(
		private container: HTMLElement,
		private store: TaskStore,
		private settings: PluginSettings,
		private callbacks: TaskItemRowCallbacks,
		private groupMode: GroupMode,
		private searchQuery: string,
		private collapsedGroups?: Set<string>
	) {
		this.el = container.createDiv({ cls: 'friday-overdue-view' });
	}

	render(): void {
		this.el.empty();

		let overdue = this.store.getOverdueTasks();

		// Apply search filter
		if (this.searchQuery) {
			const q = this.searchQuery.toLowerCase();
			overdue = overdue.filter(t => t.text.toLowerCase().includes(q));
		}

		// Header
		const header = this.el.createDiv({ cls: 'friday-view-header' });
		header.createSpan({ text: 'Overdue Tasks' });
		header.createSpan({
			cls: 'friday-pending-count',
			text: ` (${overdue.length})`
		});

		if (overdue.length === 0) {
			this.el.createDiv({
				cls: 'friday-empty',
				text: 'No overdue tasks — you\'re all caught up!'
			});
			return;
		}

		// Group and render
		const grouped = this.store.groupTasks(overdue, this.groupMode);
		new TaskList(this.el, grouped, this.callbacks, true, this.collapsedGroups, this.store.getTasks());
	}

	destroy(): void {
		this.el.empty();
	}
}
