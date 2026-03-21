import { TaskItem } from '../../types';
import { GroupHeader } from './GroupHeader';
import { TaskItemRow, TaskItemRowCallbacks } from './TaskItemRow';

export class TaskList {
	private el: HTMLElement;
	private collapsedTasks: Set<string> = new Set();
	private taskByIdMap: Map<string, TaskItem> = new Map();

	constructor(
		container: HTMLElement,
		private groupedTasks: Map<string, TaskItem[]>,
		private callbacks: TaskItemRowCallbacks,
		private collapsible: boolean = true,
		private collapsedGroups?: Set<string>,
		private allTasks?: TaskItem[]
	) {
		this.el = container.createDiv({ cls: 'task-bujo-task-list' });
		this.buildLookup();
		this.setupCallbacks();
		this.render();
	}

	/** Build the task-by-ID lookup from all available tasks */
	private buildLookup(): void {
		this.taskByIdMap.clear();
		// Include all tasks (from allTasks if provided, or from grouped tasks)
		if (this.allTasks) {
			for (const t of this.allTasks) {
				this.taskByIdMap.set(t.id, t);
			}
		}
		for (const tasks of this.groupedTasks.values()) {
			for (const t of tasks) {
				this.taskByIdMap.set(t.id, t);
			}
		}
	}

	/** Wrap callbacks with hierarchy-aware getTaskById and onToggleCollapse */
	private setupCallbacks(): void {
		const originalCallbacks = this.callbacks;
		this.callbacks = {
			...originalCallbacks,
			getTaskById: (id: string) => this.taskByIdMap.get(id),
			onToggleCollapse: (taskId: string) => {
				if (this.collapsedTasks.has(taskId)) {
					this.collapsedTasks.delete(taskId);
				} else {
					this.collapsedTasks.add(taskId);
				}
				this.render();
			},
		};
	}

	private render(): void {
		this.el.empty();

		if (this.groupedTasks.size === 0) {
			this.el.createDiv({
				cls: 'task-bujo-empty',
				text: 'No tasks found'
			});
			return;
		}

		for (const [label, tasks] of this.groupedTasks) {
			const group = new GroupHeader(this.el, label, tasks.length, this.collapsible, this.collapsedGroups);
			const contentEl = group.getContentEl();

			for (const task of tasks) {
				this.renderTaskTree(contentEl, task);
			}
		}
	}

	/** Recursively render a task and its children */
	private renderTaskTree(container: HTMLElement, task: TaskItem): void {
		const isCollapsed = this.collapsedTasks.has(task.id);
		new TaskItemRow(container, task, this.callbacks, isCollapsed);

		// Render children if expanded
		if (task.childrenIds.length > 0 && !isCollapsed) {
			for (const childId of task.childrenIds) {
				const child = this.taskByIdMap.get(childId);
				if (child) {
					this.renderTaskTree(container, child);
				}
			}
		}
	}

	/** Re-render with new data */
	update(groupedTasks: Map<string, TaskItem[]>, allTasks?: TaskItem[]): void {
		this.groupedTasks = groupedTasks;
		if (allTasks) {
			this.allTasks = allTasks;
		}
		this.buildLookup();
		this.render();
	}

	getElement(): HTMLElement {
		return this.el;
	}
}
