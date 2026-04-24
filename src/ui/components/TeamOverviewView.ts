import { App, MarkdownView, Notice, WorkspaceLeaf } from 'obsidian';
import { TeamMemberPage, PluginSettings } from '../../types';
import { VIEW_TYPE_JIRA_DASHBOARD } from '../../constants';
import { TeamMemberService, CadenceSignal } from '../../services/teamMemberService';
import { createCadenceChip } from '../icons';
import { OneOnOneModal } from '../OneOnOneModal';

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
	) {}

	render(): void {
		this.container.empty();
		this.container.addClass('task-bujo-team-overview');

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

		// Most overdue first, then on-track, then suspended/departed-on-leave, by name.
		const rank: Record<string, number> = {
			'overdue': 0,
			'due-soon': 1,
			'never': 2,
			'on-track': 3,
			'suspended': 4,
		};
		const sorted = [...members].sort((a, b) => {
			const sa = signals.get(a.folderPath)!;
			const sb = signals.get(b.folderPath)!;
			const ra = rank[sa.state] ?? 9;
			const rb = rank[sb.state] ?? 9;
			if (ra !== rb) return ra - rb;
			// Inside overdue: most overdue first
			if (sa.state === 'overdue' && sb.state === 'overdue') {
				return (sb.daysSince ?? 0) - (sa.daysSince ?? 0);
			}
			return a.name.localeCompare(b.name);
		});

		// Header with a "Start 1:1" CTA
		const header = this.container.createDiv({ cls: 'task-bujo-team-header' });
		header.createEl('h2', { text: 'Team', cls: 'task-bujo-team-title' });
		const startBtn = header.createEl('button', {
			cls: 'task-bujo-team-start-1on1 mod-cta',
			text: 'Start 1:1…',
		});
		startBtn.addEventListener('click', () => this.openOneOnOnePicker());

		const grid = this.container.createDiv({ cls: 'task-bujo-team-grid' });
		for (const member of sorted) {
			this.renderCard(grid, member, signals.get(member.folderPath)!);
		}
	}

	private renderEmptyState(): void {
		const empty = this.container.createDiv({ cls: 'task-bujo-empty' });
		empty.createEl('p', {
			text: `No team members found.`,
		});
		const hint = empty.createEl('p', { cls: 'task-bujo-empty-hint' });
		hint.appendText(`Create a folder under `);
		hint.createEl('code', { text: this.settings.teamFolderPath });
		hint.appendText(` with a person page inside, or use the `);
		hint.createEl('em', { text: 'Generate person pages' });
		hint.appendText(` button in BuJo settings.`);
	}

	private renderCard(parent: HTMLElement, member: TeamMemberPage, signal: CadenceSignal): void {
		const card = parent.createDiv({ cls: 'task-bujo-team-card' });
		if (member.status === 'on_leave') card.addClass('is-on-leave');

		// Row 1: avatar + name + cadence chip
		const topRow = card.createDiv({ cls: 'task-bujo-team-card-top' });
		const avatar = topRow.createDiv({ cls: 'task-bujo-team-avatar' });
		avatar.textContent = initialsOf(member.name);

		const identityBlock = topRow.createDiv({ cls: 'task-bujo-team-identity' });
		identityBlock.createEl('div', { cls: 'task-bujo-team-name', text: member.name });
		if (member.role) {
			identityBlock.createEl('div', { cls: 'task-bujo-team-role', text: member.role });
		}

		const chipRow = topRow.createDiv({ cls: 'task-bujo-team-chips' });
		if (member.status === 'on_leave') {
			chipRow.appendChild(createCadenceChip('suspended', 'On leave'));
		} else {
			chipRow.appendChild(createCadenceChip(signal.state, formatCadenceLabel(member, signal)));
		}

		// Row 2: current focus (first-line extract happens in the caller's model; we don't parse body here)
		// We only have frontmatter fields available from the scanner — body sections would require an extra read.
		// For now just surface the role + cadence cadence config as a subtle subtitle. Current-focus text can
		// be surfaced in Phase 2 by extending the parser to pick up the "## Current Focus" first line.

		// Row 3: action buttons
		const actions = card.createDiv({ cls: 'task-bujo-team-actions' });

		const openPageBtn = actions.createEl('button', { cls: 'task-bujo-team-action', text: 'Open page' });
		openPageBtn.addEventListener('click', () => this.openFile(member.filePath));

		const startBtn = actions.createEl('button', {
			cls: 'task-bujo-team-action',
			text: signal.state === 'overdue' ? 'Start 1:1 (overdue)' : 'Start 1:1',
		});
		if (signal.state === 'overdue') startBtn.addClass('mod-warning');
		startBtn.addEventListener('click', () => this.startOneOnOne(member));

		if (member.sessionPaths.length > 0 && member.lastOneOnOne) {
			const lastBtn = actions.createEl('button', {
				cls: 'task-bujo-team-action',
				text: 'Last 1:1',
			});
			const lastPath = mostRecentSessionPath(member);
			lastBtn.addEventListener('click', () => this.openFile(lastPath));
		}

		if (this.settings.jiraEnabled && this.settings.jiraTeamEnabled && member.jiraIdentity) {
			const jiraBtn = actions.createEl('button', {
				cls: 'task-bujo-team-action',
				text: 'JIRA workload →',
			});
			jiraBtn.addEventListener('click', () => this.openJiraTeamTab());
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
			const file = await this.service.startOneOnOne(member, new Date());
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
