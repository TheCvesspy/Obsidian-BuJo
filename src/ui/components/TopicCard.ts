import { SprintTopic, TopicStatus, Priority, JiraIssueInfo } from '../../types';

export interface TopicCardOptions {
	/** If true, the card is draggable (dataTransfer carries the filePath). */
	draggable?: boolean;
	/** Shared mutable flag so the view can suppress store-driven refreshes while dragging. */
	isDragging?: { value: boolean };
	/** Called when the card title is clicked (usually to open the file). */
	onTitleClick?: (topic: SprintTopic) => void;
	/** Called when a status-transition button is pressed. Omit to hide arrows. */
	onStatusChange?: (topic: SprintTopic, newStatus: TopicStatus) => void;
	/** Called when the blocked toggle is pressed. Omit to hide the blocked button. */
	onBlockedToggle?: (topic: SprintTopic) => void;
	/** If true, show impact/effort/due-date metadata chips below the title. */
	showMatrixMetadata?: boolean;
	/** Lookup live JIRA data for a given key. Called once per key in `topic.jira[]`.
	 *  Return `{info: null, loading: false, error: null}` (or omit) to render the key bare. */
	jiraLookup?: (key: string) => { info: JiraIssueInfo | null; loading: boolean; error: string | null };
}

const STATUS_TRANSITIONS: Record<TopicStatus, { left: TopicStatus | null; right: TopicStatus | null }> = {
	'open': { left: null, right: 'in-progress' },
	'in-progress': { left: 'open', right: 'done' },
	'done': { left: 'in-progress', right: null },
};

const STATUS_LABELS: Record<TopicStatus, string> = {
	'open': 'Open',
	'in-progress': 'In Progress',
	'done': 'Done',
};

/** Render a Topic card into the given container. Returns the card element. */
export function renderTopicCard(
	container: HTMLElement,
	topic: SprintTopic,
	opts: TopicCardOptions,
): HTMLElement {
	const card = container.createDiv({ cls: 'task-bujo-kanban-card' });

	if (opts.draggable) {
		card.draggable = true;
		card.dataset.filepath = topic.filePath;
		card.addEventListener('dragstart', (e) => {
			if (opts.isDragging) opts.isDragging.value = true;
			card.addClass('task-bujo-kanban-card-dragging');
			if (e.dataTransfer) {
				e.dataTransfer.setData('text/plain', topic.filePath);
				e.dataTransfer.effectAllowed = 'move';
			}
		});
		card.addEventListener('dragend', () => {
			card.removeClass('task-bujo-kanban-card-dragging');
			if (opts.isDragging) opts.isDragging.value = false;
		});
	}

	// Header: priority dot + title + blocked badge
	const headerEl = card.createDiv({ cls: 'task-bujo-kanban-card-header' });
	if (topic.priority !== Priority.None) {
		const dot = headerEl.createSpan({ cls: 'task-bujo-priority-dot' });
		dot.addClass(`task-bujo-priority-${topic.priority}`);
	}
	const titleEl = headerEl.createSpan({ cls: 'task-bujo-kanban-card-title', text: topic.title });
	if (opts.onTitleClick) {
		titleEl.addEventListener('click', (e) => {
			e.stopPropagation();
			opts.onTitleClick!(topic);
		});
	}
	if (topic.blocked) {
		headerEl.createSpan({ cls: 'task-bujo-kanban-card-blocked', text: 'BLOCKED' });
	}

	// JIRA tickets (0..n) — one row per linked key
	for (const key of topic.jira) {
		const lookup = opts.jiraLookup?.(key);
		const info = lookup?.info ?? null;
		const loading = lookup?.loading ?? false;
		const error = lookup?.error ?? null;

		const jiraRow = card.createDiv({ cls: 'task-bujo-kanban-card-jira-row' });
		const keyEl = jiraRow.createSpan({ cls: 'task-bujo-kanban-card-jira', text: key });
		if (info?.issueUrl) {
			keyEl.addClass('task-bujo-clickable');
			keyEl.addEventListener('click', (e) => {
				e.stopPropagation();
				window.open(info.issueUrl, '_blank');
			});
		}

		if (loading) {
			jiraRow.createSpan({ cls: 'task-bujo-jira-chip task-bujo-jira-loading', text: '…' });
		} else if (error) {
			const errEl = jiraRow.createSpan({
				cls: 'task-bujo-jira-chip task-bujo-jira-error',
				text: '!',
			});
			errEl.setAttribute('title', `JIRA fetch failed: ${error}`);
		} else if (info) {
			const statusEl = jiraRow.createSpan({
				cls: `task-bujo-jira-chip task-bujo-jira-status task-bujo-jira-status-${info.statusCategory}`,
				text: info.status,
			});
			statusEl.setAttribute('title', `JIRA status: ${info.status}`);
			const assigneeLabel = info.assignee ?? 'Unassigned';
			const assigneeEl = jiraRow.createSpan({
				cls: 'task-bujo-jira-chip task-bujo-jira-assignee',
				text: assigneeLabel,
			});
			assigneeEl.setAttribute('title', info.assignee ? `Assignee: ${info.assignee}` : 'Unassigned');
			if (info.summary) {
				const summaryEl = card.createDiv({
					cls: 'task-bujo-kanban-card-jira-summary',
					text: info.summary,
				});
				summaryEl.setAttribute('title', info.summary);
			}
		}
	}

	// Optional matrix metadata (impact / effort / due date)
	if (opts.showMatrixMetadata) {
		const chips: string[] = [];
		if (topic.impact) chips.push(`Impact: ${topic.impact}`);
		if (topic.effort) chips.push(`Effort: ${topic.effort.toUpperCase()}`);
		if (topic.dueDate) chips.push(`Due: ${topic.dueDate}`);
		if (chips.length > 0) {
			card.createDiv({ cls: 'task-bujo-kanban-card-meta', text: chips.join(' \u2022 ') });
		}
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

	// Action row: status arrows + blocked toggle
	const transitions = STATUS_TRANSITIONS[topic.status];
	const wantsStatusButtons = opts.onStatusChange && (transitions.left || transitions.right);
	const wantsBlockedButton = opts.onBlockedToggle !== undefined;

	if (wantsStatusButtons || wantsBlockedButton) {
		const actionsDiv = card.createDiv({ cls: 'task-bujo-kanban-card-actions' });

		if (wantsStatusButtons && transitions.left) {
			const leftBtn = actionsDiv.createEl('button', { text: '\u2190' });
			leftBtn.setAttribute('title', `Move to ${STATUS_LABELS[transitions.left]}`);
			leftBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				opts.onStatusChange!(topic, transitions.left!);
			});
		}
		if (wantsStatusButtons && transitions.right) {
			const rightBtn = actionsDiv.createEl('button', { text: '\u2192' });
			rightBtn.setAttribute('title', `Move to ${STATUS_LABELS[transitions.right]}`);
			rightBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				opts.onStatusChange!(topic, transitions.right!);
			});
		}
		if (wantsBlockedButton) {
			const blockedBtn = actionsDiv.createEl('button', {
				text: topic.blocked ? '\u26A0 Unblock' : '\u26A0',
				cls: topic.blocked ? 'task-bujo-kanban-blocked-active' : '',
			});
			blockedBtn.setAttribute('title', topic.blocked ? 'Remove blocked flag' : 'Flag as blocked');
			blockedBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				opts.onBlockedToggle!(topic);
			});
		}
	}

	return card;
}
