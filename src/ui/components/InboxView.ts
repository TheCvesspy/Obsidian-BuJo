import { TaskStatus, PluginSettings, GroupMode } from '../../types';
import { TaskStore } from '../../services/taskStore';
import { TaskItemRowCallbacks } from './TaskItemRow';
import { TaskList } from './TaskList';

export class InboxView {
	private el: HTMLElement;

	constructor(
		container: HTMLElement,
		private store: TaskStore,
		private settings: PluginSettings,
		private callbacks: TaskItemRowCallbacks,
		private groupMode: GroupMode,
		private searchQuery: string = '',
		private collapsedGroups?: Set<string>,
	) {
		this.el = container.createDiv({ cls: 'friday-inbox-view' });
	}

	render(): void {
		this.el.empty();

		let items = this.store.filterCompleted(
			this.store.getInbox(),
			this.settings.showCompletedTasks,
		);

		if (this.searchQuery) {
			const q = this.searchQuery.toLowerCase();
			items = items.filter(t => t.text.toLowerCase().includes(q));
		}

		const openCount = items.filter(t => t.status === TaskStatus.Open).length;

		const header = this.el.createDiv({ cls: 'friday-view-header' });
		header.createSpan({ text: '\u{1F4E5} Inbox' });
		header.createSpan({
			cls: 'friday-pending-count',
			text: ` (${openCount} to triage, ${items.length} total)`,
		});

		if (items.length === 0) {
			this.el.createDiv({
				cls: 'friday-empty',
				text: 'Nothing to triage — capture new items under `## Inbox` in your daily note.',
			});
			return;
		}

		const grouped = this.store.groupTasks(items, this.groupMode, this.settings.weekStartDay);
		new TaskList(this.el, grouped, this.callbacks, true, this.collapsedGroups, this.store.getInbox());
	}

	destroy(): void {
		this.el.empty();
	}
}
