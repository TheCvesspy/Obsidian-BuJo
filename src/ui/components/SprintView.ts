import { PluginSettings, Sprint, SprintTopic, TopicStatus, Priority } from '../../types';
import { TaskStore } from '../../services/taskStore';
import { SprintService } from '../../services/sprintService';
import { SprintTopicService } from '../../services/sprintTopicService';
import { workDaysRemaining, totalWorkDays } from '../../utils/workDayUtils';

const COLUMNS: { status: TopicStatus; label: string }[] = [
	{ status: 'open', label: 'Open' },
	{ status: 'in-progress', label: 'In Progress' },
	{ status: 'done', label: 'Done' },
];

const PRIORITY_ORDER: Record<string, number> = {
	[Priority.High]: 0,
	[Priority.Medium]: 1,
	[Priority.Low]: 2,
	[Priority.None]: 3,
};

const STATUS_TRANSITIONS: Record<TopicStatus, { left: TopicStatus | null; right: TopicStatus | null }> = {
	'open': { left: null, right: 'in-progress' },
	'in-progress': { left: 'open', right: 'done' },
	'done': { left: 'in-progress', right: null },
};

export class SprintView {
	private el: HTMLElement;

	constructor(
		private container: HTMLElement,
		private store: TaskStore,
		private sprintService: SprintService,
		private topicService: SprintTopicService,
		private topics: SprintTopic[],
		private settings: PluginSettings,
		private onNewSprint: () => void,
		private onEndSprint: (sprint: Sprint) => void,
		private onNewTopic: () => void,
		private onTopicClick: (topic: SprintTopic) => void,
		private isDragging: { value: boolean },
		private searchQuery: string = '',
	) {
		this.el = container.createDiv({ cls: 'task-bujo-sprint-view' });
	}

	render(): void {
		this.el.empty();
		const activeSprint = this.sprintService.getActiveSprint();

		if (!activeSprint) {
			this.renderNoSprint();
			return;
		}

		this.renderSprint(activeSprint);
	}

	private renderNoSprint(): void {
		const empty = this.el.createDiv({ cls: 'task-bujo-sprint-empty' });
		empty.createDiv({ text: 'No active sprint' });
		const btn = empty.createEl('button', {
			cls: 'task-bujo-btn',
			text: 'Create Sprint',
		});
		btn.addEventListener('click', () => this.onNewSprint());
	}

	private renderSprint(sprint: Sprint): void {
		const startDate = new Date(sprint.startDate);
		const endDate = new Date(sprint.endDate);
		const today = new Date();

		let daysRemaining: number;
		let dayLabel: string;
		if (this.settings.sprintWorkDaysOnly) {
			daysRemaining = workDaysRemaining(endDate);
			dayLabel = 'work days';
		} else {
			daysRemaining = Math.max(0, Math.ceil((endDate.getTime() - today.getTime()) / 86400000));
			dayLabel = 'd';
		}

		// Header
		const header = this.el.createDiv({ cls: 'task-bujo-sprint-header' });
		const headerInfo = header.createDiv({ cls: 'task-bujo-sprint-header-info' });
		headerInfo.createSpan({ cls: 'task-bujo-sprint-name', text: sprint.name });
		headerInfo.createSpan({
			cls: 'task-bujo-sprint-dates',
			text: ` ${startDate.toLocaleDateString()} – ${endDate.toLocaleDateString()}`,
		});
		headerInfo.createSpan({
			cls: 'task-bujo-sprint-remaining',
			text: ` · ${daysRemaining} ${dayLabel} remaining`,
		});

		const addTopicBtn = header.createEl('button', {
			cls: 'task-bujo-btn',
			text: '+ Topic',
		});
		addTopicBtn.addEventListener('click', () => this.onNewTopic());

		// Filter topics
		let filteredTopics = this.topics;
		if (this.searchQuery) {
			const q = this.searchQuery.toLowerCase();
			filteredTopics = filteredTopics.filter(t =>
				t.title.toLowerCase().includes(q) ||
				(t.jira && t.jira.toLowerCase().includes(q)) ||
				t.linkedPages.some(p => p.toLowerCase().includes(q))
			);
		}

		// Kanban board
		const board = this.el.createDiv({ cls: 'task-bujo-kanban' });

		for (const col of COLUMNS) {
			const columnTopics = filteredTopics
				.filter(t => t.status === col.status)
				.sort((a, b) => this.sortTopics(a, b));

			this.renderColumn(board, col.status, col.label, columnTopics);
		}

		// Action buttons
		const actions = this.el.createDiv({ cls: 'task-bujo-sprint-actions' });
		const endBtn = actions.createEl('button', {
			cls: 'task-bujo-btn task-bujo-btn-warning',
			text: 'End Sprint',
		});
		endBtn.addEventListener('click', () => this.onEndSprint(sprint));

		const newBtn = actions.createEl('button', {
			cls: 'task-bujo-btn',
			text: 'New Sprint',
		});
		newBtn.addEventListener('click', () => this.onNewSprint());
	}

	private sortTopics(a: SprintTopic, b: SprintTopic): number {
		// If either has a manual sort order, use it as primary
		const aManual = a.sortOrder < 999;
		const bManual = b.sortOrder < 999;
		if (aManual || bManual) {
			if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
		}
		// Fall back to priority ordering
		return (PRIORITY_ORDER[a.priority] ?? 3) - (PRIORITY_ORDER[b.priority] ?? 3);
	}

	private renderColumn(board: HTMLElement, status: TopicStatus, label: string, topics: SprintTopic[]): void {
		const column = board.createDiv({ cls: 'task-bujo-kanban-column' });
		column.dataset.status = status;

		// Column header
		const headerEl = column.createDiv({ cls: 'task-bujo-kanban-column-header' });
		headerEl.createSpan({ text: label });
		headerEl.createSpan({ cls: 'task-bujo-kanban-column-count', text: `${topics.length}` });

		// Column body (drop zone)
		const body = column.createDiv({ cls: 'task-bujo-kanban-column-body' });

		// Drag-and-drop on the column body
		body.addEventListener('dragover', (e) => {
			e.preventDefault();
			if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
			body.addClass('task-bujo-kanban-column-dragover');
		});
		body.addEventListener('dragleave', () => {
			body.removeClass('task-bujo-kanban-column-dragover');
		});
		body.addEventListener('drop', async (e) => {
			e.preventDefault();
			body.removeClass('task-bujo-kanban-column-dragover');
			const filePath = e.dataTransfer?.getData('text/plain');
			if (!filePath) return;

			await this.topicService.setTopicStatus(filePath, status);
			// If blocked and moving to done, auto-clear blocked
			const topic = this.topics.find(t => t.filePath === filePath);
			if (topic?.blocked && status === 'done') {
				await this.topicService.setTopicBlocked(filePath, false);
			}
			this.isDragging.value = false;
		});

		// Render topic cards
		for (const topic of topics) {
			this.renderTopicCard(body, topic);
		}

		// Empty state
		if (topics.length === 0) {
			body.createDiv({ cls: 'task-bujo-kanban-empty', text: 'No topics' });
		}
	}

	private renderTopicCard(container: HTMLElement, topic: SprintTopic): void {
		const card = container.createDiv({ cls: 'task-bujo-kanban-card' });
		card.draggable = true;
		card.dataset.filepath = topic.filePath;

		// Drag events
		card.addEventListener('dragstart', (e) => {
			this.isDragging.value = true;
			card.addClass('task-bujo-kanban-card-dragging');
			if (e.dataTransfer) {
				e.dataTransfer.setData('text/plain', topic.filePath);
				e.dataTransfer.effectAllowed = 'move';
			}
		});
		card.addEventListener('dragend', () => {
			card.removeClass('task-bujo-kanban-card-dragging');
			this.isDragging.value = false;
		});

		// Card header: priority dot + title + blocked badge
		const headerEl = card.createDiv({ cls: 'task-bujo-kanban-card-header' });

		if (topic.priority !== Priority.None) {
			const dot = headerEl.createSpan({ cls: 'task-bujo-priority-dot' });
			dot.addClass(`task-bujo-priority-${topic.priority}`);
		}

		const titleEl = headerEl.createSpan({ cls: 'task-bujo-kanban-card-title', text: topic.title });
		titleEl.addEventListener('click', (e) => {
			e.stopPropagation();
			this.onTopicClick(topic);
		});

		if (topic.blocked) {
			headerEl.createSpan({ cls: 'task-bujo-kanban-card-blocked', text: 'BLOCKED' });
		}

		// JIRA ticket
		if (topic.jira) {
			card.createDiv({ cls: 'task-bujo-kanban-card-jira', text: topic.jira });
		}

		// Linked pages
		if (topic.linkedPages.length > 0) {
			const linksText = topic.linkedPages.map(p => `[[${p}]]`).join(', ');
			card.createDiv({ cls: 'task-bujo-kanban-card-links', text: linksText });
		}

		// Task progress bar
		if (topic.taskTotal > 0) {
			const progressDiv = card.createDiv({ cls: 'task-bujo-kanban-card-progress' });
			const barOuter = progressDiv.createDiv({ cls: 'task-bujo-progress-bar' });
			const barInner = barOuter.createDiv({ cls: 'task-bujo-progress-fill' });
			const pct = Math.round((topic.taskDone / topic.taskTotal) * 100);
			barInner.style.width = `${pct}%`;
			progressDiv.createSpan({
				cls: 'task-bujo-progress-text',
				text: `${topic.taskDone}/${topic.taskTotal} tasks`,
			});
		}

		// Action buttons (move left/right)
		const transitions = STATUS_TRANSITIONS[topic.status];
		if (transitions.left || transitions.right) {
			const actionsDiv = card.createDiv({ cls: 'task-bujo-kanban-card-actions' });

			if (transitions.left) {
				const leftBtn = actionsDiv.createEl('button', { text: '\u2190' });
				leftBtn.setAttribute('title', `Move to ${this.getColumnLabel(transitions.left)}`);
				leftBtn.addEventListener('click', async (e) => {
					e.stopPropagation();
					await this.topicService.setTopicStatus(topic.filePath, transitions.left!);
				});
			}

			if (transitions.right) {
				const rightBtn = actionsDiv.createEl('button', { text: '\u2192' });
				rightBtn.setAttribute('title', `Move to ${this.getColumnLabel(transitions.right)}`);
				rightBtn.addEventListener('click', async (e) => {
					e.stopPropagation();
					await this.topicService.setTopicStatus(topic.filePath, transitions.right!);
				});
			}

			// Blocked toggle
			const blockedBtn = actionsDiv.createEl('button', {
				text: topic.blocked ? '\u26A0 Unblock' : '\u26A0',
				cls: topic.blocked ? 'task-bujo-kanban-blocked-active' : '',
			});
			blockedBtn.setAttribute('title', topic.blocked ? 'Remove blocked flag' : 'Flag as blocked');
			blockedBtn.addEventListener('click', async (e) => {
				e.stopPropagation();
				await this.topicService.setTopicBlocked(topic.filePath, !topic.blocked);
			});
		}
	}

	private getColumnLabel(status: TopicStatus): string {
		return COLUMNS.find(c => c.status === status)?.label ?? status;
	}

	destroy(): void {
		this.el.empty();
	}
}
