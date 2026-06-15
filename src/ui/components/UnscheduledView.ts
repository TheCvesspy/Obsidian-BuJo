import { PluginSettings, GroupMode } from '../../types';
import { TaskStore } from '../../services/taskStore';
import { TaskItemRowCallbacks } from './TaskItemRow';
import { TaskList } from './TaskList';

/** Top-level view of every open root task with no due date. Mirrors OverdueView
 *  — same group-mode + search-query plumbing — but pulls from
 *  `store.getUnscheduledTasks()`. Replaces the per-section "Unscheduled" bucket
 *  that used to live inside DailyView; pulling it out as its own tab lets the
 *  user scope all the date-grouping / page-grouping affordances to the
 *  backlog of un-dated work without crowding the daily overview. */
export class UnscheduledView {
	private el: HTMLElement;

	constructor(
		private container: HTMLElement,
		private store: TaskStore,
		private settings: PluginSettings,
		private callbacks: TaskItemRowCallbacks,
		private groupMode: GroupMode,
		private searchQuery: string,
		private collapsedGroups?: Set<string>,
	) {
		this.el = container.createDiv({ cls: 'friday-unscheduled-view' });
	}

	render(): void {
		this.el.empty();

		let unscheduled = this.store.getUnscheduledTasks();

		if (this.searchQuery) {
			const q = this.searchQuery.toLowerCase();
			unscheduled = unscheduled.filter(t => t.text.toLowerCase().includes(q));
		}

		const header = this.el.createDiv({ cls: 'friday-view-header' });
		header.createSpan({ text: 'Unscheduled Tasks' });
		header.createSpan({
			cls: 'friday-pending-count',
			text: ` (${unscheduled.length})`,
		});

		if (unscheduled.length === 0) {
			this.el.createDiv({
				cls: 'friday-empty',
				text: 'No unscheduled tasks — every open task has a due date.',
			});
			return;
		}

		const grouped = this.store.groupTasks(unscheduled, this.groupMode);
		new TaskList(this.el, grouped, this.callbacks, true, this.collapsedGroups, this.store.getTasks());
	}

	destroy(): void {
		this.el.empty();
	}
}
