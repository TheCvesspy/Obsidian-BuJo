import { ItemView, WorkspaceLeaf } from 'obsidian';
import { PluginSettings } from '../types';
import { VIEW_TYPE_TEAM_DASHBOARD, REFRESH_DEBOUNCE_MS } from '../constants';
import { TeamMemberService } from '../services/teamMemberService';
import { TeamOverviewView } from './components/TeamOverviewView';

/**
 * Standalone workspace view for team management. Mirrors the JIRA Dashboard
 * pattern: its own ribbon icon, its own command, its own leaf type. Content
 * is rendered by the existing `TeamOverviewView` component so the cards
 * stay consistent wherever they might appear in the future.
 *
 * Refreshes are triggered by the scanner's `onTeamChange` event — any edit
 * or creation of a person page or a 1:1 session file re-indexes and the
 * view rebuilds. The scanner has no unsubscribe API, so the closure guards
 * on `contentContainer` being non-null (nulled in `onClose`).
 */
export class TeamDashboardView extends ItemView {
	private contentContainer: HTMLElement | null = null;
	private refreshTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private service: TeamMemberService,
		private getSettings: () => PluginSettings,
		/** Scanner's team-change subscription. Called once in `onOpen`; the
		 *  registered closure is defensive about post-close firing. */
		private onTeamChanged: (cb: () => void) => void,
		/** Called when the user clicks "JIRA workload →" on a card. Flips the
		 *  dashboard active tab to 'team' and reveals the JIRA Dashboard leaf. */
		private onActivateJiraTeamTab: () => Promise<void>,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_TEAM_DASHBOARD;
	}

	getDisplayText(): string {
		return 'Team';
	}

	getIcon(): string {
		return 'users';
	}

	async onOpen(): Promise<void> {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass('friday-container');
		containerEl.addClass('friday-team-dashboard-container');

		this.contentContainer = (containerEl as HTMLElement).createDiv({
			cls: 'friday-content friday-team-dashboard-content',
		});

		// Subscribe to scanner team-change events. Debounce so rapid edits coalesce.
		this.onTeamChanged(() => {
			if (!this.contentContainer) return;
			this.scheduleRender();
		});

		this.render();
	}

	async onClose(): Promise<void> {
		if (this.refreshTimer !== null) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}
		// Null the container so any queued scanner callback becomes a no-op.
		this.contentContainer = null;
	}

	private scheduleRender(): void {
		if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = null;
			this.render();
		}, REFRESH_DEBOUNCE_MS);
	}

	private render(): void {
		if (!this.contentContainer) return;
		const view = new TeamOverviewView(
			this.contentContainer,
			this.app,
			this.service,
			this.getSettings(),
			{ onActivateJiraTeamTab: () => this.onActivateJiraTeamTab() },
		);
		view.render();
	}
}
