const MONTH_NAMES = [
	'January', 'February', 'March', 'April', 'May', 'June',
	'July', 'August', 'September', 'October', 'November', 'December',
];

/** Returns month identifier in YYYY-MM format (e.g. "2026-03") */
export function getMonthId(date: Date): string {
	const y = date.getFullYear();
	const m = String(date.getMonth() + 1).padStart(2, '0');
	return `${y}-${m}`;
}

/** Returns display string like "March 2026" */
export function formatMonthDisplay(date: Date): string {
	return `${MONTH_NAMES[date.getMonth()]} ${date.getFullYear()}`;
}

/** Returns display string from a monthId like "2026-03" → "March 2026" */
export function formatMonthIdDisplay(monthId: string): string {
	const [year, month] = monthId.split('-');
	const monthIndex = parseInt(month, 10) - 1;
	return `${MONTH_NAMES[monthIndex]} ${year}`;
}

/** Returns the first day of the month at 00:00:00 */
export function getMonthStart(date: Date): Date {
	return new Date(date.getFullYear(), date.getMonth(), 1);
}

/** Returns the last day of the month at 23:59:59.999 */
export function getMonthEnd(date: Date): Date {
	return new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999);
}

/** Returns the first day of the previous month */
export function getPreviousMonth(date: Date): Date {
	return new Date(date.getFullYear(), date.getMonth() - 1, 1);
}

/** Returns the first day of the next month */
export function getNextMonth(date: Date): Date {
	return new Date(date.getFullYear(), date.getMonth() + 1, 1);
}

/** Parse a monthId (YYYY-MM) into a Date (1st of month) */
export function parseMonthId(monthId: string): Date {
	const [year, month] = monthId.split('-').map(Number);
	return new Date(year, month - 1, 1);
}
