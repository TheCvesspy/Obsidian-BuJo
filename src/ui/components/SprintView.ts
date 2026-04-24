import { PluginSettings, Sprint, SprintTopic, TopicStatus, Priority } from '../../types';
import { TaskStore } from '../../services/taskStore';
import { SprintService } from '../../services/sprintService';
import { SprintTopicService } from '../../services/sprintTopicService';
import { JiraService } from '../../services/jiraService';
import { workDaysRemaining, totalWorkDays } from '../../utils/workDayUtils';
import { renderTopicCard } from './TopicCard';

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
		private onEditSprint: (sprint: Sprint) => void,
		private isDragging: { value: boolean },
		private searchQuery: string = '',
		private jiraService: JiraService | null = null,
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
		const nameEl = headerInfo.createSpan({ cls: 'task-bujo-sprint-name', text: sprint.name });
		nameEl.setAttribute('title', 'Click to edit sprint');
		nameEl.style.cursor = 'pointer';
		nameEl.addEventListener('click', () => this.onEditSprint(sprint));
		headerInfo.createSpan({
			cls: 'task-bujo-sprint-dates',
			text: ` ${startDate.toLocaleDateString()} – ${endDate.toLocaleDateString()}`,
		});
		headerInfo.createSpan({
			cls: 'task-bujo-sprint-remaining',
			text: ` · ${daysRemaining} ${dayLabel} remaining`,
		});
		const editBtn = headerInfo.createEl('button', {
			cls: 'task-bujo-btn task-bujo-sprint-edit-btn',
			text: 'Edit',
		});
		editBtn.setAttribute('title', 'Edit sprint name and dates');
		editBtn.addEventListener('click', () => this.onEditSprint(sprint));

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
				t.jira.some(k => k.toLowerCase().includes(q)) ||
				t.linkedPages.some(p => p.toLowerCase().includes(q))
			);
		}

		// Kick off JIRA prefetch for all keys visible on the board (no-op if module disabled).
		// Results arrive asynchronously and trigger a re-render via JiraService events.
		this.prefetchJiraKeys(filteredTopics);

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
		const jiraLookup = this.makeJiraLookup();
		const assigneeLookup = this.makeAssigneeLookup();
		for (const topic of topics) {
			renderTopicCard(body, topic, {
				draggable: true,
				isDragging: this.isDragging,
				onTitleClick: (t) => this.onTopicClick(t),
				onStatusChange: async (t, newStatus) => {
					await this.topicService.setTopicStatus(t.filePath, newStatus);
				},
				onBlockedToggle: async (t) => {
					await this.topicService.setTopicBlocked(t.filePath, !t.blocked);
				},
				jiraLookup,
				assigneeLookup,
				nudgeThresholdDays: this.settings.nudgeThresholdDays,
			});
		}

		// Empty state
		if (topics.length === 0) {
			body.createDiv({ cls: 'task-bujo-kanban-empty', text: 'No topics' });
		}
	}

	/** Kick off a prefetch for every JIRA key on every visible topic. No-op if module disabled. */
	private prefetchJiraKeys(topics: SprintTopic[]): void {
		if (!this.jiraService || !this.jiraService.isEnabled()) return;
		const keys: string[] = [];
		for (const t of topics) {
			for (const k of t.jira) keys.push(k);
		}
		if (keys.length > 0) {
			// Fire and forget; JiraService emits events when data lands and the view re-renders.
			void this.jiraService.prefetchMany(keys);
		}
	}

	/** Build a per-key JIRA lookup function for TopicCard. Returns null-ish results when disabled. */
	private makeJiraLookup() {
		const svc = this.jiraService;
		if (!svc || !svc.isEnabled()) return undefined;
		return (key: string) => ({
			info: svc.getCached(key),
			loading: svc.isLoading(key),
			error: svc.getError(key),
		});
	}

	/** Build a per-email assignee lookup resolving the "logged team" for display. */
	private makeAssigneeLookup() {
		const members = this.settings.teamMembers ?? [];
		if (members.length === 0) return undefined;
		const byEmail = new Map(members.map(m => [m.email, m]));
		return (email: string) => {
			const m = byEmail.get(email);
			if (!m) return null;
			return { label: m.nickname || m.fullName || m.email, isInactive: !m.active };
		};
	}

	destroy(): void {
		this.el.empty();
	}
}
