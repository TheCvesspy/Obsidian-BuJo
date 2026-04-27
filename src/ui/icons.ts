import { setIcon } from 'obsidian';

/** Set the Friday ribbon/tab icon on an element */
export function setFridayIcon(el: HTMLElement): void {
	setIcon(el, 'check-square');
}

/** Priority indicator dot colors (CSS classes) */
export const PRIORITY_CLASSES: Record<string, string> = {
	high: 'friday-priority-high',
	medium: 'friday-priority-medium',
	low: 'friday-priority-low',
	none: '',
};

/** Friday status display characters */
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
	dot.addClass('friday-priority-dot');
	if (PRIORITY_CLASSES[priority]) {
		dot.addClass(PRIORITY_CLASSES[priority]);
	}
	return dot;
}

/** Create a due date badge element */
export function createDueBadge(text: string, isOverdue: boolean): HTMLElement {
	const badge = document.createElement('span');
	badge.addClass('friday-due-badge');
	if (isOverdue) {
		badge.addClass('friday-due-overdue');
	}
	badge.textContent = text;
	return badge;
}

/** Create a source link element */
export function createSourceLink(fileName: string): HTMLElement {
	const link = document.createElement('span');
	link.addClass('friday-source-link');
	link.textContent = fileName;
	return link;
}

/** Create a status marker element for migrated/scheduled/cancelled */
export function createStatusMarker(statusChar: string): HTMLElement {
	const marker = document.createElement('span');
	marker.addClass('friday-status-marker');
	const display = STATUS_DISPLAY[statusChar] || '';
	if (display) {
		marker.textContent = display;
		marker.addClass(`friday-status-${statusChar === '>' ? 'migrated' : statusChar === '<' ? 'scheduled' : 'cancelled'}`);
	}
	return marker;
}

/** Cadence chip used on Team Overview cards.
 *  `state` maps to a colour via CSS — overdue=red, due-soon=amber, on-track=green,
 *  never=muted, suspended=grey-striped. */
export function createCadenceChip(state: string, label: string): HTMLElement {
	const chip = document.createElement('span');
	chip.addClass('friday-cadence-chip');
	chip.addClass(`friday-cadence-${state}`);
	chip.textContent = label;
	return chip;
}
