import { Notice } from 'obsidian';
import { PluginSettings, SprintTopic, TopicStatus, Priority, TopicImpact, TopicEffort } from '../../types';
import { SprintTopicService } from '../../services/sprintTopicService';
import { JiraService } from '../../services/jiraService';
import { deriveTopicBlock, toJiraSignal } from '../../services/topicStatus';
import { buildTopicIndex, TopicIndex, criticalPath } from '../../services/topicGraph';
import { getWeekStartConfigurable, getISOWeekNumber, resolveDoneWindowDays, daysSinceIso } from '../../utils/dateUtils';
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

/** Roadmap timeline zoom levels and their fixed pixels-per-day scale.
 *  day = fine-grained (day columns), week = balanced default, month = far-out overview. */
type RoadmapZoom = 'day' | 'week' | 'month';
const ROADMAP_PX_PER_DAY: Record<RoadmapZoom, number> = { day: 30, week: 13, month: 4.4 };
const DAY_MS = 86400000;
/** Width of the frozen left column (group/topic labels). Must match CSS --friday-roadmap-label-w. */
const ROADMAP_LABEL_W = 168;
/** Height of the two-tier time axis header. */
const ROADMAP_AXIS_H = 38;
/** Past / future scroll room guaranteed around today, in days, regardless of topic dates. */
const ROADMAP_PAST_PAD = 60;
const ROADMAP_FUTURE_PAD = 240;
/** Above this many days, day-zoom stops drawing per-day gridlines/labels (keeps the DOM light). */
const ROADMAP_MAX_DAY_TICKS = 540;

export class TopicsOverviewView {
	private el: HTMLElement;
	private subMode: TopicsSubMode = 'board';
	private roadmapZoom: RoadmapZoom = 'week';
	private roadmapGroupBy: 'assignee' | 'status' = 'assignee';
	/** Timeline date (ms) kept at the viewport centre across zoom + repaint. null = centre on today. */
	private roadmapCenterMs: number | null = null;
	/** The element the roadmap paints into — lets zoom/group/today repaint without a full view re-render. */
	private roadmapBody: HTMLElement | null = null;
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
			this.renderEmptyState(body);
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

	/** Empty body. Distinguishes a genuine first run (no topic files at all) from an
	 *  over-eager filter, so a fresh install — which lands here, since Topics is the default
	 *  view — gets guided onboarding instead of a misleading "no match" message. */
	private renderEmptyState(body: HTMLElement): void {
		if (this.topics.length === 0) {
			const panel = body.createDiv({ cls: 'friday-topics-firstrun' });
			panel.createDiv({ cls: 'friday-topics-firstrun-title', text: 'No topics yet' });
			panel.createDiv({
				cls: 'friday-topics-firstrun-body',
				text: 'Topics are the strategic layer above your tasks — one note per initiative, each with a Kanban status, priority, owner, and optional JIRA link. Track them on the Board, size them on the Impact / Effort matrix, or schedule them on the Roadmap.',
			});
			const cta = panel.createEl('button', { cls: 'friday-btn friday-topics-firstrun-cta', text: '+ Create your first topic' });
			cta.addEventListener('click', () => this.onNewTopic());
			panel.createDiv({
				cls: 'friday-topics-firstrun-note',
				text: `Topic files live in ${this.settings.sprintTopicsPath} — change this under Settings → Topics.`,
			});
			return;
		}

		// Topics exist but the current scope/assignee/search hides them all.
		const empty = body.createDiv({ cls: 'friday-empty' });
		empty.createSpan({ text: 'No topics match the current filter.' });
		if (this.scope !== 'all' || this.assigneeFilter !== 'all') {
			const clear = empty.createEl('button', { cls: 'friday-topics-clear-filters', text: 'Clear filters' });
			clear.addEventListener('click', () => {
				this.scope = 'all';
				this.assigneeFilter = 'all';
				this.render();
			});
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

		// Native done-window filter: hide topics that have been Done for longer than the
		// configured window (settings.hideDoneAfterDays, default 14) so the default surfaces
		// stay focused on live + recently-finished work. Mirrors the JIRA Dashboard filter.
		// The "Done" scope is the escape hatch that still shows every completed topic. Dates
		// each topic by doneAt (falling back to statusSince); undateable topics are kept.
		if (this.scope !== 'archived') {
			const windowDays = resolveDoneWindowDays(this.settings.hideDoneAfterDays);
			filtered = filtered.filter(t => {
				if (t.status !== 'done') return true;
				const age = daysSinceIso(t.doneAt ?? t.statusSince);
				if (age === null) return true;
				return age <= windowDays;
			});
		}

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
		// Parse as LOCAL midnight (matches computeTopicSpan / daysBetween). A bare `new Date(dueIso)`
		// parses YYYY-MM-DD as UTC midnight, which flags due-today topics overdue a day early in
		// UTC-negative timezones.
		const due = new Date(dueIso + 'T00:00:00');
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

			const sorted = [...group].sort((a, b) => this.sortByOrder(a, b));
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

			// Capture the drop position within the target column BEFORE any async write —
			// the DOM is torn down on the re-render that the writes trigger.
			const dropIndex = this.computeDropIndex(zone, e.clientY, filePath);

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
				// Persist the intra-column position so hand-ordering survives the next refresh.
				await this.persistColumnOrder(targetStatus, topic, dropIndex);
			} finally {
				this.isDragging.value = false;
			}
		});
	}

	/** How many non-dragged cards in this column sit above the pointer — the insertion index. */
	private computeDropIndex(zone: HTMLElement, clientY: number, draggedPath: string): number {
		const cards = Array.from(zone.querySelectorAll<HTMLElement>('.friday-kanban-card'));
		let idx = 0;
		for (const card of cards) {
			if (card.dataset.filepath === draggedPath) continue;
			const rect = card.getBoundingClientRect();
			if (clientY > rect.top + rect.height / 2) idx++;
			else break;
		}
		return idx;
	}

	/** Renumber the `status` column so `dropped` lands at `dropIndex`, writing only the
	 *  cards whose sortOrder actually changes. Sequential 0..n keeps later inserts (default
	 *  sortOrder 999) sorting to the end until they too are dragged. */
	private async persistColumnOrder(status: TopicStatus, dropped: SprintTopic, dropIndex: number): Promise<void> {
		const column = this.topics
			.filter(t => t.status === status && t.filePath !== dropped.filePath)
			.sort((a, b) => this.sortByOrder(a, b));
		const clamped = Math.max(0, Math.min(dropIndex, column.length));
		column.splice(clamped, 0, dropped);
		const writes: Promise<void>[] = [];
		column.forEach((t, i) => {
			if ((t.sortOrder ?? 999) !== i) writes.push(this.topicService.updateSortOrder(t.filePath, i));
		});
		await Promise.all(writes);
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
		const card = renderTopicCard(parent, topic, {
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
		// button opens the full modal for the long tail of fields.
		const actions = (card.querySelector('.friday-kanban-card-actions') as HTMLElement | null)
			|| card.createDiv({ cls: 'friday-kanban-card-actions' });
		const editBtn = actions.createEl('button', { text: 'Edit' });
		editBtn.setAttribute('title', 'Edit topic details');
		editBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.onEditTopic(topic);
		});

		// Inline quick-edit for the high-churn triage fields, so common tweaks don't need the modal.
		this.addQuickEdit(card, topic);
	}

	/** Compact inline dropdowns for the fields a lead changes most while grooming — status,
	 *  priority, impact, effort, assignee. Especially the Impact/Effort "Inbox", whose whole
	 *  job is sizing topics. Interactions are isolated from the card's drag/click handlers. */
	private addQuickEdit(card: HTMLElement, topic: SprintTopic): void {
		const row = card.createDiv({ cls: 'friday-topic-quickedit' });
		// Don't let interacting with a control start a card drag or open the file.
		row.addEventListener('click', (e) => e.stopPropagation());
		row.addEventListener('pointerdown', (e) => e.stopPropagation());
		row.addEventListener('dragstart', (e) => { e.preventDefault(); e.stopPropagation(); });

		const addSelect = (
			title: string,
			options: Array<{ value: string; label: string }>,
			current: string,
			onPick: (value: string) => void | Promise<void>,
		): void => {
			const sel = row.createEl('select', { cls: 'friday-topic-qe' });
			sel.setAttribute('title', title);
			sel.setAttribute('aria-label', title);
			for (const opt of options) {
				const o = sel.createEl('option', { text: opt.label });
				o.value = opt.value;
				if (opt.value === current) o.selected = true;
			}
			sel.addEventListener('change', (e) => {
				e.stopPropagation();
				void onPick(sel.value);
			});
		};

		addSelect('Status', [
			{ value: 'backlog', label: 'Backlog' },
			{ value: 'open', label: 'To Do' },
			{ value: 'in-progress', label: 'In Progress' },
			{ value: 'done', label: 'Done' },
		], topic.status, (v) => this.topicService.setTopicStatus(topic.filePath, v as TopicStatus));

		addSelect('Priority', [
			{ value: Priority.None, label: 'Prio —' },
			{ value: Priority.High, label: 'Prio: High' },
			{ value: Priority.Medium, label: 'Prio: Med' },
			{ value: Priority.Low, label: 'Prio: Low' },
		], topic.priority, (v) => this.topicService.updateTopicFrontmatter(topic.filePath, { priority: v }));

		addSelect('Impact', [
			{ value: '', label: 'Impact —' },
			{ value: 'critical', label: 'Impact: Critical' },
			{ value: 'high', label: 'Impact: High' },
			{ value: 'medium', label: 'Impact: Medium' },
			{ value: 'low', label: 'Impact: Low' },
		], topic.impact ?? '', (v) => this.topicService.setTopicImpact(topic.filePath, (v || null) as TopicImpact | null));

		addSelect('Effort', [
			{ value: '', label: 'Effort —' },
			{ value: 'xs', label: 'Effort: XS' },
			{ value: 's', label: 'Effort: S' },
			{ value: 'm', label: 'Effort: M' },
			{ value: 'l', label: 'Effort: L' },
			{ value: 'xl', label: 'Effort: XL' },
		], topic.effort ?? '', (v) => this.topicService.setTopicEffort(topic.filePath, (v || null) as TopicEffort | null));

		const members = (this.settings.teamMembers ?? []).filter(m => m.active);
		if (members.length > 0) {
			const opts = [
				{ value: '', label: 'Owner —' },
				...members.map(m => ({ value: m.email, label: m.nickname || m.fullName || m.email })),
			];
			// Preserve an out-of-team current assignee so the select doesn't silently clear it.
			if (topic.assignee && !members.some(m => m.email === topic.assignee)) {
				opts.push({ value: topic.assignee, label: topic.assignee });
			}
			addSelect('Assignee', opts, topic.assignee ?? '',
				(v) => this.topicService.updateTopicFrontmatter(topic.filePath, { assignee: v || null }));
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

	/** Board column ordering: honor the manual sortOrder first (lower = higher), falling back
	 *  to priority/impact for topics that have never been hand-ordered (default 999). */
	private sortByOrder(a: SprintTopic, b: SprintTopic): number {
		const ao = a.sortOrder ?? 999;
		const bo = b.sortOrder ?? 999;
		if (ao !== bo) return ao - bo;
		return this.sortByPriorityImpact(a, b);
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

	// ── Roadmap sub-mode (planned start→end timeline) ─────────────
	//
	// A scrollable, zoomable Gantt-style timeline. Distances are meaningful: it uses a
	// fixed pixels-per-day scale (per zoom level) rather than fitting everything to width.
	// The user scrolls past/future (scrollbar, drag-to-pan, or Shift+wheel) and zooms
	// between day / week / month. It opens centred on the current week. Each bar runs the
	// topic's startDate → dueDate (falling back to startedAt) so topics scheduled only via a
	// due date still appear.

	private renderRoadmap(parent: HTMLElement, topics: SprintTopic[]): void {
		this.roadmapBody = parent;
		parent.empty();

		// Completed topics are dropped from the roadmap to conserve vertical space — unless the
		// user has explicitly scoped to "Done" (the archived filter), where showing them is the point.
		const roadmapTopics = this.scope === 'archived' ? topics : topics.filter(t => t.status !== 'done');
		const hiddenDone = topics.length - roadmapTopics.length;

		const controls = parent.createDiv({ cls: 'friday-roadmap-controls' });
		this.renderRoadmapToggle(controls, 'Zoom', [
			{ key: 'day', label: 'Day' },
			{ key: 'week', label: 'Week' },
			{ key: 'month', label: 'Month' },
		], this.roadmapZoom, (k) => this.setRoadmapZoom(k as RoadmapZoom));
		this.renderRoadmapToggle(controls, 'Group', [
			{ key: 'assignee', label: 'Assignee' },
			{ key: 'status', label: 'Status' },
		], this.roadmapGroupBy, (k) => { this.roadmapGroupBy = k as 'assignee' | 'status'; this.repaintRoadmap(); });

		const todayBtn = controls.createEl('button', { cls: 'friday-topics-modebtn', text: '⌖ Today' });
		todayBtn.setAttribute('title', 'Recentre the timeline on the current week');
		todayBtn.addEventListener('click', () => { this.roadmapCenterMs = null; this.repaintRoadmap(); });

		const hint = hiddenDone > 0
			? `Drag to pan · Shift+scroll · ${hiddenDone} done hidden`
			: 'Drag to pan · Shift+scroll';
		controls.createSpan({ cls: 'friday-roadmap-hint', text: hint });

		const dated: RoadmapItem[] = [];
		const undated: SprintTopic[] = [];
		for (const t of roadmapTopics) {
			const span = this.computeTopicSpan(t);
			if (span) dated.push({ topic: t, startMs: span.startMs, endMs: span.endMs });
			else undated.push(t);
		}

		if (dated.length === 0) {
			parent.createDiv({
				cls: 'friday-empty',
				text: roadmapTopics.length === 0 && hiddenDone > 0
					? `All ${hiddenDone} topic(s) here are done and hidden from the roadmap — use the 'Done' scope filter to view them.`
					: 'No topics with a start, end, or due date to place on the roadmap. Set a Roadmap schedule (Start → End) on a topic to add it here.',
			});
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

	/** Repaint just the roadmap (zoom / group / recenter) without tearing down the whole view. */
	private repaintRoadmap(): void {
		if (this.roadmapBody) this.renderRoadmap(this.roadmapBody, this.applyFilters(this.topics));
	}

	/** Change zoom level. The scroll handler keeps roadmapCenterMs current, so repainting
	 *  at the new scale lands the same date back under the viewport centre. */
	private setRoadmapZoom(zoom: RoadmapZoom): void {
		if (zoom === this.roadmapZoom) return;
		this.roadmapZoom = zoom;
		this.repaintRoadmap();
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

	/** A topic's planned span [start → end] in ms. The bar runs startDate → dueDate:
	 *  start prefers the explicit estimate (startDate), falling back to the actual start
	 *  (startedAt) then dueDate; end prefers dueDate, falling back to startDate / startedAt.
	 *  So a topic scheduled only via a due date still renders (as a point/short bar). Null
	 *  only when the topic carries none of these dates (→ the "No date" tray). */
	private computeTopicSpan(topic: SprintTopic): { startMs: number; endMs: number } | null {
		const toMs = (iso: string | null): number | null => {
			if (!iso) return null;
			const t = new Date(iso + 'T00:00:00').getTime();
			return isNaN(t) ? null : t;
		};
		const sd = toMs(topic.startDate);
		const started = toMs(topic.startedAt);
		const due = toMs(topic.dueDate);
		const startMs = sd ?? started ?? due;
		let endMs = due ?? sd ?? started;
		if (startMs == null || endMs == null) return null;
		if (endMs < startMs) endMs = startMs;
		return { startMs, endMs };
	}

	private renderRoadmapChart(parent: HTMLElement, dated: RoadmapItem[]): void {
		const pxPerDay = ROADMAP_PX_PER_DAY[this.roadmapZoom];
		const weekStartDay = this.settings.weekStartDay ?? 1;

		const now = new Date();
		const todayMs = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

		// Domain spans all dated topics, but always guarantees scroll room around today.
		let earliest = Math.min(todayMs, ...dated.map(d => d.startMs));
		let latest = Math.max(todayMs, ...dated.map(d => d.endMs));
		earliest = Math.min(earliest, todayMs - ROADMAP_PAST_PAD * DAY_MS);
		latest = Math.max(latest, todayMs + ROADMAP_FUTURE_PAD * DAY_MS);
		// Align the canvas start to a week boundary (clean week gridlines) and pad both ends.
		const canvasStartMs = getWeekStartConfigurable(new Date(earliest), weekStartDay).getTime() - 7 * DAY_MS;
		const canvasEndMs = latest + 14 * DAY_MS;
		const totalDays = Math.max(1, Math.round((canvasEndMs - canvasStartMs) / DAY_MS));
		const totalPx = totalDays * pxPerDay;
		const dayOffset = (ms: number): number => Math.round(((ms - canvasStartMs) / DAY_MS) * pxPerDay);

		const scroll = parent.createDiv({ cls: 'friday-roadmap-scroll' });
		const canvas = scroll.createDiv({ cls: 'friday-roadmap-canvas' });
		canvas.style.width = `${ROADMAP_LABEL_W + totalPx}px`;

		// ── Grid overlay (behind the lanes): weekend shading, gridlines, today line.
		const grid = canvas.createDiv({ cls: 'friday-roadmap-grid' });
		grid.style.left = `${ROADMAP_LABEL_W}px`;
		grid.style.width = `${totalPx}px`;
		grid.style.top = `${ROADMAP_AXIS_H}px`;

		const showDays = this.roadmapZoom === 'day' && totalDays <= ROADMAP_MAX_DAY_TICKS;
		// Walk real dates (not fixed-ms steps) so getDay()/getDate() stay correct across DST.
		const gridWalker = new Date(canvasStartMs);
		for (let i = 0; i <= totalDays; i++, gridWalker.setDate(gridWalker.getDate() + 1)) {
			const x = i * pxPerDay;
			const dow = gridWalker.getDay();
			const isWeekStart = dow === weekStartDay;
			if (showDays) {
				if (dow === 0 || dow === 6) {
					const wk = grid.createDiv({ cls: 'friday-roadmap-weekend' });
					wk.style.left = `${x}px`;
					wk.style.width = `${pxPerDay}px`;
				}
				const gl = grid.createDiv({ cls: `friday-roadmap-gridline${isWeekStart ? ' is-week' : ''}` });
				gl.style.left = `${x}px`;
			} else if (isWeekStart && this.roadmapZoom !== 'month') {
				const gl = grid.createDiv({ cls: 'friday-roadmap-gridline is-week' });
				gl.style.left = `${x}px`;
			}
		}
		// Month gridlines (the primary lines at month zoom; section dividers otherwise).
		for (let m = new Date(new Date(canvasStartMs).getFullYear(), new Date(canvasStartMs).getMonth(), 1);
			m.getTime() <= canvasEndMs; m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) {
			if (m.getTime() < canvasStartMs) continue;
			const gl = grid.createDiv({ cls: 'friday-roadmap-gridline is-month' });
			gl.style.left = `${dayOffset(m.getTime())}px`;
		}
		const todayLine = grid.createDiv({ cls: 'friday-roadmap-today' });
		todayLine.style.left = `${dayOffset(todayMs)}px`;
		todayLine.setAttribute('title', 'Today');

		// ── Two-tier time axis header.
		const axis = canvas.createDiv({ cls: 'friday-roadmap-axis' });
		axis.style.height = `${ROADMAP_AXIS_H}px`;
		const axisCorner = axis.createDiv({ cls: 'friday-roadmap-axis-corner' });
		axisCorner.style.width = `${ROADMAP_LABEL_W}px`;
		const axisTrack = axis.createDiv({ cls: 'friday-roadmap-axis-track' });
		axisTrack.style.width = `${totalPx}px`;
		const tier1 = axisTrack.createDiv({ cls: 'friday-roadmap-axis-tier1' });
		const tier2 = axisTrack.createDiv({ cls: 'friday-roadmap-axis-tier2' });
		this.buildAxisTiers(tier1, tier2, canvasStartMs, canvasEndMs, dayOffset, weekStartDay);

		// ── Lanes (grouped) with bars.
		const critical = new Set(criticalPath(this.topics));
		const deriveBlock = this.makeDeriveBlock();
		const lanes = canvas.createDiv({ cls: 'friday-roadmap-lanes' });

		for (const [groupLabel, items] of this.groupForRoadmap(dated)) {
			const lane = lanes.createDiv({ cls: 'friday-roadmap-lane' });
			const laneHeader = lane.createDiv({ cls: 'friday-roadmap-lane-header', text: groupLabel });
			laneHeader.style.width = `${ROADMAP_LABEL_W}px`;
			for (const { topic, startMs, endMs } of items) {
				const row = lane.createDiv({ cls: 'friday-roadmap-row' });
				const labelEl = row.createDiv({ cls: 'friday-roadmap-row-label' });
				labelEl.style.width = `${ROADMAP_LABEL_W}px`;
				if (topic.blockedBy.length > 0) {
					const glyph = labelEl.createSpan({ text: '⛓ ' });
					const blockers = (this.depIndex?.blockersOf(topic) ?? []).map(b => b.title).join(', ');
					glyph.setAttribute('title', blockers ? `Blocked by: ${blockers}` : 'Has dependencies');
				}
				const titleSpan = labelEl.createSpan({ cls: 'friday-roadmap-row-title', text: topic.title });
				titleSpan.addEventListener('click', () => this.onTopicClick(topic));

				const track = row.createDiv({ cls: 'friday-roadmap-track' });
				track.style.width = `${totalPx}px`;
				const left = dayOffset(startMs);
				// End day is inclusive, so a span of N calendar days is (N+1) day-columns wide.
				const width = Math.max(dayOffset(endMs) - left + pxPerDay, Math.max(pxPerDay, 6));
				const bar = track.createDiv({ cls: 'friday-roadmap-bar' });
				bar.style.left = `${left}px`;
				bar.style.width = `${width}px`;
				const deadline = topic.dueDate;
				if (deriveBlock(topic).state === 'blocked') bar.addClass('is-blocked');
				if (topic.status === 'done') bar.addClass('is-done');
				if (topic.status !== 'done' && deadline && this.isOverdue(deadline)) bar.addClass('is-overdue');
				if (critical.has(topic.filePath)) bar.addClass('is-critical');
				bar.setAttribute('title', `${topic.title} · ${this.formatSpanLabel(topic, startMs, endMs)}`);
				if (width > 54) bar.createSpan({ cls: 'friday-roadmap-bar-label', text: topic.title });
				bar.addEventListener('click', (e) => { e.stopPropagation(); this.onTopicClick(topic); });
			}
		}

		// ── Interaction: drag-to-pan, keep centre date current on scroll, open centred.
		this.installRoadmapPan(scroll);
		scroll.addEventListener('scroll', () => {
			const visibleTrack = Math.max(0, scroll.clientWidth - ROADMAP_LABEL_W);
			const offsetPx = scroll.scrollLeft + visibleTrack / 2;
			this.roadmapCenterMs = canvasStartMs + (offsetPx / pxPerDay) * DAY_MS;
		});
		this.centerRoadmap(scroll, canvasStartMs, pxPerDay, todayMs);
	}

	/** Build the two axis tiers. Tier 1 is the coarse band (months, or years at month zoom);
	 *  tier 2 is the fine ruler (day numbers / week numbers / month names). */
	private buildAxisTiers(
		tier1: HTMLElement,
		tier2: HTMLElement,
		canvasStartMs: number,
		canvasEndMs: number,
		dayOffset: (ms: number) => number,
		weekStartDay: number,
	): void {
		const place = (parent: HTMLElement, cls: string, x: number, text: string): void => {
			const el = parent.createSpan({ cls, text });
			el.style.left = `${x}px`;
		};

		// Tier 1
		if (this.roadmapZoom === 'month') {
			const endY = new Date(canvasEndMs).getFullYear();
			for (let y = new Date(canvasStartMs).getFullYear(); y <= endY; y++) {
				place(tier1, 'friday-roadmap-tick1', dayOffset(Math.max(new Date(y, 0, 1).getTime(), canvasStartMs)), String(y));
			}
		} else {
			for (let m = new Date(new Date(canvasStartMs).getFullYear(), new Date(canvasStartMs).getMonth(), 1);
				m.getTime() <= canvasEndMs; m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) {
				const label = `${ROADMAP_MONTHS[m.getMonth()]} '${String(m.getFullYear()).slice(2)}`;
				place(tier1, 'friday-roadmap-tick1', dayOffset(Math.max(m.getTime(), canvasStartMs)), label);
			}
		}

		// Tier 2
		const totalDays = Math.round((canvasEndMs - canvasStartMs) / DAY_MS);
		const denseDays = this.roadmapZoom === 'day' && totalDays <= ROADMAP_MAX_DAY_TICKS;
		if (denseDays) {
			const walker = new Date(canvasStartMs);
			for (let i = 0; i <= totalDays; i++, walker.setDate(walker.getDate() + 1)) {
				const el = tier2.createSpan({ cls: 'friday-roadmap-tick2', text: String(walker.getDate()) });
				el.style.left = `${i * (ROADMAP_PX_PER_DAY[this.roadmapZoom])}px`;
				if (walker.getDay() === 0 || walker.getDay() === 6) el.addClass('is-weekend');
			}
		} else if (this.roadmapZoom === 'week' || this.roadmapZoom === 'day') {
			for (let d = getWeekStartConfigurable(new Date(canvasStartMs), weekStartDay); d.getTime() <= canvasEndMs;) {
				place(tier2, 'friday-roadmap-tick2', dayOffset(d.getTime()), `W${getISOWeekNumber(d)}`);
				const next = new Date(d); next.setDate(next.getDate() + 7); d = next;
			}
		} else {
			for (let m = new Date(new Date(canvasStartMs).getFullYear(), new Date(canvasStartMs).getMonth(), 1);
				m.getTime() <= canvasEndMs; m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) {
				place(tier2, 'friday-roadmap-tick2', dayOffset(Math.max(m.getTime(), canvasStartMs)), ROADMAP_MONTHS[m.getMonth()]);
			}
		}
	}

	/** Human-readable span for a bar tooltip, e.g. "3 Jun 2026 → 18 Jun 2026 · due 2026-06-20". */
	private formatSpanLabel(topic: SprintTopic, startMs: number, endMs: number): string {
		const fmt = (ms: number): string => {
			const d = new Date(ms);
			return `${d.getDate()} ${ROADMAP_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
		};
		const parts = [startMs === endMs ? fmt(startMs) : `${fmt(startMs)} → ${fmt(endMs)}`];
		if (topic.dueDate) parts.push(`due ${topic.dueDate}`);
		return parts.join(' · ');
	}

	/** Scroll the timeline so the focus date (roadmapCenterMs, or today on first open)
	 *  sits in the middle of the visible track area. Re-applied on the next frame because
	 *  clientWidth can be 0 until the element is laid out. */
	private centerRoadmap(scroll: HTMLElement, canvasStartMs: number, pxPerDay: number, todayMs: number): void {
		const focusMs = this.roadmapCenterMs ?? todayMs;
		const apply = (): void => {
			const visibleTrack = Math.max(0, scroll.clientWidth - ROADMAP_LABEL_W);
			const offsetPx = ((focusMs - canvasStartMs) / DAY_MS) * pxPerDay;
			const maxScroll = Math.max(0, scroll.scrollWidth - scroll.clientWidth);
			scroll.scrollLeft = Math.max(0, Math.min(offsetPx - visibleTrack / 2, maxScroll));
		};
		apply();
		window.requestAnimationFrame(apply);
	}

	/** Drag anywhere on the timeline background to pan horizontally. Drags that start on a
	 *  bar or a frozen label are ignored so their click handlers still fire. */
	private installRoadmapPan(scroll: HTMLElement): void {
		let dragging = false;
		let startX = 0;
		let startY = 0;
		let startLeft = 0;
		let startTop = 0;
		scroll.addEventListener('pointerdown', (e: PointerEvent) => {
			if (e.button !== 0) return;
			const target = e.target as HTMLElement;
			if (target.closest('.friday-roadmap-bar, .friday-roadmap-row-title, .friday-roadmap-undated-chip')) return;
			dragging = true;
			startX = e.clientX;
			startY = e.clientY;
			startLeft = scroll.scrollLeft;
			startTop = scroll.scrollTop;
			scroll.addClass('is-grabbing');
			try { scroll.setPointerCapture(e.pointerId); } catch { /* ignore */ }
		});
		scroll.addEventListener('pointermove', (e: PointerEvent) => {
			if (!dragging) return;
			// Pan both axes — horizontal across the timeline, vertical through the lanes.
			scroll.scrollLeft = startLeft - (e.clientX - startX);
			scroll.scrollTop = startTop - (e.clientY - startY);
		});
		const end = (e: PointerEvent): void => {
			if (!dragging) return;
			dragging = false;
			scroll.removeClass('is-grabbing');
			try { scroll.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
		};
		scroll.addEventListener('pointerup', end);
		scroll.addEventListener('pointercancel', end);
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
