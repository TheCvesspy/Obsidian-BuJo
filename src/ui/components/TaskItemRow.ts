import { TaskItem, TaskStatus, Priority } from '../../types';
import { isOverdue } from '../../utils/dateUtils';
import { formatDateDisplay } from '../../utils/dateUtils';
import { createPriorityDot, createDueBadge, createSourceLink, createStatusMarker } from '../icons';
import { resolveEffectiveMetadata, getChildProgress } from '../../utils/taskHierarchy';

export interface TaskItemRowCallbacks {
	onToggle: (task: TaskItem) => void;
	onClickSource: (task: TaskItem) => void;
	onToggleCollapse?: (taskId: string) => void;
	getTaskById?: (id: string) => TaskItem | undefined;
	/** Open the snooze menu for a task (v3). When provided, a ⏰ action renders on open rows. */
	onSnooze?: (task: TaskItem, evt: MouseEvent) => void;
	/** Defer a task to Someday (v3). When provided, a 💤 action renders on eligible rows. */
	onSomeday?: (task: TaskItem) => void;
	/** Wake a task — clears snooze and/or #someday (v3). Rendered on snoozed/someday rows. */
	onWake?: (task: TaskItem) => void;
}

export class TaskItemRow {
	private el: HTMLElement;

	constructor(
		container: HTMLElement,
		private task: TaskItem,
		private callbacks: TaskItemRowCallbacks,
		private collapsed?: boolean
	) {
		this.el = container.createDiv({ cls: 'friday-task-row' });
		if (task.indentLevel > 0) {
			this.el.dataset.indent = String(task.indentLevel);
			this.el.style.paddingLeft = `${task.indentLevel * 24}px`;
			this.el.addClass('friday-subtask-row');
		}
		this.render();
	}

	private render(): void {
		const { task, callbacks } = this;
		const getParent = callbacks.getTaskById ?? (() => undefined);
		const isParent = task.childrenIds.length > 0;
		const isCollapsed = this.collapsed ?? false;

		// Collapse/expand toggle for parent tasks
		if (isParent) {
			const toggle = this.el.createSpan({ cls: 'friday-subtask-toggle' });
			toggle.textContent = isCollapsed ? '▶' : '▼';
			toggle.addEventListener('click', (e) => {
				e.stopPropagation();
				callbacks.onToggleCollapse?.(task.id);
			});
		}

		// Checkbox
		const checkbox = this.el.createEl('input', { type: 'checkbox' });
		checkbox.checked = task.status === TaskStatus.Done;
		checkbox.disabled = task.status === TaskStatus.Migrated ||
			task.status === TaskStatus.Cancelled;
		checkbox.addClass('friday-checkbox');
		checkbox.addEventListener('change', () => {
			this.callbacks.onToggle(task);
		});

		// Status marker for migrated/scheduled/cancelled
		if (task.status !== TaskStatus.Open && task.status !== TaskStatus.Done) {
			this.el.appendChild(createStatusMarker(task.status));
		}

		// Resolve effective metadata (inherit from parent if unset)
		const meta = resolveEffectiveMetadata(task, getParent);

		// Priority dot (using resolved priority)
		if (meta.priority !== Priority.None) {
			this.el.appendChild(createPriorityDot(meta.priority));
		}

		// Task text
		const textSpan = this.el.createSpan({ cls: 'friday-task-text' });
		textSpan.textContent = task.text;

		// Apply styling for completed/migrated/cancelled
		if (task.status === TaskStatus.Done || task.status === TaskStatus.Cancelled) {
			textSpan.addClass('friday-task-done');
		}
		if (task.status === TaskStatus.Migrated) {
			textSpan.addClass('friday-task-migrated');
		}

		// Description toggle indicator
		if (task.description) {
			const descToggle = this.el.createSpan({ cls: 'friday-desc-toggle' });
			descToggle.textContent = '…';
			descToggle.setAttribute('title', 'Show/hide description');
		}

		// Progress badge for collapsed parents
		if (isParent && isCollapsed && callbacks.getTaskById) {
			const progress = getChildProgress(task, callbacks.getTaskById);
			const badge = this.el.createSpan({ cls: 'friday-subtask-progress' });
			badge.textContent = `${progress.completed}/${progress.total}`;
		}

		// Due date badge (using resolved due date)
		if (meta.dueDate) {
			const overdue = task.status === TaskStatus.Open && isOverdue(meta.dueDate);
			this.el.appendChild(createDueBadge(formatDateDisplay(meta.dueDate), overdue));
		}

		// Snooze badge (v3): a snoozed task shows when it wakes; clicking it wakes it now.
		if (task.snoozeDate && task.status === TaskStatus.Open) {
			const badge = this.el.createSpan({ cls: 'friday-snooze-badge' });
			badge.textContent = `💤 ${formatDateDisplay(task.snoozeDate)}`;
			badge.setAttribute('title', 'Snoozed — click to wake now');
			if (callbacks.onWake) {
				badge.addClass('friday-clickable');
				badge.addEventListener('click', (e) => { e.stopPropagation(); callbacks.onWake!(task); });
			}
		}

		// Row actions (v3): snooze / someday / wake. Only rendered when the host view wires
		// the callbacks (Today/Upcoming/Triage/Someday do; legacy views don't).
		if (task.status === TaskStatus.Open) {
			const isDeferred = task.someday || task.snoozeDate != null;
			if (callbacks.onSnooze && !isDeferred) {
				const btn = this.el.createSpan({ cls: 'friday-row-action', text: '⏰' });
				btn.setAttribute('title', 'Snooze…');
				btn.addEventListener('click', (e) => { e.stopPropagation(); callbacks.onSnooze!(task, e as MouseEvent); });
			}
			if (callbacks.onSomeday && !isDeferred) {
				const btn = this.el.createSpan({ cls: 'friday-row-action', text: '💤' });
				btn.setAttribute('title', 'Send to Someday');
				btn.addEventListener('click', (e) => { e.stopPropagation(); callbacks.onSomeday!(task); });
			}
			if (callbacks.onWake && task.someday) {
				const btn = this.el.createSpan({ cls: 'friday-row-action', text: '↩︎' });
				btn.setAttribute('title', 'Wake — remove from Someday');
				btn.addEventListener('click', (e) => { e.stopPropagation(); callbacks.onWake!(task); });
			}
		}

		// Source file link
		const fileName = task.sourcePath.split('/').pop()?.replace(/\.md$/, '') || task.sourcePath;
		const sourceEl = createSourceLink(fileName);
		sourceEl.addEventListener('click', (e) => {
			e.stopPropagation();
			this.callbacks.onClickSource(task);
		});
		this.el.appendChild(sourceEl);

		// Expandable description area
		if (task.description) {
			const descEl = this.el.createDiv({
				cls: 'friday-task-description friday-task-description-hidden',
			});
			descEl.textContent = task.description;

			// Wire up toggle
			const toggle = this.el.querySelector('.friday-desc-toggle');
			if (toggle) {
				toggle.addEventListener('click', (e) => {
					e.stopPropagation();
					descEl.toggleClass('friday-task-description-hidden',
						!descEl.hasClass('friday-task-description-hidden'));
				});
			}
		}
	}

	getElement(): HTMLElement {
		return this.el;
	}
}
