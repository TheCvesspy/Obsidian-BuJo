import { ItemView, WorkspaceLeaf, Notice } from 'obsidian';
import { PluginSettings, PluginData } from '../types';
import { VIEW_TYPE_TEAM_DASHBOARD, REFRESH_DEBOUNCE_MS } from '../constants';
import { TeamMemberService } from '../services/teamMemberService';
import { TeamRollupService } from '../services/teamRollupService';
import { TeamDigestService } from '../services/teamDigestService';
import { JiraTeamService } from '../services/jiraTeamService';
import { TeamOverviewView, TeamSort } from './components/TeamOverviewView';
import { TeamStatusSummary } from './components/TeamStatusSummary';
import { TeamWorkloadTrend } from './components/TeamWorkloadTrend';

/**
 * Standalone workspace view for team management. Renders a live "Team status" roll-up
 * (top blockers / at-risk / currently-driving / overdue 1:1s) above the existing person
 * cards. Re-renders on team-page edits, topic changes, and team-JIRA cache updates.
 */
export class TeamDashboardView extends ItemView {
	private contentContainer: HTMLElement | null = null;
	private refreshTimer: ReturnType<typeof setTimeout> | null = null;
	private jiraListener: (() => void) | null = null;
	/** Per-person view state, persisted across the dashboard's debounced rebuilds. */
	private expandedMembers = new Set<string>();
	private teamSort: TeamSort = 'cadence';
	private hideOnLeave = false;

	constructor(
		leaf: WorkspaceLeaf,
		private service: TeamMemberService,
		private rollupService: TeamRollupService,
		private digestService: TeamDigestService,
		private jiraTeamService: JiraTeamService,
		private getSettings: () => PluginSettings,
		private onTeamChanged: (cb: () => void) => void,
		private onTopicsChanged: (cb: () => void) => void,
		private onActivateJiraTeamTab: () => Promise<void>,
		private getData: () => PluginData,
	) {
		super(leaf);
	}

	getViewType(): string { return VIEW_TYPE_TEAM_DASHBOARD; }
	getDisplayText(): string { return 'Team'; }
	getIcon(): string { return 'users'; }

	async onOpen(): Promise<void> {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass('friday-container');
		containerEl.addClass('friday-team-dashboard-container');
		this.contentContainer = (containerEl as HTMLElement).createDiv({
			cls: 'friday-content friday-team-dashboard-content',
		});

		this.onTeamChanged(() => { if (this.contentContainer) this.scheduleRender(); });
		this.onTopicsChanged(() => { if (this.contentContainer) this.scheduleRender(); });
		this.jiraListener = () => { if (this.contentContainer) this.scheduleRender(); };
		this.jiraTeamService.on(this.jiraListener);

		// Pull fresh team JIRA if enabled + stale so the status block has live data.
		if (this.jiraTeamService.isEnabled() && this.jiraTeamService.isStale()) {
			void this.jiraTeamService.refresh();
		}

		this.render();
	}

	async onClose(): Promise<void> {
		if (this.refreshTimer !== null) { clearTimeout(this.refreshTimer); this.refreshTimer = null; }
		if (this.jiraListener) { this.jiraTeamService.off(this.jiraListener); this.jiraListener = null; }
		this.contentContainer = null;
	}

	private scheduleRender(): void {
		if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
		this.refreshTimer = setTimeout(() => { this.refreshTimer = null; this.render(); }, REFRESH_DEBOUNCE_MS);
	}

	/** Flip a member's drill-down expanded state. The card toggles its own DOM in place,
	 *  so this only updates the persisted set (no full re-render needed). */
	private toggleExpanded(email: string): void {
		if (this.expandedMembers.has(email)) this.expandedMembers.delete(email);
		else this.expandedMembers.add(email);
	}

	private render(): void {
		if (!this.contentContainer) return;
		this.contentContainer.empty();

		const rollup = this.rollupService.buildRollup();
		new TeamStatusSummary(this.contentContainer, this.app, rollup, this.freshnessLabel(rollup.jiraIncluded), {
			onCopyDigest: () => {
				void navigator.clipboard.writeText(this.digestService.buildMarkdown(rollup, new Date()));
				new Notice('Team digest copied to clipboard.');
			},
			onGenerateDigest: async () => {
				try {
					const file = await this.digestService.generateDigest(new Date());
					const leaf = this.app.workspace.getLeaf(false);
					await leaf.openFile(file);
					this.app.workspace.revealLeaf(leaf);
					new Notice('Team status digest generated.');
				} catch (e) {
					new Notice(`Could not generate digest: ${e instanceof Error ? e.message : 'error'}`);
				}
			},
		}).render();

		const rollupByEmail = new Map(rollup.members.map(m => [m.email.toLowerCase(), m]));
		const view = new TeamOverviewView(
			this.contentContainer,
			this.app,
			this.service,
			this.getSettings(),
			{ onActivateJiraTeamTab: () => this.onActivateJiraTeamTab() },
			rollupByEmail,
			this.expandedMembers,
			(email) => this.toggleExpanded(email),
			this.teamSort,
			this.hideOnLeave,
			(s) => { this.teamSort = s.sort; this.hideOnLeave = s.hideOnLeave; this.scheduleRender(); },
		);
		view.render();

		new TeamWorkloadTrend(this.contentContainer, rollup, this.getData().workloadHistory).render();
	}

	private freshnessLabel(jiraIncluded: boolean): string {
		if (!jiraIncluded) return 'Topics only · JIRA off';
		const at = this.jiraTeamService.getFetchedAt();
		if (!at) return 'JIRA included';
		const mins = Math.round((Date.now() - at) / 60000);
		return `JIRA included · updated ${mins <= 0 ? 'just now' : `${mins}m ago`}`;
	}
}
