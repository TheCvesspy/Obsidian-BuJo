import { PluginSettings } from '../../types';
import { TaskStore } from '../../services/taskStore';
import { TaskItemRowCallbacks } from './TaskItemRow';
import { TaskList } from './TaskList';

/**
 * The dateless backlog (v3). `#someday` tasks live only here — out of Today, Upcoming and
 * Overdue — for periodic review. Wake one (give it a date or drop #someday) to reactivate it.
 */
export class SomedayView {
	private el: HTMLElement;

	constructor(
		private container: HTMLElement,
		private store: TaskStore,
		private settings: PluginSettings,
		private callbacks: TaskItemRowCallbacks,
		private searchQuery: string = '',
	) {
		this.el = container.createDiv({ cls: 'friday-someday-view' });
	}

	render(): void {
		this.el.empty();

		let items = this.store.getSomedayTasks();
		if (this.searchQuery) {
			const q = this.searchQuery.toLowerCase();
			items = items.filter(t => t.text.toLowerCase().includes(q));
		}

		const header = this.el.createDiv({ cls: 'friday-view-header' });
		header.createSpan({ text: '🗓️ Someday' });
		header.createSpan({ cls: 'friday-pending-count', text: ` (${items.length})` });

		if (items.length === 0) {
			this.el.createDiv({
				cls: 'friday-empty',
				text: 'No someday/maybe items. Send a task here when it matters but has no timeline.',
			});
			return;
		}

		const grouped = this.store.groupTasks(items, this.settings.defaultGroupMode, this.settings.weekStartDay);
		new TaskList(this.el, grouped, this.callbacks, true, undefined, this.store.getTasks());
	}

	destroy(): void {
		this.el.empty();
	}
}
