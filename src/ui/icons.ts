import { setIcon } from 'obsidian';

/** Set the BuJo ribbon/tab icon on an element */
export function setTaskBuJoIcon(el: HTMLElement): void {
	setIcon(el, 'check-square');
}

/** Priority indicator dot colors (CSS classes) */
export const PRIORITY_CLASSES: Record<string, string> = {
	high: 'task-bujo-priority-high',
	medium: 'task-bujo-priority-medium',
	low: 'task-bujo-priority-low',
	none: '',
};

/** BuJo status display characters */
export const STATUS_DISPLAY: Record<string, string> = {
	' ': '',
	'x': '✓',
	'>': '→',
	'<': '←',
	'-': '—',
};

/** Create a priority indicator dot element */
export function createPriorityDot(priority: string): HTMLElement {
	const dot = document.createElement('span');
	dot.addClass('task-bujo-priority-dot');
	if (PRIORITY_CLASSES[priority]) {
		dot.addClass(PRIORITY_CLASSES[priority]);
	}
	return dot;
}

/** Create a due date badge element */
export function createDueBadge(text: string, isOverdue: boolean): HTMLElement {
	const badge = document.createElement('span');
	badge.addClass('task-bujo-due-badge');
	if (isOverdue) {
		badge.addClass('task-bujo-due-overdue');
	}
	badge.textContent = text;
	return badge;
}

/** Create a source link element */
export function createSourceLink(fileName: string): HTMLElement {
	const link = document.createElement('span');
	link.addClass('task-bujo-source-link');
	link.textContent = fileName;
	return link;
}

/** Create a status marker element for migrated/scheduled/cancelled */
export function createStatusMarker(statusChar: string): HTMLElement {
	const marker = document.createElement('span');
	marker.addClass('task-bujo-status-marker');
	const display = STATUS_DISPLAY[statusChar] || '';
	if (display) {
		marker.textContent = display;
		marker.addClass(`task-bujo-status-${statusChar === '>' ? 'migrated' : statusChar === '<' ? 'scheduled' : 'cancelled'}`);
	}
	return marker;
}
