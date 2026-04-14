import { TaskItem, PluginSettings, Priority, TaskStatus } from '../../types';
import { TaskStore } from '../../services/taskStore';
import { TaskItemRow, TaskItemRowCallbacks } from './TaskItemRow';

type ImpactLevel = 'high' | 'medium' | 'low';

/** Purpose names that carry higher weight in impact calculation */
const HIGH_IMPACT_PURPOSES = ['Delivery', 'Strategy'];
const LOW_IMPACT_PURPOSES = ['Capability', 'Support'];

interface Quadrant {
	key: string;
	title: string;
	subtitle: string;
	cls: string;
	tasks: TaskItem[];
}

function calculateImpact(task: TaskItem): ImpactLevel {
	const priorityWeight: Record<string, number> = {
		[Priority.High]: 3,
		[Priority.Medium]: 2,
		[Priority.Low]: 1,
		[Priority.None]: 0,
	};
	const pw = priorityWeight[task.priority] ?? 0;

	let ppw = 0;
	if (task.purpose) {
		if (HIGH_IMPACT_PURPOSES.includes(task.purpose)) ppw = 2;
		else if (LOW_IMPACT_PURPOSES.includes(task.purpose)) ppw = 1;
	}

	const score = pw + ppw;
	if (score >= 4) return 'high';
	if (score >= 2) return 'medium';
	return 'low';
}

function getUrgencyBadge(task: TaskItem): string | null {
	if (!task.dueDate) return null;
	const now = new Date();
	now.setHours(0, 0, 0, 0);
	const diffDays = (task.dueDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
	if (diffDays < 0) return '\u{1F534}'; // red circle — overdue
	if (diffDays <= 7) return '\u{1F7E1}'; // yellow circle — due this week
	return null;
}

export class ImpactEffortView {
	private el: HTMLElement;

	constructor(
		container: HTMLElement,
		private store: TaskStore,
		private settings: PluginSettings,
		private callbacks: TaskItemRowCallbacks,
		private searchQuery: string,
		private collapsedGroups: Set<string>,
	) {
		this.el = container.createDiv({ cls: 'task-bujo-impact-effort' });
	}

	render(): void {
		this.el.empty();

		// Get open root tasks only
		let tasks = this.store.getTasks().filter(t =>
			t.parentId === null && t.status === TaskStatus.Open
		);

		if (this.searchQuery) {
			const q = this.searchQuery.toLowerCase();
			tasks = tasks.filter(t => t.text.toLowerCase().includes(q));
		}

		// Classify into quadrants + inbox
		const quickWins: TaskItem[] = [];
		const bigBets: TaskItem[] = [];
		const fillIns: TaskItem[] = [];
		const timeSinks: TaskItem[] = [];
		const inbox: TaskItem[] = [];

		for (const task of tasks) {
			if (!task.effort) {
				inbox.push(task);
				continue;
			}

			const impact = calculateImpact(task);
			const isHighImpact = impact === 'high' || impact === 'medium';
			const isSmallEffort = task.effort === 'S';

			if (isHighImpact && isSmallEffort) quickWins.push(task);
			else if (isHighImpact && !isSmallEffort) bigBets.push(task);
			else if (!isHighImpact && isSmallEffort) fillIns.push(task);
			else timeSinks.push(task);
		}

		const quadrants: Quadrant[] = [
			{ key: 'quickwins', title: '\u{1F3AF} Quick Wins', subtitle: 'High Impact + Small Effort \u2014 Do these first', cls: 'task-bujo-ie-quickwins', tasks: quickWins },
			{ key: 'bigbets', title: '\u{1F680} Big Bets', subtitle: 'High Impact + Med/Large Effort \u2014 Block deep work', cls: 'task-bujo-ie-bigbets', tasks: bigBets },
			{ key: 'fillins', title: '\u{1F4CB} Fill-ins', subtitle: 'Low Impact + Small Effort \u2014 Between meetings', cls: 'task-bujo-ie-fillins', tasks: fillIns },
			{ key: 'timesinks', title: '\u26A0\uFE0F Time Sinks', subtitle: 'Low Impact + Med/Large Effort \u2014 Rethink', cls: 'task-bujo-ie-timesinks', tasks: timeSinks },
		];

		// Axis labels
		const axisRow = this.el.createDiv({ cls: 'task-bujo-ie-axis-labels' });
		axisRow.createDiv(); // empty corner
		axisRow.createDiv({ cls: 'task-bujo-ie-axis-label', text: 'Small Effort' });
		axisRow.createDiv({ cls: 'task-bujo-ie-axis-label', text: 'Medium / Large Effort' });

		// Grid
		const grid = this.el.createDiv({ cls: 'task-bujo-ie-grid' });

		for (const q of quadrants) {
			this.renderQuadrant(grid, q);
		}

		// Inbox (tasks without effort estimate)
		const inboxQuadrant: Quadrant = {
			key: 'inbox',
			title: '\u{1F4E5} Inbox',
			subtitle: 'No effort estimate \u2014 needs sizing',
			cls: 'task-bujo-ie-inbox',
			tasks: inbox,
		};
		this.renderQuadrant(this.el, inboxQuadrant);
	}

	private renderQuadrant(container: HTMLElement, quadrant: Quadrant): void {
		const el = container.createDiv({ cls: `task-bujo-ie-quadrant ${quadrant.cls}` });

		// Header
		const header = el.createDiv({ cls: 'task-bujo-ie-quadrant-header' });
		const titleArea = header.createDiv();
		titleArea.createDiv({ cls: 'task-bujo-ie-quadrant-title', text: quadrant.title });
		titleArea.createDiv({ cls: 'task-bujo-ie-quadrant-subtitle', text: quadrant.subtitle });
		header.createDiv({ cls: 'task-bujo-ie-quadrant-count', text: String(quadrant.tasks.length) });

		// Task list
		const list = el.createDiv({ cls: 'task-bujo-ie-task-list' });

		if (quadrant.tasks.length === 0) {
			list.createDiv({ cls: 'task-bujo-empty', text: 'No tasks' });
			return;
		}

		for (const task of quadrant.tasks) {
			const row = list.createDiv({ cls: 'task-bujo-ie-task-row' });

			// Urgency badge
			const badge = getUrgencyBadge(task);
			if (badge) {
				row.createSpan({ cls: 'task-bujo-urgency-badge', text: badge });
			}

			new TaskItemRow(row, task, this.callbacks);
		}
	}
}
