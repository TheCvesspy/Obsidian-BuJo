import { setIcon, setTooltip } from 'obsidian';
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
	/** Set/replace @due (v3 triage). When provided, a 📅 action renders on open rows. */
	onSetDue?: (task: TaskItem) => void;
	/** Move the task into a Topic's ## Tasks section (v3 triage). 📌 on open rows. */
	onSendToTopic?: (task: TaskItem) => void;
	/** Drop — mark cancelled (v3 triage). ✖ on open rows. */
	onDrop?: (task: TaskItem) => void;
	/** Open the full task settings dialog (v3). ✏️ renders on every row when provided. */
	onEdit?: (task: TaskItem) => void;
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

		// Description toggle indicator — a real button so keyboard users can expand it
		if (task.description) {
			const descToggle = this.el.createEl('button', { cls: 'friday-desc-toggle', text: '…' });
			setTooltip(descToggle, 'Show/hide description');
			descToggle.setAttribute('aria-label', 'Show/hide description');
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

		// Row actions (v3): real <button>s (keyboard-focusable) with Lucide icons and
		// native tooltips. Only rendered when the host view wires the callbacks
		// (Today/Upcoming/Triage/Someday do; legacy views don't).
		const actionButton = (icon: string, tooltip: string, onClick: (e: MouseEvent) => void) => {
			const btn = this.el.createEl('button', { cls: 'friday-row-action' });
			setIcon(btn, icon);
			setTooltip(btn, tooltip);
			btn.setAttribute('aria-label', tooltip);
			btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(e as MouseEvent); });
		};
		if (task.status === TaskStatus.Open) {
			const isDeferred = task.someday || task.snoozeDate != null;
			if (callbacks.onSetDue && !isDeferred) {
				actionButton('calendar', 'Set due date…', () => callbacks.onSetDue!(task));
			}
			if (callbacks.onSnooze && !isDeferred) {
				actionButton('alarm-clock', 'Snooze…', (e) => callbacks.onSnooze!(task, e));
			}
			if (callbacks.onSendToTopic && !isDeferred) {
				actionButton('pin', 'Send to topic…', () => callbacks.onSendToTopic!(task));
			}
			if (callbacks.onSomeday && !isDeferred) {
				actionButton('moon', 'Send to Someday', () => callbacks.onSomeday!(task));
			}
			if (callbacks.onDrop && !isDeferred) {
				actionButton('x', 'Drop — mark cancelled', () => callbacks.onDrop!(task));
			}
			if (callbacks.onWake && task.someday) {
				actionButton('undo-2', 'Wake — remove from Someday', () => callbacks.onWake!(task));
			}
		}

		// Edit dialog (v3): full field management, available on every row regardless of status.
		if (callbacks.onEdit) {
			actionButton('pencil', 'Edit task…', () => callbacks.onEdit!(task));
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
