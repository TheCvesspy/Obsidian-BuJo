import { Notice } from 'obsidian';
import { PluginSettings, Sprint, SprintTopic, TopicStatus, Priority, TopicImpact, TopicEffort } from '../../types';
import { SprintService } from '../../services/sprintService';
import { SprintTopicService } from '../../services/sprintTopicService';
import { JiraService } from '../../services/jiraService';
import { renderTopicCard } from './TopicCard';

/** A list section's drop behavior. Backlog clears sprint; status sections set status
 *  (and auto-assign to the active sprint when dragged from backlog). */
type SectionDropAction =
	| { kind: 'setStatus'; status: TopicStatus }
	| { kind: 'moveToBacklog' };

type SubMode = 'list' | 'impactEffort' | 'eisenhower';
type ScopeFilter = 'all' | 'active' | 'backlog' | 'archived';

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

export class TopicsOverviewView {
	private el: HTMLElement;
	private subMode: SubMode = 'list';
	private scope: ScopeFilter = 'all';
	/** 'all' | 'unassigned' | team member email. Persists across re-renders of this view instance. */
	private assigneeFilter: string = 'all';

	constructor(
		private container: HTMLElement,
		private topics: SprintTopic[],
		private sprintService: SprintService,
		private topicService: SprintTopicService,
		private settings: PluginSettings,
		private onTopicClick: (topic: SprintTopic) => void,
		private onEditTopic: (topic: SprintTopic) => void,
		private onNewTopic: () => void,
		private isDragging: { value: boolean },
		private searchQuery: string = '',
		private jiraService: JiraService | null = null,
	) {
		this.el = container.createDiv({ cls: 'friday-topics-overview' });
	}

	render(): void {
		this.el.empty();

		// Header toolbar: sub-mode toggle + scope filter + new topic
		const header = this.el.createDiv({ cls: 'friday-topics-header' });

		const modeGroup = header.createDiv({ cls: 'friday-topics-modeswitch' });
		this.renderModeButton(modeGroup, 'list', 'List');
		this.renderModeButton(modeGroup, 'impactEffort', 'Impact / Effort');
		this.renderModeButton(modeGroup, 'eisenhower', 'Eisenhower');

		const scopeGroup = header.createDiv({ cls: 'friday-topics-scope' });
		this.renderScopeButton(scopeGroup, 'all', 'All');
		this.renderScopeButton(scopeGroup, 'active', 'Active sprint');
		this.renderScopeButton(scopeGroup, 'backlog', 'Backlog');
		this.renderScopeButton(scopeGroup, 'archived', 'Archived');

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
				this.renderList(body, filtered);
				break;
			case 'impactEffort':
				this.renderImpactEffort(body, filtered);
				break;
			case 'eisenhower':
				this.renderEisenhower(body, filtered);
				break;
		}
	}

	private renderModeButton(parent: HTMLElement, mode: SubMode, label: string): void {
		const btn = parent.createEl('button', {
			cls: 'friday-topics-modebtn',
			text: label,
		});
		if (mode === this.subMode) btn.addClass('friday-topics-modebtn-active');
		btn.addEventListener('click', () => {
			this.subMode = mode;
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
		const activeSprint: Sprint | null = this.sprintService.getActiveSprint();
		const activeId = activeSprint?.id ?? null;

		let filtered = topics.filter(t => {
			switch (this.scope) {
				case 'active':
					return activeId !== null && t.sprintId === activeId;
				case 'backlog':
					return !t.sprintId;
				case 'archived':
					// Archived = done with no sprint (matches archiveTopic / cancelTopic behavior)
					return t.status === 'done' && !t.sprintId;
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

	// ── List sub-mode ─────────────────────────────────────────────

	private renderList(parent: HTMLElement, topics: SprintTopic[]): void {
		// Topics with no sprint are their own "Backlog" group; the rest are split by status.
		// Each topic appears in exactly one section. All sections are drop targets:
		//   Backlog → drop clears the topic's sprint assignment (status preserved)
		//   Open/In Progress/Done → drop sets status (and auto-assigns to active sprint if the
		//   dragged topic came from Backlog).
		const backlog = topics.filter(t => !t.sprintId);
		const assigned = topics.filter(t => !!t.sprintId);

		const sections: { label: string; cls: string; topics: SprintTopic[]; dropAction: SectionDropAction }[] = [
			{ label: 'Backlog', cls: 'friday-topics-list-backlog', topics: backlog, dropAction: { kind: 'moveToBacklog' } },
			{ label: 'Open', cls: '', topics: assigned.filter(t => t.status === 'open'), dropAction: { kind: 'setStatus', status: 'open' } },
			{ label: 'In Progress', cls: '', topics: assigned.filter(t => t.status === 'in-progress'), dropAction: { kind: 'setStatus', status: 'in-progress' } },
			{ label: 'Done', cls: '', topics: assigned.filter(t => t.status === 'done'), dropAction: { kind: 'setStatus', status: 'done' } },
		];

		// Sections render side-by-side as columns (Backlog | Open | In Progress | Done).
		const board = parent.createDiv({ cls: 'friday-topics-list-board' });

		for (const { label, cls, topics: group, dropAction } of sections) {
			// Omit empty Backlog entirely if the current scope already hides backlog topics —
			// showing "Backlog (0)" alongside "Active sprint" filter is noise.
			if (group.length === 0 && label === 'Backlog' && this.scope === 'active') continue;

			const sectionCls = cls
				? `friday-topics-list-section ${cls}`
				: 'friday-topics-list-section';
			const section = board.createDiv({ cls: sectionCls });

			const headerEl = section.createDiv({ cls: 'friday-topics-list-header' });
			headerEl.createSpan({ text: label });
			headerEl.createSpan({ cls: 'friday-topics-list-count', text: `${group.length}` });

			// Card grid is the drop zone — every section accepts drops
			const cardGrid = section.createDiv({ cls: 'friday-topics-list-grid' });
			this.wireDropZone(cardGrid, dropAction);

			if (group.length === 0) {
				// Empty placeholder lives inside the drop zone so empty columns still accept drops.
				cardGrid.createDiv({ cls: 'friday-empty', text: 'No topics' });
				continue;
			}

			const sorted = [...group].sort((a, b) => this.sortByPriorityImpact(a, b));
			for (const topic of sorted) {
				// All cards are draggable — you can move freely between backlog and status sections
				this.renderOverviewCard(cardGrid, topic, { draggable: true });
			}
		}
	}

	/** Wire dragover/drop handlers on a section. The action decides what happens on drop. */
	private wireDropZone(zone: HTMLElement, action: SectionDropAction): void {
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
				if (action.kind === 'moveToBacklog') {
					// No-op if already in backlog
					if (!topic.sprintId) return;
					await this.topicService.moveTopicToBacklog(filePath);
				} else {
					// Status section: set the target status, and auto-assign to the active sprint
					// if the topic was in backlog (you can't be "In Progress" without a sprint).
					const targetStatus = action.status;
					if (!topic.sprintId) {
						const active = this.sprintService.getActiveSprint();
						if (!active) {
							new Notice('No active sprint — cannot move topic out of backlog. Create a sprint first.');
							return;
						}
						await this.topicService.assignTopicToSprint(filePath, active.id);
					}
					if (topic.status !== targetStatus) {
						await this.topicService.setTopicStatus(filePath, targetStatus);
					}
					// If a blocked topic is moved to done, auto-clear blocked (mirrors SprintView)
					if (topic.blocked && targetStatus === 'done') {
						await this.topicService.setTopicBlocked(filePath, false);
					}
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

	// ── Eisenhower sub-mode ───────────────────────────────────────

	private renderEisenhower(parent: HTMLElement, topics: SprintTopic[]): void {
		const q1: SprintTopic[] = [];
		const q2: SprintTopic[] = [];
		const q3: SprintTopic[] = [];
		const q4: SprintTopic[] = [];
		const unscheduled: SprintTopic[] = [];

		for (const topic of topics) {
			if (!topic.dueDate) {
				unscheduled.push(topic);
				continue;
			}
			const urgent = this.isUrgent(topic);
			const important = this.isImportant(topic);
			if (urgent && important) q1.push(topic);
			else if (!urgent && important) q2.push(topic);
			else if (urgent && !important) q3.push(topic);
			else q4.push(topic);
		}

		const quadrants: Quadrant[] = [
			{ key: 'q1', title: '\u{1F525} Do Now', subtitle: 'Urgent & Important', cls: 'friday-topicmx-q1', topics: q1 },
			{ key: 'q2', title: '\u{1F3AF} Plan Deep Work', subtitle: 'Important, Not Urgent', cls: 'friday-topicmx-q2', topics: q2 },
			{ key: 'q3', title: '\u{1F91D} Coordinate', subtitle: 'Urgent, Not Important', cls: 'friday-topicmx-q3', topics: q3 },
			{ key: 'q4', title: '\u{1F4E6} Batch Later', subtitle: 'Not Urgent, Not Important', cls: 'friday-topicmx-q4', topics: q4 },
		];

		const axisRow = parent.createDiv({ cls: 'friday-topicmx-axis-labels' });
		axisRow.createDiv();
		axisRow.createDiv({ cls: 'friday-topicmx-axis-label', text: 'Urgent' });
		axisRow.createDiv({ cls: 'friday-topicmx-axis-label', text: 'Not Urgent' });

		const grid = parent.createDiv({ cls: 'friday-topicmx-grid' });
		for (const q of quadrants) {
			this.renderQuadrant(grid, q);
		}

		this.renderQuadrant(parent, {
			key: 'unscheduled',
			title: 'Unscheduled',
			subtitle: 'No due date — needs scheduling',
			cls: 'friday-topicmx-inbox',
			topics: unscheduled,
		});
	}

	private isUrgent(topic: SprintTopic): boolean {
		if (!topic.dueDate) return false;
		const due = new Date(topic.dueDate);
		if (isNaN(due.getTime())) return false;
		const now = new Date();
		now.setHours(0, 0, 0, 0);
		const diffDays = (due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
		return diffDays <= this.settings.urgencyThresholdDays;
	}

	/** Important = impact {critical, high} when set; else fallback to priority {high, medium}. */
	private isImportant(topic: SprintTopic): boolean {
		if (topic.impact) return HIGH_IMPACT_SET.has(topic.impact);
		return topic.priority === Priority.High || topic.priority === Priority.Medium;
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

	destroy(): void {
		this.el.empty();
	}
}
