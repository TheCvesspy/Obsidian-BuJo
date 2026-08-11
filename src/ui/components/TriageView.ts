import { PluginSettings } from '../../types';
import { TaskStore } from '../../services/taskStore';
import { TaskItemRowCallbacks } from './TaskItemRow';
import { TaskList } from './TaskList';

/**
 * The inbox to empty (v3). Loose, undecided items — no date, no Topic link — drawn from the
 * central Tasks.md and any daily-note ## Inbox captures. The goal is an empty list: date it,
 * snooze it, send it to a Topic, or drop it.
 */
export class TriageView {
	private el: HTMLElement;

	constructor(
		private container: HTMLElement,
		private store: TaskStore,
		private settings: PluginSettings,
		private callbacks: TaskItemRowCallbacks,
		private searchQuery: string = '',
	) {
		this.el = container.createDiv({ cls: 'friday-triage-view' });
	}

	render(): void {
		this.el.empty();

		let items = this.store.getTriage(this.settings.tasksFilePath);
		if (this.searchQuery) {
			const q = this.searchQuery.toLowerCase();
			items = items.filter(t => t.text.toLowerCase().includes(q));
		}

		const header = this.el.createDiv({ cls: 'friday-view-header' });
		header.createSpan({ text: '📥 Triage' });
		header.createSpan({ cls: 'friday-pending-count', text: ` (${items.length} to sort)` });

		if (items.length === 0) {
			this.el.createDiv({
				cls: 'friday-empty',
				text: 'Inbox zero. Capture loose thoughts to Tasks.md or a daily-note ## Inbox and they land here.',
			});
			return;
		}

		// Group by source so daily captures and Tasks.md items are visually separated.
		const grouped = this.store.groupTasks(items, this.settings.defaultGroupMode, this.settings.weekStartDay);
		new TaskList(this.el, grouped, this.callbacks, true, undefined, this.store.getTasks());
	}

	destroy(): void {
		this.el.empty();
	}
}
