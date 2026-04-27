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
