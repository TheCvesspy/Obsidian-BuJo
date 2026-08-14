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
	/** Called when the snooze button is pressed (the event anchors the preset menu).
	 *  Omit to hide the snooze button. */
	onSnooze?: (topic: SprintTopic, evt: MouseEvent) => void;
	/** Called when the wake button is pressed on a topic with `snoozedUntil` set. */
	onWake?: (topic: SprintTopic) => void;
	/** Whether the topic's snooze is currently active (from isTopicSnoozed). Drives the
	 *  chip wording: active → "until <date>", expired-but-set → "woke <date>". */
	snoozedActive?: boolean;
	/** If true, show impact/effort/due-date metadata chips below the title. */
	showMatrixMetadata?: boolean;
	/** Lookup live JIRA data for a given key. Called once per key in `topic.jira[]`.
	 *  Return `{info: null, loading: false, error: null}` (or omit) to render the key bare. */
	jiraLookup?: (key: string) => { info: JiraIssueInfo | null; loading: boolean; error: string | null };
	/** Lookup team-member display info by email. Return null for unknown (removed) members;
	 *  the card falls back to the raw email. `isInactive` styles the chip as muted. */
	assigneeLookup?: (email: string) => { label: string; isInactive: boolean } | null;
	/** Number of days after `lastNudged` before a waiting-on chip is marked stale.
	 *  Default 7. */
	nudgeThresholdDays?: number;
	/** Days an in-progress topic may sit in its column (statusSince) before the card
	 *  shows an aging badge. Omit to hide aging badges entirely. */
	agingThresholdDays?: number;
	/** Compute the derived block state (manual OR JIRA OR dependency). When provided, the
	 *  card shows a derived BLOCKED badge with reasons; when omitted, falls back to the
	 *  manual `topic.blocked` flag only (so callers that don't pass it are unaffected). */
	deriveBlock?: (topic: SprintTopic) => { state: 'clear' | 'at-risk' | 'blocked'; reasons: string[] };
	/** Resolve dependency topics for the chip row. Omit to hide it. */
	dependencyLookup?: (topic: SprintTopic) => { blockedBy: SprintTopic[]; blocks: SprintTopic[] };
	/** Click handler for a dependency chip (opens that topic). */
	onDependencyClick?: (topic: SprintTopic) => void;
}

const STATUS_TRANSITIONS: Record<TopicStatus, { left: TopicStatus | null; right: TopicStatus | null }> = {
	'backlog': { left: null, right: 'open' },
	'open': { left: 'backlog', right: 'in-progress' },
	'in-progress': { left: 'open', right: 'done' },
	'done': { left: 'in-progress', right: null },
};

const STATUS_LABELS: Record<TopicStatus, string> = {
	'backlog': 'Backlog',
	'open': 'To Do',
	'in-progress': 'In Progress',
	'done': 'Done',
};

/** Days between `isoDate` (YYYY-MM-DD) and today. Returns null for invalid input. */
function computeDaysSince(isoDate: string | null): number | null {
	if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return null;
	const then = new Date(isoDate + 'T00:00:00').getTime();
	if (isNaN(then)) return null;
	const now = new Date();
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	return Math.floor((today - then) / (24 * 60 * 60 * 1000));
}

/** Render a Topic card into the given container. Returns the card element. */
export function renderTopicCard(
	container: HTMLElement,
	topic: SprintTopic,
	opts: TopicCardOptions,
): HTMLElement {
	const card = container.createDiv({ cls: 'friday-kanban-card' });

	if (opts.draggable) {
		card.draggable = true;
		card.dataset.filepath = topic.filePath;
		card.addEventListener('dragstart', (e) => {
			if (opts.isDragging) opts.isDragging.value = true;
			card.addClass('friday-kanban-card-dragging');
			if (e.dataTransfer) {
				e.dataTransfer.setData('text/plain', topic.filePath);
				e.dataTransfer.effectAllowed = 'move';
			}
		});
		card.addEventListener('dragend', () => {
			card.removeClass('friday-kanban-card-dragging');
			if (opts.isDragging) opts.isDragging.value = false;
		});
	}

	// Header: priority dot + title + blocked badge
	const headerEl = card.createDiv({ cls: 'friday-kanban-card-header' });
	if (topic.priority !== Priority.None) {
		const dot = headerEl.createSpan({ cls: 'friday-priority-dot' });
		dot.addClass(`friday-priority-${topic.priority}`);
	}
	const titleEl = headerEl.createSpan({ cls: 'friday-kanban-card-title', text: topic.title });
	if (opts.onTitleClick) {
		titleEl.addEventListener('click', (e) => {
			e.stopPropagation();
			opts.onTitleClick!(topic);
		});
	}
	const derived = opts.deriveBlock?.(topic);
	if (derived) {
		if (derived.state === 'blocked') {
			const manualOnly = derived.reasons.length === 1 && derived.reasons[0] === 'Manually blocked';
			const badge = headerEl.createSpan({ cls: 'friday-kanban-card-blocked', text: 'BLOCKED' });
			if (!manualOnly) badge.addClass('friday-kanban-card-blocked-derived');
			badge.setAttribute('title', derived.reasons.join(' · '));
		}
	} else if (topic.blocked) {
		headerEl.createSpan({ cls: 'friday-kanban-card-blocked', text: 'BLOCKED' });
	}

	// Aging badge: an in-progress topic that has sat in its column past the aging-WIP
	// threshold gets a day counter — stalled work should be visible where you look,
	// not only in Analytics.
	if (opts.agingThresholdDays !== undefined && topic.status === 'in-progress') {
		const inColumn = computeDaysSince(topic.statusSince);
		if (inColumn !== null && inColumn >= opts.agingThresholdDays) {
			const badge = headerEl.createSpan({
				cls: 'friday-kanban-card-aging',
				text: `⏱ ${inColumn}d`,
			});
			badge.setAttribute('title', `In Progress for ${inColumn} days (threshold ${opts.agingThresholdDays}) — since ${topic.statusSince}`);
		}
	}

	// JIRA tickets (0..n) — one row per linked key
	for (const key of topic.jira) {
		const lookup = opts.jiraLookup?.(key);
		const info = lookup?.info ?? null;
		const loading = lookup?.loading ?? false;
		const error = lookup?.error ?? null;

		const jiraRow = card.createDiv({ cls: 'friday-kanban-card-jira-row' });
		const keyEl = jiraRow.createSpan({ cls: 'friday-kanban-card-jira', text: key });
		if (info?.issueUrl) {
			keyEl.addClass('friday-clickable');
			keyEl.addEventListener('click', (e) => {
				e.stopPropagation();
				window.open(info.issueUrl, '_blank');
			});
		}

		if (loading) {
			jiraRow.createSpan({ cls: 'friday-jira-chip friday-jira-loading', text: '…' });
		} else if (error) {
			const errEl = jiraRow.createSpan({
				cls: 'friday-jira-chip friday-jira-error',
				text: '!',
			});
			errEl.setAttribute('title', `JIRA fetch failed: ${error}`);
		} else if (info) {
			const statusEl = jiraRow.createSpan({
				cls: `friday-jira-chip friday-jira-status friday-jira-status-${info.statusCategory}`,
				text: info.status,
			});
			statusEl.setAttribute('title', `JIRA status: ${info.status}`);
			const assigneeLabel = info.assignee ?? 'Unassigned';
			const assigneeEl = jiraRow.createSpan({
				cls: 'friday-jira-chip friday-jira-assignee',
				text: assigneeLabel,
			});
			assigneeEl.setAttribute('title', info.assignee ? `Assignee: ${info.assignee}` : 'Unassigned');
			if (info.summary) {
				const summaryEl = card.createDiv({
					cls: 'friday-kanban-card-jira-summary',
					text: info.summary,
				});
				summaryEl.setAttribute('title', info.summary);
			}
		}
	}

	// JIRA drift detection: the topic's Kanban state contradicts its linked issues.
	// Only cached issue data is consulted — a key that hasn't loaded yet contributes
	// nothing, so the chip never flickers on stale/partial information.
	if (opts.jiraLookup && topic.jira.length > 0) {
		const driftReasons: string[] = [];
		const cached = topic.jira
			.map(key => ({ key, info: opts.jiraLookup!(key).info }))
			.filter((x): x is { key: string; info: JiraIssueInfo } => x.info !== null);
		if (topic.status === 'done') {
			// Finished topic, unfinished tickets — the board says done but JIRA disagrees.
			const stillOpen = cached.filter(x => x.info.statusCategory === 'new' || x.info.statusCategory === 'indeterminate');
			if (stillOpen.length > 0) {
				driftReasons.push(`Topic is done but still open in JIRA: ${stillOpen.map(x => x.key).join(', ')}`);
			}
		} else if (cached.length === topic.jira.length && cached.every(x => x.info.statusCategory === 'done')) {
			// Every linked ticket resolved, topic still on the board — likely forgotten.
			driftReasons.push(`All JIRA issues resolved (${cached.map(x => x.key).join(', ')}) but the topic isn't done`);
		}
		if (driftReasons.length > 0) {
			const chip = card.createDiv({ cls: 'friday-kanban-card-drift', text: '⚠ JIRA drift' });
			chip.setAttribute('title', driftReasons.join(' · '));
		}
	}

	// Optional matrix metadata (impact / effort / due date)
	if (opts.showMatrixMetadata) {
		const chips: string[] = [];
		if (topic.impact) chips.push(`Impact: ${topic.impact}`);
		if (topic.effort) chips.push(`Effort: ${topic.effort.toUpperCase()}`);
		if (topic.dueDate) chips.push(`Due: ${topic.dueDate}`);
		if (chips.length > 0) {
			card.createDiv({ cls: 'friday-kanban-card-meta', text: chips.join(' \u2022 ') });
		}
	}

	// Optional assignee chip (shown when the topic has one set)
	if (topic.assignee) {
		const lookup = opts.assigneeLookup?.(topic.assignee) ?? null;
		const label = lookup?.label ?? topic.assignee;
		const chip = card.createDiv({ cls: 'friday-kanban-card-assignee' });
		chip.setText(label);
		if (!lookup || lookup.isInactive) {
			chip.addClass('friday-kanban-card-assignee-stale');
		}
		chip.setAttribute('title', lookup ? `Assignee: ${label}` : `Assignee: ${topic.assignee} (not in team)`);
	}

	// Snooze chip. Active snooze shows the wake date; an expired-but-uncleared snooze shows
	// a "woke" marker so the return to the board is noticed (and can be cleared or renewed).
	if (topic.snoozedUntil) {
		const chip = card.createDiv({ cls: 'friday-kanban-card-snoozed' });
		if (opts.snoozedActive) {
			chip.setText(`\u{1F4A4} until ${topic.snoozedUntil}`);
			chip.setAttribute('title', `Snoozed until ${topic.snoozedUntil}`);
		} else {
			chip.setText(`\u{1F4A4} woke ${topic.snoozedUntil}`);
			chip.addClass('friday-kanban-card-snoozed-woke');
			chip.setAttribute('title', `Snooze expired on ${topic.snoozedUntil} — clear it with Wake or snooze again`);
		}
	}

	// Optional waiting-on chip. If waitingOn looks like an email and resolves to a team
	// member we show the nickname; otherwise we render the raw value (free-text blocker).
	if (topic.waitingOn) {
		const looksLikeEmail = topic.waitingOn.includes('@');
		const lookup = looksLikeEmail ? opts.assigneeLookup?.(topic.waitingOn) ?? null : null;
		const label = lookup?.label ?? topic.waitingOn;
		const daysSinceNudge = computeDaysSince(topic.lastNudged);
		const threshold = opts.nudgeThresholdDays ?? 7;
		const suffix = topic.lastNudged === null
			? ' · never nudged'
			: daysSinceNudge !== null
				? ` · ${daysSinceNudge}d`
				: '';
		const chip = card.createDiv({ cls: 'friday-kanban-card-waiting' });
		chip.setText(`\u23F3 ${label}${suffix}`);
		const isStale = topic.lastNudged === null
			|| (daysSinceNudge !== null && daysSinceNudge > threshold);
		if (isStale) chip.addClass('friday-kanban-card-waiting-stale');
		chip.setAttribute('title', `Waiting on: ${label}${suffix}`);
	}

	// Dependency chips: "⛓ Blocked by: A, B" (done blockers shown muted/struck-through).
	const deps = opts.dependencyLookup?.(topic);
	if (deps && deps.blockedBy.length > 0) {
		const row = card.createDiv({ cls: 'friday-kanban-card-deps' });
		row.createSpan({ cls: 'friday-kanban-card-deps-label', text: '⛓ Blocked by: ' });
		deps.blockedBy.forEach((b, i) => {
			if (i > 0) row.createSpan({ text: ', ' });
			const chip = row.createSpan({ cls: 'friday-kanban-card-dep-chip', text: b.title });
			if (b.status === 'done') chip.addClass('is-done');
			if (opts.onDependencyClick) {
				chip.addClass('friday-clickable');
				chip.addEventListener('click', (e) => {
					e.stopPropagation();
					opts.onDependencyClick!(b);
				});
			}
		});
	}

	// Linked pages
	if (topic.linkedPages.length > 0) {
		const linksText = topic.linkedPages.map(p => `[[${p}]]`).join(', ');
		card.createDiv({ cls: 'friday-kanban-card-links', text: linksText });
	}

	// External references — Confluence, Figma, SAP, etc.
	if (topic.refs.length > 0) {
		const refsRow = card.createDiv({ cls: 'friday-kanban-card-refs' });
		for (const ref of topic.refs) {
			const chip = refsRow.createSpan({ cls: 'friday-kanban-card-ref-chip' });
			chip.setText(`${ref.label} \u2197`);
			chip.setAttribute('title', ref.url);
			chip.addEventListener('click', (e) => {
				e.stopPropagation();
				window.open(ref.url, '_blank');
			});
		}
	}

	// Task progress bar
	if (topic.taskTotal > 0) {
		const progressDiv = card.createDiv({ cls: 'friday-kanban-card-progress' });
		const barOuter = progressDiv.createDiv({ cls: 'friday-progress-bar' });
		const barInner = barOuter.createDiv({ cls: 'friday-progress-fill' });
		const pct = Math.round((topic.taskDone / topic.taskTotal) * 100);
		barInner.style.width = `${pct}%`;
		progressDiv.createSpan({
			cls: 'friday-progress-text',
			text: `${topic.taskDone}/${topic.taskTotal} tasks`,
		});
	}

	// Action row: status arrows + blocked toggle
	const transitions = STATUS_TRANSITIONS[topic.status];
	const wantsStatusButtons = opts.onStatusChange && (transitions.left || transitions.right);
	const wantsBlockedButton = opts.onBlockedToggle !== undefined;
	const wantsSnoozeButton = opts.onSnooze !== undefined || (opts.onWake !== undefined && !!topic.snoozedUntil);

	if (wantsStatusButtons || wantsBlockedButton || wantsSnoozeButton) {
		const actionsDiv = card.createDiv({ cls: 'friday-kanban-card-actions' });

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
		if (topic.snoozedUntil && opts.onWake) {
			const wakeBtn = actionsDiv.createEl('button', {
				text: '\u{1F4A4} Wake',
				cls: 'friday-kanban-snoozed-active',
			});
			wakeBtn.setAttribute('title', 'Clear the snooze — the topic returns to its column');
			wakeBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				opts.onWake!(topic);
			});
		} else if (opts.onSnooze) {
			const snoozeBtn = actionsDiv.createEl('button', { text: '\u{1F4A4}' });
			snoozeBtn.setAttribute('title', 'Snooze topic — defer it off the board for a while');
			snoozeBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				opts.onSnooze!(topic, e);
			});
		}
		if (wantsBlockedButton) {
			const blockedBtn = actionsDiv.createEl('button', {
				text: topic.blocked ? '\u26A0 Unblock' : '\u26A0',
				cls: topic.blocked ? 'friday-kanban-blocked-active' : '',
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
