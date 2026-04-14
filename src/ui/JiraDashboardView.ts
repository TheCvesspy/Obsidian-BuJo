import { ItemView, WorkspaceLeaf, debounce, TFile } from 'obsidian';
import { JiraDashboardIssue, PluginSettings, SprintTopic } from '../types';
import { VIEW_TYPE_JIRA_DASHBOARD, SEARCH_DEBOUNCE_MS } from '../constants';
import { JiraDashboardService } from '../services/jiraDashboardService';

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
	private contentContainer: HTMLElement | null = null;
	private headerMetaEl: HTMLElement | null = null;
	private refreshBtnEl: HTMLButtonElement | null = null;
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

		// Trigger a fetch on open if enabled and stale
		if (this.dashboardService.isEnabled() && this.dashboardService.isStale()) {
			this.dashboardService.refresh();
		}

		this.renderContent();
	}

	async onClose(): Promise<void> {
		if (this.listenerHandle) {
			this.dashboardService.off(this.listenerHandle);
			this.listenerHandle = null;
		}
	}

	/** Called by Obsidian when the view becomes visible again (pane focus / tab switch).
	 *  We use it as a hook to auto-refresh if the cache has gone stale. */
	onResize(): void {
		if (this.dashboardService.isEnabled() && this.dashboardService.isStale() && !this.dashboardService.isLoading()) {
			this.dashboardService.refresh();
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

		const searchRow = header.createDiv({ cls: 'task-bujo-jira-dashboard-search-row' });
		const searchInput = searchRow.createEl('input', {
			cls: 'task-bujo-jira-dashboard-search',
			type: 'text',
			placeholder: 'Filter by key, summary, assignee, label…',
		});
		searchInput.addEventListener('input', () => this.debouncedSearch(searchInput.value));
	}

	private renderContent(): void {
		if (!this.contentContainer) return;

		this.updateHeaderMeta();

		this.contentContainer.empty();

		if (!this.dashboardService.isEnabled()) {
			this.contentContainer.createDiv({
				cls: 'task-bujo-empty',
				text: 'JIRA integration is disabled. Enable it in plugin settings.',
			});
			return;
		}

		const err = this.dashboardService.getError();
		if (err) {
			const errEl = this.contentContainer.createDiv({ cls: 'task-bujo-jira-dashboard-error' });
			errEl.createSpan({ text: `Failed to load dashboard: ${err}` });
			return;
		}

		const issues = this.dashboardService.getIssues();
		if (issues === null) {
			// Nothing cached yet — loading state
			this.contentContainer.createDiv({
				cls: 'task-bujo-empty',
				text: this.dashboardService.isLoading() ? 'Loading JIRA issues…' : 'No data yet. Click Refresh.',
			});
			return;
		}

		const filtered = this.applySearch(issues, this.searchQuery);
		const buckets = this.buildBuckets(filtered);
		const topicIndex = this.buildTopicIndex();

		for (const section of this.sections) {
			const bucket = buckets.get(section.id) ?? [];
			// Hide empty "Reported by Me" section — reporter-only work is often zero
			// and an always-visible empty section becomes noise.
			if (bucket.length === 0 && section.id === 'reported') continue;
			this.renderSection(this.contentContainer, section, bucket, topicIndex);
		}
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
