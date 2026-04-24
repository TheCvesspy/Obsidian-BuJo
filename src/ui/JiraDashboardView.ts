import { ItemView, WorkspaceLeaf, debounce, TFile, Menu, Notice, FuzzySuggestModal, App } from 'obsidian';
import { JiraDashboardIssue, PluginSettings, SprintTopic, Priority, TeamMember } from '../types';
import { VIEW_TYPE_JIRA_DASHBOARD, SEARCH_DEBOUNCE_MS } from '../constants';
import { JiraDashboardService } from '../services/jiraDashboardService';
import { JiraTeamService } from '../services/jiraTeamService';
import { SprintTopicService } from '../services/sprintTopicService';
import { SprintService } from '../services/sprintService';
import { SprintTopicModal } from './SprintTopicModal';

/** Map a JIRA priority name to the topic Priority enum. Called on a best-effort
 *  basis when seeding a new topic from a JIRA issue — JIRA has 5 levels, we have 3. */
function mapJiraPriority(jiraPriority: string | null): Priority {
	if (!jiraPriority) return Priority.None;
	const k = jiraPriority.toLowerCase();
	if (k.includes('highest') || k === 'high') return Priority.High;
	if (k.includes('medium')) return Priority.Medium;
	if (k.includes('low') || k.includes('lowest')) return Priority.Low;
	return Priority.None;
}

/** Fuzzy picker over all topics — used by "Link to existing topic…". */
class TopicSuggestModal extends FuzzySuggestModal<SprintTopic> {
	constructor(
		app: App,
		private topics: SprintTopic[],
		private onChoose: (topic: SprintTopic) => void,
	) {
		super(app);
		this.setPlaceholder('Search topics to link…');
	}
	getItems(): SprintTopic[] { return this.topics; }
	getItemText(t: SprintTopic): string {
		const keys = t.jira.length > 0 ? ` [${t.jira.join(', ')}]` : '';
		return `${t.title}${keys}`;
	}
	onChooseItem(t: SprintTopic): void { this.onChoose(t); }
}

interface SectionDef {
	id: string;
	label: string;
	/** Predicate that selects matching issues. Returns true to include. */
	filter: (issue: JiraDashboardIssue, ctx: SectionContext) => boolean;
	/** Tooltip/description shown under the label. */
	description: string;
	/** If true, the section is rendered collapsed by default on first open. */
	defaultCollapsed?: boolean;
}

interface SectionContext {
	currentUserName: string | null; // display name, if we ever resolve it (not required yet)
	now: number;
}

/**
 * Personal JIRA Dashboard view.
 *
 * Layout:
 *   [Header] title + refresh button + "refreshed X ago" + search box
 *   [Sections] Blocked/Flagged · In Progress · In Current Sprint · Reported by Me · Recently Done
 *
 * Performance posture:
 *   - One JQL round-trip per refresh (via JiraDashboardService). Cached result is sliced
 *     client-side into sections — sections share the same data, so filters are cheap.
 *   - Auto-refresh only fires when the view is visible AND the cache is older than the TTL.
 *     Tab switches and focus changes trigger a visibility check.
 *   - Read-only: clicking a row opens the JIRA URL in the browser.
 */
export class JiraDashboardView extends ItemView {
	private searchQuery: string = '';
	private listenerHandle: (() => void) | null = null;
	private teamListenerHandle: (() => void) | null = null;
	private contentContainer: HTMLElement | null = null;
	private headerMetaEl: HTMLElement | null = null;
	private refreshBtnEl: HTMLButtonElement | null = null;
	/** Tab bar root — rebuilt on every render so the active-tab class stays in sync. */
	private tabBarEl: HTMLElement | null = null;
	private debouncedSearch: (value: string) => void;

	/** Active sections — evaluated in order; each issue appears in at most one
	 *  (the first matching), keeping rows from duplicating across sections. */
	private readonly sections: SectionDef[] = [
		{
			id: 'blocked',
			label: 'Blocked / Flagged',
			description: 'Issues you need to unblock or that someone has flagged.',
			filter: (i) => i.flagged,
		},
		{
			id: 'in-progress',
			label: 'In Progress',
			description: 'Anything you\'re actively working on (status category = indeterminate).',
			filter: (i) => i.statusCategory === 'indeterminate',
		},
		{
			id: 'current-sprint',
			label: 'In Current Sprint',
			description: 'Issues in an active sprint that aren\'t already shown above.',
			filter: (i) => i.sprintActive,
		},
		{
			id: 'reported',
			label: 'Reported by Me',
			description: 'Issues where you are the reporter but not assignee.',
			// The JQL already returns everything matching assignee/reporter/watcher.
			// Filter to reporter-only here — but since we don't know currentUser's account
			// from the API response, approximate via "assignee != reporter" shown once the
			// core sections have captured assigned work.
			filter: () => true, // see buildBuckets() — this section is backfilled below
			defaultCollapsed: true,
		},
		{
			id: 'recently-done',
			label: 'Recently Done',
			description: 'Resolved within the last 7 days.',
			filter: (i) => i.statusCategory === 'done',
			defaultCollapsed: true,
		},
	];

	constructor(
		leaf: WorkspaceLeaf,
		private dashboardService: JiraDashboardService,
		private getSettings: () => PluginSettings,
		private saveSettings: () => Promise<void>,
		private getAllTopics: () => SprintTopic[],
		private topicService: SprintTopicService,
		private sprintService: SprintService,
		/** Scanner hook so we can subscribe to topic changes and re-render chip rows
		 *  once a newly-created / re-linked topic lands on disk. Returns an unsubscribe
		 *  function (or void — the scanner currently exposes no off() API, so we just
		 *  null out the handle on close). */
		private onTopicsChanged: (cb: () => void) => void,
		/** Team service fed by TeamMember settings. When its isEnabled() returns false
		 *  (toggle off / no members / no JIRA creds), nothing is fetched and the team
		 *  block is hidden. Subscribed independently of the personal dashboard so one
		 *  service's error doesn't hide the other's results. */
		private teamService: JiraTeamService,
	) {
		super(leaf);
		this.debouncedSearch = debounce((value: string) => {
			this.searchQuery = value;
			this.renderContent();
		}, SEARCH_DEBOUNCE_MS, false);
	}

	getViewType(): string {
		return VIEW_TYPE_JIRA_DASHBOARD;
	}

	getDisplayText(): string {
		return 'JIRA Dashboard';
	}

	getIcon(): string {
		return 'layout-dashboard';
	}

	async onOpen(): Promise<void> {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass('task-bujo-container');
		containerEl.addClass('task-bujo-jira-dashboard-container');

		this.renderHeader(containerEl as HTMLElement);

		this.contentContainer = (containerEl as HTMLElement).createDiv({ cls: 'task-bujo-content task-bujo-jira-dashboard-content' });

		// Subscribe to service events — re-render whenever the cache changes
		this.listenerHandle = () => this.renderContent();
		this.dashboardService.on(this.listenerHandle);

		this.teamListenerHandle = () => this.renderContent();
		this.teamService.on(this.teamListenerHandle);

		// Re-render on topic changes so newly-created or re-linked topics surface
		// their chip immediately. Scanner has no unsubscribe API, so the closure
		// no-ops after onClose() nulls contentContainer.
		this.onTopicsChanged(() => {
			if (this.contentContainer) this.renderContent();
		});

		// Trigger a fetch on open if enabled and stale (both services independently)
		if (this.dashboardService.isEnabled() && this.dashboardService.isStale()) {
			this.dashboardService.refresh();
		}
		if (this.teamService.isEnabled() && this.teamService.isStale()) {
			this.teamService.refresh();
		}

		this.renderContent();
	}

	async onClose(): Promise<void> {
		if (this.listenerHandle) {
			this.dashboardService.off(this.listenerHandle);
			this.listenerHandle = null;
		}
		if (this.teamListenerHandle) {
			this.teamService.off(this.teamListenerHandle);
			this.teamListenerHandle = null;
		}
	}

	/** Called by Obsidian when the view becomes visible again (pane focus / tab switch).
	 *  We use it as a hook to auto-refresh if the cache has gone stale. */
	onResize(): void {
		if (this.dashboardService.isEnabled() && this.dashboardService.isStale() && !this.dashboardService.isLoading()) {
			this.dashboardService.refresh();
		}
		if (this.teamService.isEnabled() && this.teamService.isStale() && !this.teamService.isLoading()) {
			this.teamService.refresh();
		}
	}

	// ── Rendering ─────────────────────────────────────────────────

	private renderHeader(containerEl: HTMLElement): void {
		const header = containerEl.createDiv({ cls: 'task-bujo-jira-dashboard-header' });

		const titleRow = header.createDiv({ cls: 'task-bujo-jira-dashboard-title-row' });
		titleRow.createEl('h3', { text: 'JIRA Dashboard', cls: 'task-bujo-jira-dashboard-title' });

		this.headerMetaEl = titleRow.createSpan({ cls: 'task-bujo-jira-dashboard-meta' });

		const actions = titleRow.createDiv({ cls: 'task-bujo-jira-dashboard-actions' });

		this.refreshBtnEl = actions.createEl('button', {
			cls: 'task-bujo-btn task-bujo-jira-dashboard-refresh',
			text: 'Refresh',
		});
		this.refreshBtnEl.addEventListener('click', () => {
			if (!this.dashboardService.isEnabled()) return;
			this.dashboardService.refresh();
		});

		// Tab bar — lets the user switch between personal dashboard and team view
		// without losing either one's cache. Hidden entirely when team tracking is off
		// (single-tab case), so the user never sees a vestigial switcher.
		this.tabBarEl = header.createDiv({ cls: 'task-bujo-jira-dashboard-tabs' });
		this.renderTabs();

		const searchRow = header.createDiv({ cls: 'task-bujo-jira-dashboard-search-row' });
		const searchInput = searchRow.createEl('input', {
			cls: 'task-bujo-jira-dashboard-search',
			type: 'text',
			placeholder: 'Filter by key, summary, assignee, label…',
		});
		searchInput.addEventListener('input', () => this.debouncedSearch(searchInput.value));
	}

	/** Render the two tabs ("My Work" / "Team") and wire click handlers. Called from
	 *  renderHeader initially and from renderContent whenever the active tab or the
	 *  team-enabled flag may have changed. */
	private renderTabs(): void {
		if (!this.tabBarEl) return;
		this.tabBarEl.empty();

		const active = this.resolveActiveTab();
		const teamEnabled = this.teamService.isEnabled();

		// Hide the tab bar entirely when team tracking is off — there's only one
		// thing to show, so a one-tab bar would be noise.
		if (!teamEnabled) {
			this.tabBarEl.addClass('is-hidden');
			return;
		}
		this.tabBarEl.removeClass('is-hidden');

		const mkTab = (id: 'mine' | 'team', label: string) => {
			const tab = this.tabBarEl!.createDiv({ cls: 'task-bujo-jira-dashboard-tab' });
			tab.setText(label);
			if (id === active) tab.addClass('is-active');
			tab.addEventListener('click', () => this.switchTab(id));
		};
		mkTab('mine', 'My Work');
		mkTab('team', 'Team');
	}

	/** Read the persisted tab, coercing 'team' → 'mine' when team tracking is off
	 *  (e.g. toggle flipped off after a previous session left 'team' sticky). */
	private resolveActiveTab(): 'mine' | 'team' {
		const s = this.getSettings();
		const stored = s.jiraDashboardActiveTab ?? 'mine';
		if (stored === 'team' && !this.teamService.isEnabled()) return 'mine';
		return stored;
	}

	private async switchTab(tab: 'mine' | 'team'): Promise<void> {
		const s = this.getSettings();
		if (s.jiraDashboardActiveTab === tab) return;
		s.jiraDashboardActiveTab = tab;
		// Direct saveData bypass like section-collapse — avoids clearing fetched caches.
		await this.saveSettings();
		// Kick a refresh on the newly-active tab's service if its cache is stale.
		// Cheap: isStale() is false on a fresh cache, so most switches cost nothing.
		if (tab === 'mine' && this.dashboardService.isEnabled() && this.dashboardService.isStale()) {
			this.dashboardService.refresh();
		}
		if (tab === 'team' && this.teamService.isEnabled() && this.teamService.isStale()) {
			this.teamService.refresh();
		}
		this.renderContent();
	}

	private renderContent(): void {
		if (!this.contentContainer) return;

		this.updateHeaderMeta();
		// Tab bar visibility depends on teamService.isEnabled() — which can flip between
		// renders when the user toggles the feature in settings. Re-render on every pass.
		this.renderTabs();

		this.contentContainer.empty();

		if (!this.dashboardService.isEnabled()) {
			this.contentContainer.createDiv({
				cls: 'task-bujo-empty',
				text: 'JIRA integration is disabled. Enable it in plugin settings.',
			});
			return;
		}

		const topicIndex = this.buildTopicIndex();
		const activeTab = this.resolveActiveTab();

		if (activeTab === 'team') {
			this.renderTeamTab(this.contentContainer, topicIndex);
		} else {
			this.renderMineTab(this.contentContainer, topicIndex);
		}
	}

	/** The original five personal sections. Extracted so the tab switch can route here
	 *  without running the team rendering, and vice versa. */
	private renderMineTab(container: HTMLElement, topicIndex: Map<string, SprintTopic[]>): void {
		const err = this.dashboardService.getError();
		if (err) {
			const errEl = container.createDiv({ cls: 'task-bujo-jira-dashboard-error' });
			errEl.createSpan({ text: `Failed to load dashboard: ${err}` });
			return;
		}

		const issues = this.dashboardService.getIssues();
		if (issues === null) {
			container.createDiv({
				cls: 'task-bujo-empty',
				text: this.dashboardService.isLoading() ? 'Loading JIRA issues…' : 'No data yet. Click Refresh.',
			});
			return;
		}

		const filtered = this.applySearch(issues, this.searchQuery);
		const buckets = this.buildBuckets(filtered);

		for (const section of this.sections) {
			const bucket = buckets.get(section.id) ?? [];
			// Hide empty "Reported by Me" section — reporter-only work is often zero
			// and an always-visible empty section becomes noise.
			if (bucket.length === 0 && section.id === 'reported') continue;
			this.renderSection(container, section, bucket, topicIndex);
		}
	}

	/** The Team tab — heatmap + per-person sections. Handles disabled / loading / error
	 *  states here rather than falling through to renderTeamBlock's "hidden when disabled"
	 *  semantics, because on a dedicated tab the user expects an explanation, not a blank. */
	private renderTeamTab(container: HTMLElement, topicIndex: Map<string, SprintTopic[]>): void {
		if (!this.teamService.isEnabled()) {
			// Redundant — the tab bar hides "Team" when team tracking is off — but
			// covers the edge case where teamEnabled flips between render passes.
			container.createDiv({
				cls: 'task-bujo-empty',
				text: 'Team tracking is off. Enable it under Settings → JIRA Integration → Team Members.',
			});
			return;
		}

		const err = this.teamService.getError();
		if (err) {
			const errEl = container.createDiv({ cls: 'task-bujo-jira-dashboard-error' });
			errEl.createSpan({ text: `Failed to load team issues: ${err}` });
			return;
		}

		const issues = this.teamService.getIssues();
		if (issues === null) {
			container.createDiv({
				cls: 'task-bujo-empty',
				text: this.teamService.isLoading() ? 'Loading team issues…' : 'No team data yet. Click Refresh.',
			});
			return;
		}

		this.renderTeamBlock(container, topicIndex);
	}

	private updateHeaderMeta(): void {
		if (!this.headerMetaEl) return;
		this.headerMetaEl.empty();

		if (this.dashboardService.isLoading()) {
			this.headerMetaEl.setText('Loading…');
			this.refreshBtnEl?.setAttribute('disabled', 'true');
			return;
		}
		this.refreshBtnEl?.removeAttribute('disabled');

		const ts = this.dashboardService.getFetchedAt();
		if (ts === null) {
			this.headerMetaEl.setText('Never fetched');
			return;
		}
		const ageSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
		const label = this.formatAge(ageSec);
		const stale = this.dashboardService.isStale() ? ' · stale' : '';
		this.headerMetaEl.setText(`Refreshed ${label} ago${stale}`);
	}

	private formatAge(seconds: number): string {
		if (seconds < 60) return `${seconds}s`;
		if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
		if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
		return `${Math.floor(seconds / 86400)}d`;
	}

	private applySearch(issues: JiraDashboardIssue[], query: string): JiraDashboardIssue[] {
		const q = query.trim().toLowerCase();
		if (!q) return issues;
		return issues.filter(i => {
			const hay = [
				i.key, i.summary, i.status, i.assignee ?? '', i.reporter ?? '',
				i.parentKey ?? '', i.parentSummary ?? '', i.sprintName ?? '',
				i.priority ?? '', i.issueType,
				...i.labels,
			].join(' ').toLowerCase();
			return hay.includes(q);
		});
	}

	/** Assign each issue to exactly one section. Section priority is declaration order,
	 *  except the "Reported by Me" section which only catches issues that didn't land
	 *  in any other section (reporter-only, not in progress, not in active sprint, not done). */
	private buildBuckets(issues: JiraDashboardIssue[]): Map<string, JiraDashboardIssue[]> {
		const out = new Map<string, JiraDashboardIssue[]>();
		for (const s of this.sections) out.set(s.id, []);

		const ctx: SectionContext = { currentUserName: null, now: Date.now() };

		for (const issue of issues) {
			let placed = false;
			for (const section of this.sections) {
				if (section.id === 'reported') continue; // backfill after
				if (section.filter(issue, ctx)) {
					out.get(section.id)!.push(issue);
					placed = true;
					break;
				}
			}
			if (!placed) {
				// Leftover bucket — typically "new"/backlog items not in a sprint, not done.
				// We surface them as "Reported by Me" (since the JQL already scoped to
				// assignee/reporter/watcher, leftovers are usually just other states).
				out.get('reported')!.push(issue);
			}
		}

		// Sort each bucket: blocked first, then by priority rank, then by due date asc, then updated desc
		for (const [, bucket] of out) {
			bucket.sort((a, b) => this.compareIssues(a, b));
		}
		return out;
	}

	private compareIssues(a: JiraDashboardIssue, b: JiraDashboardIssue): number {
		// Flagged first
		if (a.flagged !== b.flagged) return a.flagged ? -1 : 1;

		// Priority rank (Highest=0, Highest→Lowest descending rank to put Highest first)
		const pRank = (p: string | null): number => {
			if (!p) return 99;
			const k = p.toLowerCase();
			if (k.includes('highest')) return 0;
			if (k.includes('high')) return 1;
			if (k.includes('medium')) return 2;
			if (k.includes('low') && !k.includes('lowest')) return 3;
			if (k.includes('lowest')) return 4;
			return 99;
		};
		const pa = pRank(a.priority), pb = pRank(b.priority);
		if (pa !== pb) return pa - pb;

		// Due date ascending (earlier first), null at the end
		if (a.dueDate && b.dueDate) {
			if (a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
		} else if (a.dueDate && !b.dueDate) return -1;
		else if (!a.dueDate && b.dueDate) return 1;

		// Recently updated first
		return (b.updatedAt || '').localeCompare(a.updatedAt || '');
	}

	/** Build a forward index {jiraKey → SprintTopic[]} from the scanner's topic cache.
	 *  Cheap: one pass over all topics; each topic contributes to 0..N keys. */
	private buildTopicIndex(): Map<string, SprintTopic[]> {
		const index = new Map<string, SprintTopic[]>();
		for (const topic of this.getAllTopics()) {
			for (const key of topic.jira) {
				const list = index.get(key);
				if (list) list.push(topic);
				else index.set(key, [topic]);
			}
		}
		return index;
	}

	private async openTopic(topic: SprintTopic): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(topic.filePath);
		if (!(file instanceof TFile)) return;
		const leaf = this.app.workspace.getLeaf(false);
		await leaf.openFile(file);
		this.app.workspace.revealLeaf(leaf);
	}

	private renderSection(container: HTMLElement, section: SectionDef, issues: JiraDashboardIssue[], topicIndex: Map<string, SprintTopic[]>): void {
		const settings = this.getSettings();
		const stickyState = settings.jiraDashboardCollapsedSections[section.id];
		const collapsed = stickyState ?? !!section.defaultCollapsed;

		const sectionEl = container.createDiv({ cls: 'task-bujo-jira-dashboard-section' });
		if (collapsed) sectionEl.addClass('is-collapsed');

		const header = sectionEl.createDiv({ cls: 'task-bujo-jira-dashboard-section-header' });
		const chevron = header.createSpan({ cls: 'task-bujo-jira-dashboard-section-chevron', text: collapsed ? '▶' : '▼' });
		header.createSpan({ cls: 'task-bujo-jira-dashboard-section-label', text: section.label });
		header.createSpan({ cls: 'task-bujo-jira-dashboard-section-count', text: `${issues.length}` });

		header.addEventListener('click', async () => {
			const cur = sectionEl.hasClass('is-collapsed');
			sectionEl.toggleClass('is-collapsed', !cur);
			chevron.setText(!cur ? '▶' : '▼');
			// Persist sticky state
			const s = this.getSettings();
			s.jiraDashboardCollapsedSections[section.id] = !cur;
			await this.saveSettings();
		});

		const body = sectionEl.createDiv({ cls: 'task-bujo-jira-dashboard-section-body' });

		if (issues.length === 0) {
			body.createDiv({ cls: 'task-bujo-empty task-bujo-jira-dashboard-section-empty', text: 'No issues.' });
			return;
		}

		for (const issue of issues) {
			this.renderIssueRow(body, issue, topicIndex);
		}
	}

	private renderIssueRow(container: HTMLElement, issue: JiraDashboardIssue, topicIndex: Map<string, SprintTopic[]>): void {
		const row = container.createDiv({ cls: 'task-bujo-jira-dashboard-row' });
		row.addClass(`task-bujo-jira-row-status-${issue.statusCategory}`);
		if (issue.flagged) row.addClass('is-flagged');

		// Right-click context menu — lets the user create a topic seeded by this
		// issue, or add this key to an existing topic's jira[] list.
		row.addEventListener('contextmenu', (evt) => {
			evt.preventDefault();
			this.openRowContextMenu(evt, issue, topicIndex.get(issue.key) ?? []);
		});

		// Left — issue type icon + key
		const leftEl = row.createDiv({ cls: 'task-bujo-jira-dashboard-row-left' });
		if (issue.issueTypeIconUrl) {
			const img = leftEl.createEl('img', {
				cls: 'task-bujo-jira-dashboard-icon',
				attr: { src: issue.issueTypeIconUrl, alt: issue.issueType, title: issue.issueType },
			});
			img.setAttribute('width', '16');
			img.setAttribute('height', '16');
		}
		const keyEl = leftEl.createEl('a', {
			cls: 'task-bujo-jira-dashboard-key',
			text: issue.key,
			attr: { href: issue.issueUrl, target: '_blank', rel: 'noopener' },
		});
		keyEl.addEventListener('click', (e) => {
			e.preventDefault();
			window.open(issue.issueUrl, '_blank');
		});

		// Summary (clickable, opens in browser)
		const summaryEl = row.createDiv({ cls: 'task-bujo-jira-dashboard-summary' });
		const summaryLink = summaryEl.createEl('a', {
			cls: 'task-bujo-jira-dashboard-summary-link',
			text: issue.summary,
			attr: { href: issue.issueUrl, target: '_blank', rel: 'noopener' },
		});
		summaryLink.addEventListener('click', (e) => {
			e.preventDefault();
			window.open(issue.issueUrl, '_blank');
		});
		// Parent (compact)
		if (issue.parentKey) {
			const parentEl = summaryEl.createDiv({ cls: 'task-bujo-jira-dashboard-parent' });
			parentEl.createSpan({ text: '↑ ' });
			parentEl.createSpan({ cls: 'task-bujo-jira-dashboard-parent-key', text: issue.parentKey });
			if (issue.parentSummary) {
				parentEl.createSpan({ cls: 'task-bujo-jira-dashboard-parent-summary', text: ` — ${issue.parentSummary}` });
			}
		}

		// Meta chips — status, priority, assignee, due date, sprint, time, labels
		const metaEl = row.createDiv({ cls: 'task-bujo-jira-dashboard-meta-row' });

		// Status
		const statusChip = metaEl.createSpan({ cls: 'task-bujo-jira-dashboard-chip task-bujo-jira-dashboard-status' });
		statusChip.addClass(`task-bujo-jira-dashboard-status-${issue.statusCategory}`);
		statusChip.setText(issue.status);

		// Priority
		if (issue.priority) {
			const priChip = metaEl.createSpan({ cls: 'task-bujo-jira-dashboard-chip task-bujo-jira-dashboard-priority' });
			if (issue.priorityIconUrl) {
				const img = priChip.createEl('img', {
					cls: 'task-bujo-jira-dashboard-priority-icon',
					attr: { src: issue.priorityIconUrl, alt: issue.priority },
				});
				img.setAttribute('width', '12');
				img.setAttribute('height', '12');
			}
			priChip.createSpan({ text: issue.priority });
		}

		// Flagged
		if (issue.flagged) {
			metaEl.createSpan({ cls: 'task-bujo-jira-dashboard-chip task-bujo-jira-dashboard-flagged', text: '⚑ Flagged' });
		}

		// Assignee
		if (issue.assignee) {
			metaEl.createSpan({ cls: 'task-bujo-jira-dashboard-chip task-bujo-jira-dashboard-assignee', text: `👤 ${issue.assignee}` });
		} else {
			metaEl.createSpan({ cls: 'task-bujo-jira-dashboard-chip task-bujo-jira-dashboard-assignee is-unassigned', text: 'Unassigned' });
		}

		// Due date
		if (issue.dueDate) {
			const overdue = this.isOverdue(issue.dueDate);
			const chip = metaEl.createSpan({ cls: 'task-bujo-jira-dashboard-chip task-bujo-jira-dashboard-due', text: `📅 ${issue.dueDate}` });
			if (overdue) chip.addClass('is-overdue');
		}

		// Sprint
		if (issue.sprintName) {
			const chip = metaEl.createSpan({ cls: 'task-bujo-jira-dashboard-chip task-bujo-jira-dashboard-sprint', text: `🏃 ${issue.sprintName}` });
			if (issue.sprintActive) chip.addClass('is-active');
		}

		// Time spent / remaining
		const timeLabel = this.formatTime(issue.timeSpentSeconds, issue.timeRemainingSeconds);
		if (timeLabel) {
			metaEl.createSpan({ cls: 'task-bujo-jira-dashboard-chip task-bujo-jira-dashboard-time', text: timeLabel });
		}

		// Labels
		for (const label of issue.labels.slice(0, 5)) {
			metaEl.createSpan({ cls: 'task-bujo-jira-dashboard-chip task-bujo-jira-dashboard-label', text: `#${label}` });
		}
		if (issue.labels.length > 5) {
			metaEl.createSpan({ cls: 'task-bujo-jira-dashboard-chip task-bujo-jira-dashboard-label is-more', text: `+${issue.labels.length - 5}` });
		}

		// Linked topic(s) — one chip per topic this issue appears in. Clicking opens the topic file.
		const linkedTopics = topicIndex.get(issue.key) ?? [];
		for (const topic of linkedTopics) {
			const chip = metaEl.createSpan({
				cls: 'task-bujo-jira-dashboard-chip task-bujo-jira-dashboard-topic',
				text: `↔ ${topic.title}`,
			});
			chip.setAttribute('aria-label', `Open topic: ${topic.filePath}`);
			chip.addEventListener('click', (e) => {
				e.preventDefault();
				e.stopPropagation();
				this.openTopic(topic);
			});
		}
	}

	// ── JIRA → Topic actions ──────────────────────────────────────
	//
	// The dashboard is read-only against JIRA, but it's a natural launch point
	// for topic creation/linking since the user is already looking at the issue.
	// Both flows go through the normal topic-write path (createTopic / updateTopicFrontmatter)
	// so they participate in the scanner's file-watch → onTopicsChange → re-render cycle.

	private openRowContextMenu(evt: MouseEvent, issue: JiraDashboardIssue, linkedTopics: SprintTopic[]): void {
		const menu = new Menu();

		menu.addItem(item => item
			.setTitle('Create topic from this issue')
			.setIcon('plus')
			.onClick(() => this.createTopicFromIssue(issue)));

		// Disable "Link to existing topic" if every vault topic already has this key.
		const allTopics = this.getAllTopics();
		const linkableTopics = allTopics.filter(t => !t.jira.includes(issue.key));

		menu.addItem(item => {
			item.setTitle('Link to existing topic…')
				.setIcon('link')
				.onClick(() => this.linkIssueToTopic(issue, linkableTopics));
			if (linkableTopics.length === 0) item.setDisabled(true);
		});

		// If already linked, surface an "Open linked topic" submenu for quick nav.
		if (linkedTopics.length > 0) {
			menu.addSeparator();
			for (const topic of linkedTopics) {
				menu.addItem(item => item
					.setTitle(`Open topic: ${topic.title}`)
					.setIcon('file-text')
					.onClick(() => this.openTopic(topic)));
			}
		}

		menu.showAtMouseEvent(evt);
	}

	private createTopicFromIssue(issue: JiraDashboardIssue): void {
		// Default to the active sprint; fall back to backlog if none is active.
		const active = this.sprintService.getActiveSprint();
		const sprintId = active?.id ?? '';

		const modal = new SprintTopicModal(
			this.app,
			this.topicService,
			sprintId,
			(topic) => {
				new Notice(`Topic created: ${topic.title}`);
			},
			undefined,
			this.sprintService,
			{
				title: issue.summary || issue.key,
				jira: issue.key,
				priority: mapJiraPriority(issue.priority),
			},
			this.getSettings(),
		);
		modal.open();
	}

	private linkIssueToTopic(issue: JiraDashboardIssue, candidateTopics: SprintTopic[]): void {
		if (candidateTopics.length === 0) {
			new Notice('Every topic is already linked to this issue.');
			return;
		}
		new TopicSuggestModal(this.app, candidateTopics, async (topic) => {
			// Append the issue key to the topic's existing jira[] list, dedup preserving order.
			const seen = new Set(topic.jira);
			if (seen.has(issue.key)) {
				new Notice(`${topic.title} already linked to ${issue.key}.`);
				return;
			}
			const merged = [...topic.jira, issue.key];
			try {
				await this.topicService.updateTopicFrontmatter(topic.filePath, {
					jira: merged.join(', '),
				});
				new Notice(`Linked ${issue.key} → ${topic.title}`);
			} catch (err) {
				console.error('[JIRA Dashboard] link-to-topic failed:', err);
				new Notice(`Failed to link: ${(err as Error).message ?? err}`);
			}
		}).open();
	}

	// ── Team block ────────────────────────────────────────────────
	//
	// Two-part rendering driven by JiraTeamService + PluginSettings.teamMembers:
	//   1. Workload heatmap — one row per active member, segmented bar showing
	//      blocked / in-progress / open counts. Quick overview of "who's drowning".
	//   2. Per-person sections — one collapsible section per member with their
	//      issues, sorted by workload desc so overloaded people surface first.
	//
	// Both are driven from the same in-memory `JiraDashboardIssue[]` fetched by
	// JiraTeamService. The search filter applies to team issues too.

	private renderTeamBlock(container: HTMLElement, topicIndex: Map<string, SprintTopic[]>): void {
		if (!this.teamService.isEnabled()) return;

		const wrap = container.createDiv({ cls: 'task-bujo-jira-dashboard-team-block' });
		const header = wrap.createDiv({ cls: 'task-bujo-jira-dashboard-team-header' });
		header.createSpan({ cls: 'task-bujo-jira-dashboard-team-title', text: 'Team' });

		const teamMeta = header.createSpan({ cls: 'task-bujo-jira-dashboard-team-meta' });
		const teamErr = this.teamService.getError();
		if (this.teamService.isLoading()) {
			teamMeta.setText('Loading team…');
		} else if (teamErr) {
			teamMeta.setText(`error: ${teamErr}`);
			teamMeta.addClass('is-error');
		} else {
			const ts = this.teamService.getFetchedAt();
			if (ts !== null) {
				const ageSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
				teamMeta.setText(`Refreshed ${this.formatAge(ageSec)} ago${this.teamService.isStale() ? ' · stale' : ''}`);
			}
		}

		const teamIssues = this.teamService.getIssues();
		if (teamIssues === null) {
			if (!teamErr) {
				wrap.createDiv({
					cls: 'task-bujo-empty',
					text: this.teamService.isLoading() ? 'Loading team issues…' : 'No team data yet.',
				});
			}
			return;
		}

		const members = this.getSettings().teamMembers.filter(m => m.active);
		if (members.length === 0) {
			wrap.createDiv({ cls: 'task-bujo-empty', text: 'No active team members configured.' });
			return;
		}

		const filteredTeam = this.applySearch(teamIssues, this.searchQuery);
		const byMember = this.bucketByMember(filteredTeam, members);

		// Heatmap row — always visible (even when filter hides everyone) so the lead
		// analyst sees the shape of the team load immediately.
		this.renderHeatmap(wrap, members, byMember);

		// Per-person sections, sorted by workload desc (total issues)
		const ordered = [...members]
			.map(m => ({ member: m, issues: byMember.get(m.email) ?? [] }))
			.sort((a, b) => b.issues.length - a.issues.length);

		for (const { member, issues } of ordered) {
			this.renderMemberSection(wrap, member, issues, topicIndex);
		}
	}

	/** Assign each team issue to exactly one member bucket. Matching priority:
	 *    1. Exact email match against assigneeEmail (most reliable — but JIRA Cloud
	 *       often hides email for privacy).
	 *    2. Display-name match against fullName (case-insensitive, trimmed).
	 *  Issues that match no member (unusual — JQL already scoped to team emails)
	 *  are dropped rather than invented into a bucket. */
	private bucketByMember(issues: JiraDashboardIssue[], members: TeamMember[]): Map<string, JiraDashboardIssue[]> {
		const byEmail = new Map<string, TeamMember>();
		const byName = new Map<string, TeamMember>();
		for (const m of members) {
			if (m.email) byEmail.set(m.email.toLowerCase(), m);
			if (m.fullName) byName.set(m.fullName.toLowerCase().trim(), m);
		}

		const out = new Map<string, JiraDashboardIssue[]>();
		for (const m of members) out.set(m.email, []);

		for (const issue of issues) {
			let member: TeamMember | undefined;
			if (issue.assigneeEmail) {
				member = byEmail.get(issue.assigneeEmail.toLowerCase());
			}
			if (!member && issue.assignee) {
				member = byName.get(issue.assignee.toLowerCase().trim());
			}
			if (member) out.get(member.email)!.push(issue);
		}

		// Sort each bucket with the existing cross-section comparator (flagged → priority → due → updated).
		for (const [, bucket] of out) bucket.sort((a, b) => this.compareIssues(a, b));
		return out;
	}

	private renderHeatmap(container: HTMLElement, members: TeamMember[], byMember: Map<string, JiraDashboardIssue[]>): void {
		const wrap = container.createDiv({ cls: 'task-bujo-jira-dashboard-heatmap' });
		const title = wrap.createDiv({ cls: 'task-bujo-jira-dashboard-heatmap-title' });
		title.setText('Workload');

		// Max total across all members — drives bar scaling so the busiest member's
		// bar fills the track and others are proportional. Min width 1 to avoid /0.
		const rows = members.map(m => {
			const issues = byMember.get(m.email) ?? [];
			const blocked = issues.filter(i => i.flagged).length;
			const inProgress = issues.filter(i => !i.flagged && i.statusCategory === 'indeterminate').length;
			const open = issues.filter(i => !i.flagged && i.statusCategory !== 'indeterminate' && i.statusCategory !== 'done').length;
			const done = issues.filter(i => i.statusCategory === 'done').length;
			return { member: m, blocked, inProgress, open, done, total: blocked + inProgress + open + done };
		});
		const maxTotal = Math.max(1, ...rows.map(r => r.total));

		// Sort visually: heaviest at top.
		rows.sort((a, b) => b.total - a.total);

		for (const r of rows) {
			const rowEl = wrap.createDiv({ cls: 'task-bujo-jira-dashboard-heatmap-row' });
			rowEl.createSpan({
				cls: 'task-bujo-jira-dashboard-heatmap-nick',
				text: r.member.nickname || r.member.fullName || r.member.email,
				attr: { title: r.member.fullName || r.member.email },
			});

			// Track with four segments: blocked (red), in-progress (blue), open (grey),
			// done (green, faded). Segment widths are proportional to r.total / maxTotal.
			const track = rowEl.createDiv({ cls: 'task-bujo-jira-dashboard-heatmap-track' });
			const fill = track.createDiv({ cls: 'task-bujo-jira-dashboard-heatmap-fill' });
			fill.style.width = `${(r.total / maxTotal) * 100}%`;

			const addSeg = (count: number, cls: string, label: string) => {
				if (count === 0) return;
				const seg = fill.createDiv({ cls: `task-bujo-jira-dashboard-heatmap-seg ${cls}` });
				seg.style.flex = `${count} ${count} 0`;
				seg.setAttribute('title', `${count} ${label}`);
			};
			addSeg(r.blocked, 'is-blocked', 'blocked');
			addSeg(r.inProgress, 'is-in-progress', 'in progress');
			addSeg(r.open, 'is-open', 'open');
			addSeg(r.done, 'is-done', 'done');

			// Compact count summary to the right.
			const counts = rowEl.createSpan({ cls: 'task-bujo-jira-dashboard-heatmap-counts' });
			const parts: string[] = [];
			if (r.blocked) parts.push(`${r.blocked} blocked`);
			if (r.inProgress) parts.push(`${r.inProgress} in progress`);
			if (r.open) parts.push(`${r.open} open`);
			if (r.done) parts.push(`${r.done} done`);
			counts.setText(parts.length > 0 ? parts.join(' · ') : 'none');
		}
	}

	private renderMemberSection(container: HTMLElement, member: TeamMember, issues: JiraDashboardIssue[], topicIndex: Map<string, SprintTopic[]>): void {
		const settings = this.getSettings();
		// Member sections share the same sticky-state dict as the personal sections,
		// keyed by "team:<email>" so they don't collide with section ids like "blocked".
		const stickyKey = `team:${member.email}`;
		const collapsed = settings.jiraDashboardCollapsedSections[stickyKey] ?? true;

		const sectionEl = container.createDiv({ cls: 'task-bujo-jira-dashboard-section task-bujo-jira-dashboard-team-section' });
		if (collapsed) sectionEl.addClass('is-collapsed');

		const header = sectionEl.createDiv({ cls: 'task-bujo-jira-dashboard-section-header' });
		const chevron = header.createSpan({ cls: 'task-bujo-jira-dashboard-section-chevron', text: collapsed ? '▶' : '▼' });
		const label = member.fullName || member.nickname || member.email;
		const suffix = member.nickname && member.nickname !== member.fullName ? ` (${member.nickname})` : '';
		header.createSpan({ cls: 'task-bujo-jira-dashboard-section-label', text: `${label}${suffix}` });
		header.createSpan({ cls: 'task-bujo-jira-dashboard-section-count', text: `${issues.length}` });

		header.addEventListener('click', async () => {
			const cur = sectionEl.hasClass('is-collapsed');
			sectionEl.toggleClass('is-collapsed', !cur);
			chevron.setText(!cur ? '▶' : '▼');
			const s = this.getSettings();
			s.jiraDashboardCollapsedSections[stickyKey] = !cur;
			await this.saveSettings();
		});

		const body = sectionEl.createDiv({ cls: 'task-bujo-jira-dashboard-section-body' });
		if (issues.length === 0) {
			body.createDiv({ cls: 'task-bujo-empty task-bujo-jira-dashboard-section-empty', text: 'No issues in scope.' });
			return;
		}
		for (const issue of issues) {
			this.renderIssueRow(body, issue, topicIndex);
		}
	}

	private isOverdue(dueDate: string): boolean {
		const d = new Date(dueDate + 'T00:00:00');
		if (isNaN(d.getTime())) return false;
		const today = new Date();
		today.setHours(0, 0, 0, 0);
		return d.getTime() < today.getTime();
	}

	/** Format time as "2h spent / 4h left" — omits zero sides. Returns '' if both unknown. */
	private formatTime(spent: number | null, remaining: number | null): string {
		const fmt = (sec: number): string => {
			if (sec < 60) return `${sec}s`;
			if (sec < 3600) return `${Math.round(sec / 60)}m`;
			const h = sec / 3600;
			return h >= 10 ? `${Math.round(h)}h` : `${h.toFixed(1)}h`;
		};
		const parts: string[] = [];
		if (spent && spent > 0) parts.push(`⏱ ${fmt(spent)} spent`);
		if (remaining && remaining > 0) parts.push(`${fmt(remaining)} left`);
		return parts.join(' / ');
	}
}
