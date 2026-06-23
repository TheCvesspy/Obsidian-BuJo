import { Notice } from 'obsidian';
import { PluginSettings, SprintTopic, TopicStatus, Priority, TopicImpact, TopicEffort } from '../../types';
import { SprintTopicService } from '../../services/sprintTopicService';
import { JiraService } from '../../services/jiraService';
import { deriveTopicBlock, toJiraSignal } from '../../services/topicStatus';
import { buildTopicIndex, TopicIndex, criticalPath } from '../../services/topicGraph';
import { getWeekStartConfigurable, getWeekId, formatWeekId } from '../../utils/dateUtils';
import { renderTopicCard } from './TopicCard';

/**
 * Topics view sub-modes:
 *   list         — flat table (Topic / JIRA / Assignee / Due). Best for quick scan.
 *   board        — Kanban columns (Backlog / To Do / In Progress / Done) with drag-drop.
 *   impactEffort — 2×2 strategy matrix.
 *
 * Eisenhower (urgent/important matrix) was removed in favor of these three —
 * it duplicated impact/dueDate semantics without adding action, and nobody used it.
 */
export type TopicsSubMode = 'list' | 'board' | 'impactEffort' | 'roadmap';
type ScopeFilter = 'all' | 'backlog' | 'archived';

const PRIORITY_ORDER: Record<string, number> = {
	[Priority.High]: 0,
	[Priority.Medium]: 1,
	[Priority.Low]: 2,
	[Priority.None]: 3,
};

const IMPACT_ORDER: Record<string, number> = {
	critical: 0,
	high: 1,
	medium: 2,
	low: 3,
};

const HIGH_IMPACT_SET = new Set<TopicImpact>(['critical', 'high']);
const SMALL_EFFORT_SET = new Set<TopicEffort>(['xs', 's']);

interface Quadrant {
	key: string;
	title: string;
	subtitle: string;
	cls: string;
	topics: SprintTopic[];
}

interface RoadmapItem {
	topic: SprintTopic;
	startMs: number;
	endMs: number;
}

const ROADMAP_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export class TopicsOverviewView {
	private el: HTMLElement;
	private subMode: TopicsSubMode = 'board';
	private roadmapZoom: 'week' | 'month' = 'week';
	private roadmapGroupBy: 'assignee' | 'status' = 'assignee';
	private scope: ScopeFilter = 'all';
	/** 'all' | 'unassigned' | team member email. Persists across re-renders of this view instance. */
	private assigneeFilter: string = 'all';
	/** Dependency index over all topics, rebuilt at the start of each render. */
	private depIndex: TopicIndex | null = null;

	constructor(
		private container: HTMLElement,
		private topics: SprintTopic[],
		private topicService: SprintTopicService,
		private settings: PluginSettings,
		private onTopicClick: (topic: SprintTopic) => void,
		private onEditTopic: (topic: SprintTopic) => void,
		private onNewTopic: () => void,
		private isDragging: { value: boolean },
		private searchQuery: string = '',
		private jiraService: JiraService | null = null,
		initialSubMode: TopicsSubMode = 'board',
		private onSubModeChange?: (mode: TopicsSubMode) => void,
	) {
		this.el = container.createDiv({ cls: 'friday-topics-overview' });
		this.subMode = initialSubMode;
	}

	render(): void {
		this.el.empty();
		this.depIndex = buildTopicIndex(this.topics);

		// Header toolbar: sub-mode toggle + scope filter + new topic
		const header = this.el.createDiv({ cls: 'friday-topics-header' });

		const modeGroup = header.createDiv({ cls: 'friday-topics-modeswitch' });
		this.renderModeButton(modeGroup, 'board', 'Board');
		this.renderModeButton(modeGroup, 'list', 'List');
		this.renderModeButton(modeGroup, 'roadmap', 'Roadmap');
		this.renderModeButton(modeGroup, 'impactEffort', 'Impact / Effort');

		const scopeGroup = header.createDiv({ cls: 'friday-topics-scope' });
		this.renderScopeButton(scopeGroup, 'all', 'All');
		this.renderScopeButton(scopeGroup, 'backlog', 'Backlog');
		this.renderScopeButton(scopeGroup, 'archived', 'Done');

		this.renderAssigneeFilter(header);

		const newBtn = header.createEl('button', { cls: 'friday-btn', text: '+ Topic' });
		newBtn.addEventListener('click', () => this.onNewTopic());

		// Apply filters
		const filtered = this.applyFilters(this.topics);

		// Kick off JIRA prefetch for every visible topic (no-op if module disabled).
		// Results land asynchronously and trigger a re-render via JiraService events.
		this.prefetchJiraKeys(filtered);

		// Render sub-mode body
		const body = this.el.createDiv({ cls: 'friday-topics-body' });
		if (filtered.length === 0) {
			body.createDiv({ cls: 'friday-empty', text: 'No topics match the current filter.' });
			return;
		}

		switch (this.subMode) {
			case 'list':
				this.renderTable(body, filtered);
				break;
			case 'board':
				this.renderBoard(body, filtered);
				break;
			case 'impactEffort':
				this.renderImpactEffort(body, filtered);
				break;
			case 'roadmap':
				this.renderRoadmap(body, filtered);
				break;
		}
	}

	private renderModeButton(parent: HTMLElement, mode: TopicsSubMode, label: string): void {
		const btn = parent.createEl('button', {
			cls: 'friday-topics-modebtn',
			text: label,
		});
		if (mode === this.subMode) btn.addClass('friday-topics-modebtn-active');
		btn.addEventListener('click', () => {
			this.subMode = mode;
			this.onSubModeChange?.(mode);
			this.render();
		});
	}

	private renderScopeButton(parent: HTMLElement, scope: ScopeFilter, label: string): void {
		const btn = parent.createEl('button', {
			cls: 'friday-topics-scopebtn',
			text: label,
		});
		if (scope === this.scope) btn.addClass('friday-topics-scopebtn-active');
		btn.addEventListener('click', () => {
			this.scope = scope;
			this.render();
		});
	}

	/** Assignee filter dropdown. Hidden when no team members are configured so it doesn't
	 *  add noise for users who don't use the team feature.
	 *  Adds "Mine" and "Assigned out" options when `settings.jiraEmail` is configured,
	 *  turning the filter into a lightweight coordination lens. */
	private renderAssigneeFilter(parent: HTMLElement): void {
		const active = (this.settings.teamMembers ?? []).filter(m => m.active);
		if (active.length === 0) return;

		const wrapper = parent.createDiv({ cls: 'friday-topics-assigneefilter' });
		const select = wrapper.createEl('select', { cls: 'friday-topics-assignee-select' });
		const addOpt = (value: string, label: string, disabled = false) => {
			const opt = select.createEl('option', { text: label });
			opt.value = value;
			if (disabled) opt.disabled = true;
			if (value === this.assigneeFilter) opt.selected = true;
		};
		addOpt('all', 'All assignees');

		// "Mine" and "Assigned out" — only show when we know who "me" is.
		const me = this.settings.jiraEmail?.trim();
		if (me) {
			addOpt('mine', '\u{1F464} Mine');
			addOpt('assigned-out', '\u{1F4E8} Assigned out');
		}

		addOpt('unassigned', '\u2205 Unassigned');
		addOpt('__sep__', '──────────', true);

		for (const m of active) {
			addOpt(m.email, m.nickname || m.fullName || m.email);
		}
		// Preserve an out-of-team current selection so it doesn't silently reset on re-render.
		const reserved = new Set(['all', 'mine', 'assigned-out', 'unassigned', '__sep__']);
		if (
			!reserved.has(this.assigneeFilter)
			&& !active.some(m => m.email === this.assigneeFilter)
		) {
			addOpt(this.assigneeFilter, `${this.assigneeFilter} · inactive`);
		}
		select.addEventListener('change', () => {
			if (select.value === '__sep__') return;  // separator shouldn't be selectable but guard anyway
			this.assigneeFilter = select.value;
			this.render();
		});
	}

	private applyFilters(topics: SprintTopic[]): SprintTopic[] {
		let filtered = topics.filter(t => {
			switch (this.scope) {
				case 'backlog':
					return t.status === 'backlog';
				case 'archived':
					return t.status === 'done';
				case 'all':
				default:
					return true;
			}
		});

		if (this.searchQuery) {
			const q = this.searchQuery.toLowerCase();
			filtered = filtered.filter(t =>
				t.title.toLowerCase().includes(q) ||
				t.jira.some(k => k.toLowerCase().includes(q)) ||
				t.linkedPages.some(p => p.toLowerCase().includes(q))
			);
		}

		if (this.assigneeFilter === 'unassigned') {
			filtered = filtered.filter(t => !t.assignee);
		} else if (this.assigneeFilter === 'mine') {
			const me = this.settings.jiraEmail?.trim();
			if (me) filtered = filtered.filter(t => t.assignee === me);
		} else if (this.assigneeFilter === 'assigned-out') {
			const me = this.settings.jiraEmail?.trim();
			if (me) filtered = filtered.filter(t => !!t.assignee && t.assignee !== me);
		} else if (this.assigneeFilter !== 'all') {
			filtered = filtered.filter(t => t.assignee === this.assigneeFilter);
		}

		return filtered;
	}

	// ── List sub-mode (flat table) ────────────────────────────────

	/** Flat table view — one row per topic, columns: Topic / JIRA / Assignee / Due.
	 *  Status shows as a colored dot before the title (●). Done rows are dimmed,
	 *  overdue due-dates highlight red. This is the default sub-mode — best for
	 *  quick scanning across the full backlog without losing JIRA / owner context. */
	private renderTable(parent: HTMLElement, topics: SprintTopic[]): void {
		const sorted = [...topics].sort((a, b) => this.sortByPriorityImpact(a, b));
		const jiraLookup = this.makeJiraLookup();
		const assigneeLookup = this.makeAssigneeLookup();
		const myEmail = this.settings.jiraEmail?.trim() ?? '';

		const table = parent.createEl('table', { cls: 'friday-topics-table' });
		const thead = table.createEl('thead');
		const headRow = thead.createEl('tr');
		for (const label of ['Topic', 'JIRA', 'Assignee', 'Due']) {
			headRow.createEl('th', { text: label });
		}

		const tbody = table.createEl('tbody');
		for (const topic of sorted) {
			const row = tbody.createEl('tr', { cls: 'friday-topics-table-row' });
			if (topic.status === 'done') row.addClass('is-done');
			if (topic.blocked) row.addClass('is-blocked');

			// Title cell with status dot + (optional) blocked / inactive-sprint indicators.
			const titleCell = row.createEl('td', { cls: 'friday-topics-table-title' });
			const dot = titleCell.createSpan({
				cls: `friday-topics-table-statusdot is-${topic.status}`,
				text: '●',
			});
			dot.setAttribute('title', this.statusLabel(topic.status));
			if (topic.blocked) {
				titleCell.createSpan({ cls: 'friday-topics-table-blocked', text: '\u{1F6D1}' })
					.setAttribute('title', 'Blocked');
			}
			const titleLink = titleCell.createEl('a', {
				cls: 'friday-topics-table-titlelink',
				text: topic.title,
			});
			titleLink.addEventListener('click', (e) => {
				e.preventDefault();
				this.onTopicClick(topic);
			});

			// Inline "Edit" affordance — pencil-like, opens the modal without leaving the table.
			const editBtn = titleCell.createEl('button', {
				cls: 'friday-topics-table-edit',
				text: '✎',
			});
			editBtn.setAttribute('title', 'Edit topic details');
			editBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				this.onEditTopic(topic);
			});

			// JIRA cell — one badge per key, each a clickable link if JIRA service
			// is enabled and we have the issue cached. Otherwise renders the key as
			// a plain badge so the user still sees what's linked.
			const jiraCell = row.createEl('td', { cls: 'friday-topics-table-jira' });
			if (topic.jira.length === 0) {
				jiraCell.createSpan({ cls: 'friday-muted', text: '—' });
			} else {
				for (const key of topic.jira) {
					const info = jiraLookup ? jiraLookup(key) : undefined;
					const url = info?.info?.issueUrl;
					if (url) {
						const link = jiraCell.createEl('a', {
							cls: 'friday-topics-table-jirakey',
							text: key,
							href: url,
						});
						link.setAttribute('target', '_blank');
						link.setAttribute('rel', 'noopener');
					} else {
						jiraCell.createSpan({ cls: 'friday-topics-table-jirakey', text: key });
					}
				}
			}

			// Assignee — "Me" tag when the email matches `settings.jiraEmail`, otherwise
			// the team member's nickname / full name, otherwise the bare email, otherwise em-dash.
			const assigneeCell = row.createEl('td', { cls: 'friday-topics-table-assignee' });
			if (!topic.assignee) {
				assigneeCell.createSpan({ cls: 'friday-muted', text: '—' });
			} else if (myEmail && topic.assignee === myEmail) {
				assigneeCell.createSpan({
					cls: 'friday-topics-table-assignee-me',
					text: '\u{1F464} Me',
				});
			} else {
				const lookup = assigneeLookup ? assigneeLookup(topic.assignee) : null;
				const label = lookup?.label ?? topic.assignee;
				const span = assigneeCell.createSpan({
					cls: 'friday-topics-table-assignee-name',
					text: label,
				});
				if (lookup?.isInactive) {
					span.addClass('is-inactive');
					span.setAttribute('title', 'Inactive team member');
				}
			}

			// Due — ISO date with overdue highlight when in the past and topic not done.
			const dueCell = row.createEl('td', { cls: 'friday-topics-table-due' });
			if (!topic.dueDate) {
				dueCell.createSpan({ cls: 'friday-muted', text: '—' });
			} else {
				const span = dueCell.createSpan({ text: topic.dueDate });
				if (topic.status !== 'done' && this.isOverdue(topic.dueDate)) {
					span.addClass('is-overdue');
					span.setAttribute('title', 'Overdue');
				}
			}
		}

		// Kick off prefetch so the next render hydrates any missing JIRA URLs.
		this.prefetchJiraKeys(topics);
	}

	private statusLabel(status: TopicStatus): string {
		switch (status) {
			case 'backlog': return 'Backlog';
			case 'open': return 'To Do';
			case 'in-progress': return 'In Progress';
			case 'done': return 'Done';
		}
	}

	/** True when an ISO YYYY-MM-DD due date is strictly before today (local). */
	private isOverdue(dueIso: string): boolean {
		const due = new Date(dueIso);
		if (isNaN(due.getTime())) return false;
		const today = new Date();
		today.setHours(0, 0, 0, 0);
		return due < today;
	}

	// ── Board sub-mode (kanban) ───────────────────────────────────

	private renderBoard(parent: HTMLElement, topics: SprintTopic[]): void {
		// Pure status-driven Kanban: each column is a TopicStatus. Every topic appears in
		// exactly one column, and every column is a drop target that sets that status.
		const sections: { label: string; cls: string; status: TopicStatus }[] = [
			{ label: 'Backlog', cls: 'friday-topics-list-backlog', status: 'backlog' },
			{ label: 'To Do', cls: '', status: 'open' },
			{ label: 'In Progress', cls: '', status: 'in-progress' },
			{ label: 'Done', cls: '', status: 'done' },
		];

		const board = parent.createDiv({ cls: 'friday-topics-list-board' });

		for (const { label, cls, status } of sections) {
			const group = topics.filter(t => t.status === status);
			const limit = this.settings.wipLimits?.[status] ?? null;
			const overWip = limit !== null && group.length > limit;

			let sectionCls = cls
				? `friday-topics-list-section ${cls}`
				: 'friday-topics-list-section';
			if (overWip) sectionCls += ' is-over-wip';
			const section = board.createDiv({ cls: sectionCls });

			const headerEl = section.createDiv({ cls: 'friday-topics-list-header' });
			headerEl.createSpan({ text: label });
			const countEl = headerEl.createSpan({
				cls: 'friday-topics-list-count',
				text: limit !== null ? `${group.length} / ${limit}` : `${group.length}`,
			});
			if (overWip) {
				countEl.addClass('is-over-wip');
				countEl.setAttribute('title', `Over WIP limit (${limit})`);
			}

			// Card grid is the drop zone — every column accepts drops
			const cardGrid = section.createDiv({ cls: 'friday-topics-list-grid' });
			this.wireDropZone(cardGrid, status);

			if (group.length === 0) {
				// Empty placeholder lives inside the drop zone so empty columns still accept drops.
				cardGrid.createDiv({ cls: 'friday-empty', text: 'No topics' });
				continue;
			}

			const sorted = [...group].sort((a, b) => this.sortByPriorityImpact(a, b));
			for (const topic of sorted) {
				this.renderOverviewCard(cardGrid, topic, { draggable: true });
			}
		}
	}

	/** Wire dragover/drop handlers on a column. Dropping sets the topic's status. */
	private wireDropZone(zone: HTMLElement, targetStatus: TopicStatus): void {
		zone.addEventListener('dragover', (e) => {
			e.preventDefault();
			if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
			zone.addClass('friday-topics-list-dropzone-active');
		});
		zone.addEventListener('dragleave', () => {
			zone.removeClass('friday-topics-list-dropzone-active');
		});
		zone.addEventListener('drop', async (e) => {
			e.preventDefault();
			zone.removeClass('friday-topics-list-dropzone-active');
			const filePath = e.dataTransfer?.getData('text/plain');
			if (!filePath) return;

			const topic = this.topics.find(t => t.filePath === filePath);
			if (!topic) {
				this.isDragging.value = false;
				return;
			}

			try {
				if (topic.status !== targetStatus) {
					await this.topicService.setTopicStatus(filePath, targetStatus);
					// WIP limits warn but never block (Kanban convention). Count uses the
					// pre-drop snapshot of the target column + 1 for the incoming card.
					const limit = this.settings.wipLimits?.[targetStatus] ?? null;
					if (limit !== null) {
						const incoming = this.topics.filter(
							t => t.status === targetStatus && t.filePath !== filePath,
						).length + 1;
						if (incoming > limit) {
							new Notice(`Heads up: "${this.statusLabel(targetStatus)}" is over its WIP limit (${incoming} / ${limit}).`);
						}
					}
				}
				// Moving a blocked topic to Done auto-clears the blocked flag.
				if (topic.blocked && targetStatus === 'done') {
					await this.topicService.setTopicBlocked(filePath, false);
				}
			} finally {
				this.isDragging.value = false;
			}
		});
	}

	// ── Impact/Effort sub-mode ────────────────────────────────────

	private renderImpactEffort(parent: HTMLElement, topics: SprintTopic[]): void {
		const quickWins: SprintTopic[] = [];
		const bigBets: SprintTopic[] = [];
		const fillIns: SprintTopic[] = [];
		const timeSinks: SprintTopic[] = [];
		const inbox: SprintTopic[] = [];

		for (const topic of topics) {
			if (!topic.impact || !topic.effort) {
				inbox.push(topic);
				continue;
			}
			const isHighImpact = HIGH_IMPACT_SET.has(topic.impact);
			const isSmallEffort = SMALL_EFFORT_SET.has(topic.effort);
			if (isHighImpact && isSmallEffort) quickWins.push(topic);
			else if (isHighImpact && !isSmallEffort) bigBets.push(topic);
			else if (!isHighImpact && isSmallEffort) fillIns.push(topic);
			else timeSinks.push(topic);
		}

		const quadrants: Quadrant[] = [
			{ key: 'quickwins', title: '\u{1F3AF} Quick Wins', subtitle: 'High Impact + Small Effort — Do these first', cls: 'friday-topicmx-quickwins', topics: quickWins },
			{ key: 'bigbets', title: '\u{1F680} Big Bets', subtitle: 'High Impact + Med/Large Effort — Block deep work', cls: 'friday-topicmx-bigbets', topics: bigBets },
			{ key: 'fillins', title: '\u{1F4CB} Fill-ins', subtitle: 'Low Impact + Small Effort — Between meetings', cls: 'friday-topicmx-fillins', topics: fillIns },
			{ key: 'timesinks', title: '\u26A0\uFE0F Time Sinks', subtitle: 'Low Impact + Med/Large Effort — Rethink', cls: 'friday-topicmx-timesinks', topics: timeSinks },
		];

		const axisRow = parent.createDiv({ cls: 'friday-topicmx-axis-labels' });
		axisRow.createDiv();
		axisRow.createDiv({ cls: 'friday-topicmx-axis-label', text: 'Small Effort (xs, s)' });
		axisRow.createDiv({ cls: 'friday-topicmx-axis-label', text: 'Medium / Large Effort (m, l, xl)' });

		const grid = parent.createDiv({ cls: 'friday-topicmx-grid' });
		for (const q of quadrants) {
			this.renderQuadrant(grid, q);
		}

		this.renderQuadrant(parent, {
			key: 'inbox',
			title: '\u{1F4E5} Inbox',
			subtitle: 'Missing impact or effort — needs sizing',
			cls: 'friday-topicmx-inbox',
			topics: inbox,
		});
	}

	// ── Shared helpers ────────────────────────────────────────────

	private renderQuadrant(parent: HTMLElement, quadrant: Quadrant): void {
		const el = parent.createDiv({ cls: `friday-topicmx-quadrant ${quadrant.cls}` });

		const header = el.createDiv({ cls: 'friday-topicmx-quadrant-header' });
		const titleArea = header.createDiv();
		titleArea.createDiv({ cls: 'friday-topicmx-quadrant-title', text: quadrant.title });
		titleArea.createDiv({ cls: 'friday-topicmx-quadrant-subtitle', text: quadrant.subtitle });
		header.createDiv({ cls: 'friday-topicmx-quadrant-count', text: String(quadrant.topics.length) });

		const list = el.createDiv({ cls: 'friday-topicmx-quadrant-list' });
		if (quadrant.topics.length === 0) {
			list.createDiv({ cls: 'friday-empty', text: 'No topics' });
			return;
		}
		for (const topic of quadrant.topics) {
			this.renderOverviewCard(list, topic);
		}
	}

	private renderOverviewCard(
		parent: HTMLElement,
		topic: SprintTopic,
		opts: { draggable?: boolean } = {},
	): void {
		const jiraLookup = this.makeJiraLookup();
		const assigneeLookup = this.makeAssigneeLookup();
		renderTopicCard(parent, topic, {
			draggable: opts.draggable ?? false,
			isDragging: this.isDragging,
			showMatrixMetadata: true,
			onTitleClick: (t) => this.onTopicClick(t),
			onBlockedToggle: async (t) => {
				await this.topicService.setTopicBlocked(t.filePath, !t.blocked);
			},
			jiraLookup,
			assigneeLookup,
			deriveBlock: this.makeDeriveBlock(),
			dependencyLookup: (t) => ({
				blockedBy: this.depIndex?.blockersOf(t) ?? [],
				blocks: this.depIndex?.blocks(t) ?? [],
			}),
			onDependencyClick: (t) => this.onTopicClick(t),
			nudgeThresholdDays: this.settings.nudgeThresholdDays,
		});

		// Add an "Edit" affordance — clicking the card title opens the file; a small edit
		// button opens the modal so users can tweak impact/effort/due without leaving the matrix.
		const lastCard = parent.lastElementChild as HTMLElement | null;
		if (lastCard) {
			const actions = lastCard.querySelector('.friday-kanban-card-actions')
				|| lastCard.createDiv({ cls: 'friday-kanban-card-actions' });
			const editBtn = (actions as HTMLElement).createEl('button', { text: 'Edit' });
			editBtn.setAttribute('title', 'Edit topic details');
			editBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				this.onEditTopic(topic);
			});
		}
	}

	private sortByPriorityImpact(a: SprintTopic, b: SprintTopic): number {
		// Impact (when set) outranks priority; use priority as tiebreak
		const aImpact = a.impact ? IMPACT_ORDER[a.impact] : 99;
		const bImpact = b.impact ? IMPACT_ORDER[b.impact] : 99;
		if (aImpact !== bImpact) return aImpact - bImpact;
		const aPrio = PRIORITY_ORDER[a.priority] ?? 3;
		const bPrio = PRIORITY_ORDER[b.priority] ?? 3;
		if (aPrio !== bPrio) return aPrio - bPrio;
		return a.title.localeCompare(b.title);
	}

	/** Kick off a prefetch for every JIRA key on every visible topic. No-op if module disabled. */
	private prefetchJiraKeys(topics: SprintTopic[]): void {
		if (!this.jiraService || !this.jiraService.isEnabled()) return;
		const keys: string[] = [];
		for (const t of topics) {
			for (const k of t.jira) keys.push(k);
		}
		if (keys.length > 0) {
			void this.jiraService.prefetchMany(keys);
		}
	}

	/** Build the derived-block resolver for cards: manual flag OR JIRA signal OR dependency.
	 *  `blockersOf` is a stub here; real topic-dependency resolution is wired in T2. */
	private makeDeriveBlock() {
		const svc = this.jiraService;
		const jiraSignal = svc && svc.isEnabled()
			? (key: string) => toJiraSignal(svc.getCached(key))
			: undefined;
		const index = this.depIndex;
		return (topic: SprintTopic) => deriveTopicBlock({
			topic,
			blockersOf: (t) => index ? index.blockersOf(t) : [],
			jiraSignal,
		});
	}

	/** Build a per-key JIRA lookup function for TopicCard. Returns undefined when disabled. */
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

	// ── Roadmap sub-mode (time-based, due-date driven) ────────────

	private renderRoadmap(parent: HTMLElement, topics: SprintTopic[]): void {
		const controls = parent.createDiv({ cls: 'friday-roadmap-controls' });
		this.renderRoadmapToggle(controls, 'Zoom', [
			{ key: 'week', label: 'Week' },
			{ key: 'month', label: 'Month' },
		], this.roadmapZoom, (k) => { this.roadmapZoom = k as 'week' | 'month'; this.render(); });
		this.renderRoadmapToggle(controls, 'Group', [
			{ key: 'assignee', label: 'Assignee' },
			{ key: 'status', label: 'Status' },
		], this.roadmapGroupBy, (k) => { this.roadmapGroupBy = k as 'assignee' | 'status'; this.render(); });

		const dated: RoadmapItem[] = [];
		const undated: SprintTopic[] = [];
		for (const t of topics) {
			const span = this.computeTopicSpan(t);
			if (span) dated.push({ topic: t, startMs: span.startMs, endMs: span.endMs });
			else undated.push(t);
		}

		if (dated.length === 0) {
			parent.createDiv({ cls: 'friday-empty', text: 'No topics with a due date to place on the roadmap.' });
		} else {
			this.renderRoadmapChart(parent, dated);
		}

		if (undated.length > 0) {
			const bucket = parent.createDiv({ cls: 'friday-roadmap-undated' });
			bucket.createEl('h4', { text: `No date (${undated.length})` });
			const list = bucket.createDiv({ cls: 'friday-roadmap-undated-list' });
			for (const t of [...undated].sort((a, b) => this.sortByPriorityImpact(a, b))) {
				const chip = list.createSpan({ cls: 'friday-roadmap-undated-chip', text: t.title });
				chip.addEventListener('click', () => this.onTopicClick(t));
			}
		}
	}

	private renderRoadmapToggle(
		parent: HTMLElement,
		label: string,
		options: { key: string; label: string }[],
		current: string,
		onPick: (key: string) => void,
	): void {
		const group = parent.createDiv({ cls: 'friday-roadmap-toggle' });
		group.createSpan({ cls: 'friday-roadmap-toggle-label', text: `${label}:` });
		for (const opt of options) {
			const btn = group.createEl('button', { cls: 'friday-topics-modebtn', text: opt.label });
			if (opt.key === current) btn.addClass('friday-topics-modebtn-active');
			btn.addEventListener('click', () => onPick(opt.key));
		}
	}

	/** A topic's time span [start → due]. start = startedAt when earlier than due, else due
	 *  (a point marker). Null when the topic has no due date (→ the "No date" bucket). */
	private computeTopicSpan(topic: SprintTopic): { startMs: number; endMs: number } | null {
		if (!topic.dueDate) return null;
		const endMs = new Date(topic.dueDate + 'T00:00:00').getTime();
		if (isNaN(endMs)) return null;
		let startMs = endMs;
		if (topic.startedAt) {
			const s = new Date(topic.startedAt + 'T00:00:00').getTime();
			if (!isNaN(s) && s < endMs) startMs = s;
		}
		return { startMs, endMs };
	}

	private renderRoadmapChart(parent: HTMLElement, dated: RoadmapItem[]): void {
		const now = new Date();
		const todayMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
		const DAY = 86400000;
		const minMs = Math.min(todayMs, ...dated.map(d => d.startMs)) - 2 * DAY;
		const maxMs = Math.max(todayMs, ...dated.map(d => d.endMs)) + 2 * DAY;
		const span = Math.max(maxMs - minMs, DAY);
		const pct = (ms: number) => ((ms - minMs) / span) * 100;
		const unit: 'week' | 'month' = (this.roadmapZoom === 'month' || span / (7 * DAY) > 26) ? 'month' : 'week';

		const chart = parent.createDiv({ cls: 'friday-roadmap-chart' });

		const axis = chart.createDiv({ cls: 'friday-roadmap-axis' });
		for (const tick of this.buildTicks(minMs, maxMs, unit)) {
			const tx = pct(tick.ms);
			if (tx < 0 || tx > 100) continue;
			const tickEl = axis.createDiv({ cls: 'friday-roadmap-tick' });
			tickEl.style.left = `${tx}%`;
			tickEl.createSpan({ cls: 'friday-roadmap-tick-label', text: tick.label });
		}
		const todayLine = axis.createDiv({ cls: 'friday-roadmap-today' });
		todayLine.style.left = `${pct(todayMs)}%`;
		todayLine.setAttribute('title', 'Today');

		const critical = new Set(criticalPath(this.topics));
		const deriveBlock = this.makeDeriveBlock();

		for (const [groupLabel, items] of this.groupForRoadmap(dated)) {
			const lane = chart.createDiv({ cls: 'friday-roadmap-lane' });
			lane.createDiv({ cls: 'friday-roadmap-lane-header', text: groupLabel });
			for (const { topic, startMs, endMs } of items) {
				const row = lane.createDiv({ cls: 'friday-roadmap-row' });
				const labelEl = row.createDiv({ cls: 'friday-roadmap-row-label' });
				if (topic.blockedBy.length > 0) {
					const glyph = labelEl.createSpan({ text: '⛓ ' });
					const blockers = (this.depIndex?.blockersOf(topic) ?? []).map(b => b.title).join(', ');
					glyph.setAttribute('title', blockers ? `Blocked by: ${blockers}` : 'Has dependencies');
				}
				labelEl.createSpan({ text: topic.title });

				const track = row.createDiv({ cls: 'friday-roadmap-track' });
				const left = pct(startMs);
				const width = Math.max(pct(endMs) - left, 1.5);
				const bar = track.createDiv({ cls: 'friday-roadmap-bar' });
				bar.style.left = `${left}%`;
				bar.style.width = `${width}%`;
				if (deriveBlock(topic).state === 'blocked') bar.addClass('is-blocked');
				if (topic.status === 'done') bar.addClass('is-done');
				if (topic.status !== 'done' && this.isOverdue(topic.dueDate!)) bar.addClass('is-overdue');
				if (critical.has(topic.filePath)) bar.addClass('is-critical');
				bar.setAttribute('title', `${topic.title} · due ${topic.dueDate}`);
				bar.addEventListener('click', () => this.onTopicClick(topic));
			}
		}
	}

	private buildTicks(minMs: number, maxMs: number, unit: 'week' | 'month'): { ms: number; label: string }[] {
		const ticks: { ms: number; label: string }[] = [];
		if (unit === 'week') {
			let d = getWeekStartConfigurable(new Date(minMs), this.settings.weekStartDay ?? 1);
			while (d.getTime() <= maxMs) {
				ticks.push({ ms: d.getTime(), label: formatWeekId(getWeekId(d)) });
				const next = new Date(d);
				next.setDate(next.getDate() + 7);
				d = next;
			}
		} else {
			let d = new Date(new Date(minMs).getFullYear(), new Date(minMs).getMonth(), 1);
			while (d.getTime() <= maxMs) {
				ticks.push({ ms: d.getTime(), label: `${ROADMAP_MONTHS[d.getMonth()]} '${String(d.getFullYear()).slice(2)}` });
				d = new Date(d.getFullYear(), d.getMonth() + 1, 1);
			}
		}
		return ticks;
	}

	private groupForRoadmap(dated: RoadmapItem[]): Map<string, RoadmapItem[]> {
		const groups = new Map<string, RoadmapItem[]>();
		const keyFor = (t: SprintTopic): string => {
			if (this.roadmapGroupBy === 'status') return this.statusLabel(t.status);
			if (!t.assignee) return 'Unassigned';
			const m = (this.settings.teamMembers ?? []).find(x => x.email === t.assignee);
			return m ? (m.nickname || m.fullName || t.assignee) : t.assignee;
		};
		for (const item of dated) {
			const k = keyFor(item.topic);
			const arr = groups.get(k) ?? [];
			arr.push(item);
			groups.set(k, arr);
		}
		for (const arr of groups.values()) arr.sort((a, b) => a.startMs - b.startMs);
		return groups;
	}

	destroy(): void {
		this.el.empty();
	}
}
