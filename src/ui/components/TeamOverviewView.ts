import { App, MarkdownView, Notice, WorkspaceLeaf } from 'obsidian';
import { TeamMemberPage, PluginSettings, MemberRollup, SprintTopic, JiraDashboardIssue } from '../../types';
import { VIEW_TYPE_JIRA_DASHBOARD } from '../../constants';
import { TeamMemberService, CadenceSignal } from '../../services/teamMemberService';
import { buildOneOnOneAgenda } from '../../services/teamRollupService';
import { createCadenceChip, createLoadChip } from '../icons';
import { OneOnOneModal } from '../OneOnOneModal';

export type TeamSort = 'cadence' | 'load' | 'blockers' | 'name';

export interface TeamOverviewCallbacks {
	/** Persist a flag change to `jiraDashboardActiveTab` without rescanning.
	 *  Accepts `'mine' | 'team'` — the overview always requests `'team'`. */
	onActivateJiraTeamTab?: () => Promise<void>;
}

/**
 * Team Overview — one card per visible member, ordered most-overdue first.
 * Bulky cards (one per row) suit the target team size (≤ 8 people); density
 * can come later if needed. Renders purely from service output — no writes.
 */
export class TeamOverviewView {
	constructor(
		private container: HTMLElement,
		private app: App,
		private service: TeamMemberService,
		private settings: PluginSettings,
		private callbacks: TeamOverviewCallbacks = {},
		/** Per-member roll-up, keyed by lowercased email. Empty map = cadence-only cards. */
		private rollupByEmail: Map<string, MemberRollup> = new Map(),
		/** Emails whose drill-down panel is expanded. Persisted by the parent view. */
		private expanded: Set<string> = new Set(),
		private onToggleExpand: (email: string) => void = () => {},
		private sortMode: TeamSort = 'cadence',
		private hideOnLeave: boolean = false,
		private onViewStateChange: (s: { sort: TeamSort; hideOnLeave: boolean }) => void = () => {},
	) {}

	render(): void {
		this.container.empty();
		this.container.addClass('friday-team-overview');

		const members = this.service.getVisibleMembers();

		if (members.length === 0) {
			this.renderEmptyState();
			return;
		}

		const today = new Date();
		const signals = new Map<string, CadenceSignal>();
		for (const m of members) {
			signals.set(m.folderPath, this.service.computeCadenceSignal(m, today));
		}

		// Header with a "Start 1:1" CTA + sort/filter toolbar
		const header = this.container.createDiv({ cls: 'friday-team-header' });
		header.createEl('h2', { text: 'Team', cls: 'friday-team-title' });
		const startBtn = header.createEl('button', {
			cls: 'friday-team-start-1on1 mod-cta',
			text: 'Start 1:1…',
		});
		startBtn.addEventListener('click', () => this.openOneOnOnePicker());

		this.renderToolbar(this.container);

		const visible = this.hideOnLeave ? members.filter(m => m.status !== 'on_leave') : members;
		const sorted = this.sortMembers(visible, signals);

		const grid = this.container.createDiv({ cls: 'friday-team-grid' });
		for (const member of sorted) {
			this.renderCard(grid, member, signals.get(member.folderPath)!);
		}
	}

	private renderToolbar(parent: HTMLElement): void {
		const bar = parent.createDiv({ cls: 'friday-team-toolbar' });
		bar.createSpan({ cls: 'friday-team-toolbar-label', text: 'Sort:' });
		const sorts: { key: TeamSort; label: string }[] = [
			{ key: 'cadence', label: 'Cadence' },
			{ key: 'load', label: 'Load' },
			{ key: 'blockers', label: 'Blockers' },
			{ key: 'name', label: 'Name' },
		];
		for (const s of sorts) {
			const btn = bar.createEl('button', { cls: 'friday-topics-modebtn', text: s.label });
			if (s.key === this.sortMode) btn.addClass('friday-topics-modebtn-active');
			btn.addEventListener('click', () => this.onViewStateChange({ sort: s.key, hideOnLeave: this.hideOnLeave }));
		}
		const label = bar.createEl('label', { cls: 'friday-team-toolbar-toggle' });
		const cb = label.createEl('input', { type: 'checkbox' });
		cb.checked = this.hideOnLeave;
		label.createSpan({ text: ' Hide on-leave' });
		cb.addEventListener('change', () => this.onViewStateChange({ sort: this.sortMode, hideOnLeave: cb.checked }));
	}

	private sortMembers(members: TeamMemberPage[], signals: Map<string, CadenceSignal>): TeamMemberPage[] {
		const rank: Record<string, number> = { 'overdue': 0, 'due-soon': 1, 'never': 2, 'on-track': 3, 'suspended': 4 };
		const arr = [...members];
		switch (this.sortMode) {
			case 'load':
				arr.sort((a, b) => this.committedOf(b) - this.committedOf(a) || a.name.localeCompare(b.name));
				break;
			case 'blockers':
				arr.sort((a, b) => this.blockersOf(b) - this.blockersOf(a) || a.name.localeCompare(b.name));
				break;
			case 'name':
				arr.sort((a, b) => a.name.localeCompare(b.name));
				break;
			case 'cadence':
			default:
				arr.sort((a, b) => {
					const sa = signals.get(a.folderPath)!;
					const sb = signals.get(b.folderPath)!;
					const ra = rank[sa.state] ?? 9;
					const rb = rank[sb.state] ?? 9;
					if (ra !== rb) return ra - rb;
					if (sa.state === 'overdue' && sb.state === 'overdue') return (sb.daysSince ?? 0) - (sa.daysSince ?? 0);
					return a.name.localeCompare(b.name);
				});
		}
		return arr;
	}

	private committedOf(m: TeamMemberPage): number {
		return this.rollupByEmail.get((m.email ?? '').toLowerCase())?.load.committed ?? 0;
	}

	private blockersOf(m: TeamMemberPage): number {
		const r = this.rollupByEmail.get((m.email ?? '').toLowerCase());
		return r ? r.counts.jiraBlocked + r.counts.topicsBlocked : 0;
	}

	private renderEmptyState(): void {
		const empty = this.container.createDiv({ cls: 'friday-empty' });
		empty.createEl('p', {
			text: `No team members found.`,
		});
		const hint = empty.createEl('p', { cls: 'friday-empty-hint' });
		hint.appendText(`Create a folder under `);
		hint.createEl('code', { text: this.settings.teamFolderPath });
		hint.appendText(` with a person page inside, or use the `);
		hint.createEl('em', { text: 'Generate person pages' });
		hint.appendText(` button in Friday settings.`);
	}

	private renderCard(parent: HTMLElement, member: TeamMemberPage, signal: CadenceSignal): void {
		const card = parent.createDiv({ cls: 'friday-team-card' });
		if (member.status === 'on_leave') card.addClass('is-on-leave');

		// Row 1: avatar + name + cadence chip
		const topRow = card.createDiv({ cls: 'friday-team-card-top' });
		const avatar = topRow.createDiv({ cls: 'friday-team-avatar' });
		avatar.textContent = initialsOf(member.name);

		const identityBlock = topRow.createDiv({ cls: 'friday-team-identity' });
		identityBlock.createEl('div', { cls: 'friday-team-name', text: member.name });
		if (member.role) {
			identityBlock.createEl('div', { cls: 'friday-team-role', text: member.role });
		}

		const chipRow = topRow.createDiv({ cls: 'friday-team-chips' });
		if (member.status === 'on_leave') {
			chipRow.appendChild(createCadenceChip('suspended', 'On leave'));
		} else {
			chipRow.appendChild(createCadenceChip(signal.state, formatCadenceLabel(member, signal)));
		}

		// Row 2: current focus (from the page body) + workload stats (from the roll-up).
		if (member.currentFocus) {
			card.createDiv({ cls: 'friday-team-focus', text: member.currentFocus });
		}
		const r = this.rollupByEmail.get((member.email ?? '').toLowerCase());
		if (r) {
			const stats = card.createDiv({ cls: 'friday-team-stats' });
			stats.appendChild(createLoadChip(r.load.band, `${r.load.band} · ${r.load.committed}/${r.load.target.toFixed(0)}`));
			const blocked = r.counts.jiraBlocked + r.counts.topicsBlocked;
			if (blocked > 0) {
				stats.createSpan({ cls: 'friday-team-blockbadge', text: `⛔ ${blocked}` })
					.setAttribute('title', `${blocked} blocked item(s)`);
			}
			const driving = [...r.drivingTopics.map(t => t.title), ...r.drivingJira.map(i => i.key)];
			if (driving.length > 0) {
				const shown = driving.slice(0, 3).join(', ') + (driving.length > 3 ? ` +${driving.length - 3}` : '');
				card.createDiv({ cls: 'friday-team-driving', text: `Driving: ${shown}` })
					.setAttribute('title', driving.join(', '));
			}
		}

		// Row 3: action buttons
		const actions = card.createDiv({ cls: 'friday-team-actions' });

		const openPageBtn = actions.createEl('button', { cls: 'friday-team-action', text: 'Open page' });
		openPageBtn.addEventListener('click', () => this.openFile(member.filePath));

		const startBtn = actions.createEl('button', {
			cls: 'friday-team-action',
			text: signal.state === 'overdue' ? 'Start 1:1 (overdue)' : 'Start 1:1',
		});
		if (signal.state === 'overdue') startBtn.addClass('mod-warning');
		startBtn.addEventListener('click', () => this.startOneOnOne(member));

		if (member.sessionPaths.length > 0 && member.lastOneOnOne) {
			const lastBtn = actions.createEl('button', {
				cls: 'friday-team-action',
				text: 'Last 1:1',
			});
			const lastPath = mostRecentSessionPath(member);
			lastBtn.addEventListener('click', () => this.openFile(lastPath));
		}

		if (this.settings.jiraEnabled && this.settings.jiraTeamEnabled && member.jiraIdentity) {
			const jiraBtn = actions.createEl('button', {
				cls: 'friday-team-action',
				text: 'JIRA workload →',
			});
			jiraBtn.addEventListener('click', () => this.openJiraTeamTab());
		}

		// Drill-down: an expandable panel with this member's topics + JIRA issues.
		// Toggled in place (no re-render); the expanded set is persisted by the parent.
		if (r && (r.topics.length > 0 || r.jiraIssues.length > 0)) {
			const email = (member.email ?? '').toLowerCase();
			const panel = card.createDiv({ cls: 'friday-team-drill' });
			if (this.expanded.has(email)) panel.addClass('is-open');
			this.renderDrillDown(panel, r);
			const toggleBtn = actions.createEl('button', {
				cls: 'friday-team-action',
				text: this.expanded.has(email) ? 'Hide details' : 'Details',
			});
			toggleBtn.addEventListener('click', () => {
				const open = panel.hasClass('is-open');
				panel.toggleClass('is-open', !open);
				toggleBtn.setText(!open ? 'Hide details' : 'Details');
				this.onToggleExpand(email);
			});
		}
	}

	/** Build the (initially hidden) drill-down panel: the member's topics grouped by column
	 *  and their JIRA issues, both clickable, with blocked/flagged items marked. */
	private renderDrillDown(panel: HTMLElement, r: MemberRollup): void {
		if (r.topics.length > 0) {
			const sec = panel.createDiv({ cls: 'friday-team-drill-sec' });
			sec.createDiv({ cls: 'friday-team-drill-h', text: 'Topics' });
			const order: { status: SprintTopic['status']; label: string }[] = [
				{ status: 'in-progress', label: 'In Progress' },
				{ status: 'open', label: 'To Do' },
				{ status: 'backlog', label: 'Backlog' },
				{ status: 'done', label: 'Done' },
			];
			for (const { status, label } of order) {
				for (const t of r.topics.filter(x => x.status === status)) {
					const row = sec.createDiv({ cls: 'friday-team-drill-row' });
					row.createSpan({ cls: 'friday-team-drill-col', text: label });
					const titleEl = row.createSpan({ cls: 'friday-team-drill-title friday-clickable', text: t.title });
					if (t.blocked) row.createSpan({ cls: 'friday-team-drill-flag', text: '⛔' });
					titleEl.addEventListener('click', () => this.openFile(t.filePath));
				}
			}
		}
		if (r.jiraIssues.length > 0) {
			const sec = panel.createDiv({ cls: 'friday-team-drill-sec' });
			sec.createDiv({ cls: 'friday-team-drill-h', text: 'JIRA' });
			for (const issue of r.jiraIssues) {
				const row = sec.createDiv({ cls: 'friday-team-drill-row' });
				const titleEl = row.createSpan({ cls: 'friday-team-drill-title friday-clickable', text: `${issue.key} ${issue.summary}` });
				row.createSpan({ cls: 'friday-team-drill-col', text: issue.status });
				if (issue.flagged) row.createSpan({ cls: 'friday-team-drill-flag', text: '⛔' });
				titleEl.addEventListener('click', () => window.open(issue.issueUrl, '_blank'));
			}
		}
	}

	private async openFile(path: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!file) {
			new Notice(`File not found: ${path}`);
			return;
		}
		const leaf = this.reuseOrCreateLeaf(path);
		await leaf.openFile(file as any);
		this.app.workspace.revealLeaf(leaf);
	}

	/** Reuse an existing leaf already showing the file if there is one, else open a new one. */
	private reuseOrCreateLeaf(path: string): WorkspaceLeaf {
		let existing: WorkspaceLeaf | null = null;
		this.app.workspace.iterateAllLeaves(l => {
			if (!existing && l.view instanceof MarkdownView && l.view.file?.path === path) {
				existing = l;
			}
		});
		return existing ?? this.app.workspace.getLeaf(false);
	}

	private async startOneOnOne(member: TeamMemberPage): Promise<void> {
		try {
			const r = this.rollupByEmail.get((member.email ?? '').toLowerCase());
			const agenda = r ? buildOneOnOneAgenda(r) : undefined;
			const file = await this.service.startOneOnOne(member, new Date(), agenda);
			const leaf = this.app.workspace.getLeaf(false);
			await leaf.openFile(file);
			this.app.workspace.revealLeaf(leaf);
		} catch (e) {
			new Notice(`Could not start 1:1: ${e instanceof Error ? e.message : 'unknown error'}`);
		}
	}

	private openOneOnOnePicker(): void {
		// Fuzzy picker defaults to active members only. The per-card "Start 1:1"
		// button remains available for on-leave teammates in the roster below.
		const members = this.service.getActiveMembers();
		if (members.length === 0) {
			new Notice('No active team members to pick from.');
			return;
		}
		new OneOnOneModal(this.app, members, (picked) => this.startOneOnOne(picked)).open();
	}

	private async openJiraTeamTab(): Promise<void> {
		if (this.callbacks.onActivateJiraTeamTab) {
			await this.callbacks.onActivateJiraTeamTab();
		}
		const { workspace } = this.app;
		const leaves = workspace.getLeavesOfType(VIEW_TYPE_JIRA_DASHBOARD);
		const leaf = leaves[0] ?? workspace.getLeaf(true);
		if (leaves.length === 0) {
			await leaf.setViewState({ type: VIEW_TYPE_JIRA_DASHBOARD, active: true });
		}
		workspace.revealLeaf(leaf);
	}
}

function initialsOf(name: string): string {
	const parts = name.trim().split(/\s+/);
	if (parts.length === 0) return '?';
	if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
	return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function formatCadenceLabel(member: TeamMemberPage, signal: CadenceSignal): string {
	if (member.cadence === 'skip') return 'Cadence off';
	if (signal.state === 'never') return 'No 1:1 yet';
	if (signal.state === 'overdue') return `${signal.daysSince}d overdue`;
	if (signal.state === 'due-soon') return `Due in ~${Math.max(0, cadenceDaysFor(member) - (signal.daysSince ?? 0))}d`;
	if (signal.state === 'on-track') return `${signal.daysSince}d since`;
	return '';
}

function cadenceDaysFor(member: TeamMemberPage): number {
	switch (member.cadence) {
		case 'weekly': return 7;
		case 'biweekly': return 14;
		case 'monthly': return 30;
		default: return 0;
	}
}

function mostRecentSessionPath(member: TeamMemberPage): string {
	// The scanner preserves session paths in insertion order; pick the max by filename date.
	// Filename format is enforced to YYYY-MM-DD.md so lexicographic sort == date sort.
	const sorted = [...member.sessionPaths].sort();
	return sorted[sorted.length - 1];
}
