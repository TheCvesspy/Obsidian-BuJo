/**
 * Check if a date is today.
 * @param refNow Optional precomputed "now" to avoid repeated new Date() in loops.
 */
export function isToday(date: Date, refNow?: Date): boolean {
	const now = refNow ?? new Date();
	return date.getFullYear() === now.getFullYear() &&
		date.getMonth() === now.getMonth() &&
		date.getDate() === now.getDate();
}

/**
 * Check if a date falls within the current week.
 * @param weekStartDay Optional configurable start day (0=Sun..6=Sat). Defaults to Monday.
 */
export function isThisWeek(date: Date, weekStartDay: number = 1): boolean {
	const now = new Date();
	const start = getWeekStartConfigurable(now, weekStartDay);
	const end = new Date(start);
	end.setDate(end.getDate() + 6);
	end.setHours(23, 59, 59, 999);

	return date >= start && date <= end;
}

/**
 * Check if a date is overdue (before today and not today).
 * @param refTodayStart Optional precomputed today-at-midnight to avoid repeated new Date() in loops.
 */
export function isOverdue(date: Date, refTodayStart?: Date): boolean {
	const start = refTodayStart ?? todayStart();
	return date < start;
}

/**
 * Get the Monday of the week containing the given date.
 */
export function getWeekStart(date: Date): Date {
	const d = new Date(date);
	const day = d.getDay();
	// Adjust so Monday = 0
	const diff = day === 0 ? -6 : 1 - day;
	d.setDate(d.getDate() + diff);
	d.setHours(0, 0, 0, 0);
	return d;
}

/**
 * Get all 7 days (Mon-Sun) of the week containing the given date.
 */
export function getWeekDays(date: Date): Date[] {
	const monday = getWeekStart(date);
	const days: Date[] = [];
	for (let i = 0; i < 7; i++) {
		const d = new Date(monday);
		d.setDate(d.getDate() + i);
		days.push(d);
	}
	return days;
}

/**
 * Format a date as DD-MM-YYYY.
 */
export function formatDateDMY(date: Date): string {
	const dd = String(date.getDate()).padStart(2, '0');
	const mm = String(date.getMonth() + 1).padStart(2, '0');
	const yyyy = date.getFullYear();
	return `${dd}-${mm}-${yyyy}`;
}

/**
 * Format a date as YYYY-MM-DD (ISO-style).
 */
export function formatDateISO(date: Date): string {
	const dd = String(date.getDate()).padStart(2, '0');
	const mm = String(date.getMonth() + 1).padStart(2, '0');
	const yyyy = date.getFullYear();
	return `${yyyy}-${mm}-${dd}`;
}

/**
 * Format a date for display: "Mon, Mar 16".
 */
export function formatDateDisplay(date: Date): string {
	const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
	const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
		'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	return `${days[date.getDay()]}, ${months[date.getMonth()]} ${date.getDate()}`;
}

/**
 * Check if two dates are the same calendar day.
 */
export function isSameDay(a: Date, b: Date): boolean {
	return a.getFullYear() === b.getFullYear() &&
		a.getMonth() === b.getMonth() &&
		a.getDate() === b.getDate();
}

/**
 * Get today's date at midnight.
 */
export function todayStart(): Date {
	const now = new Date();
	return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/**
 * Convert ISO date (YYYY-MM-DD, from <input type="date">) to plugin format (DD-MM-YYYY).
 */
export function isoToPluginDate(iso: string): string {
	const parts = iso.split('-');
	if (parts.length !== 3) return iso;
	return `${parts[2]}-${parts[1]}-${parts[0]}`;
}

/**
 * Convert plugin date (DD-MM-YYYY or DD-MM) to ISO format (YYYY-MM-DD) for <input type="date">.
 */
export function pluginDateToIso(pluginDate: string): string {
	const parts = pluginDate.split('-');
	if (parts.length === 3) {
		return `${parts[2]}-${parts[1]}-${parts[0]}`;
	}
	if (parts.length === 2) {
		const year = new Date().getFullYear();
		return `${year}-${parts[1]}-${parts[0]}`;
	}
	return pluginDate;
}

/**
 * Get ISO week number for a date. Returns 1-53.
 * Based on ISO 8601: week starts Monday, first week contains January 4th.
 */
export function getISOWeekNumber(date: Date): number {
	const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
	// Set to nearest Thursday: current date + 4 - current day number (Mon=1, Sun=7)
	const dayNum = d.getUTCDay() || 7;
	d.setUTCDate(d.getUTCDate() + 4 - dayNum);
	const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
	return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

/**
 * Get ISO week year for a date (may differ from calendar year at year boundaries).
 */
export function getISOWeekYear(date: Date): number {
	const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
	const dayNum = d.getUTCDay() || 7;
	d.setUTCDate(d.getUTCDate() + 4 - dayNum);
	return d.getUTCFullYear();
}

/**
 * Format a week identifier as WW-YYYY (e.g. "12-2026").
 */
export function getWeekId(date: Date): string {
	const week = getISOWeekNumber(date);
	const year = getISOWeekYear(date);
	return `${String(week).padStart(2, '0')}-${year}`;
}

/**
 * Format a week ID for display: "W12-2026".
 */
export function formatWeekId(weekId: string): string {
	return `W${weekId}`;
}

/**
 * Get the start of the week containing the given date, respecting configurable week start day.
 * @param date The reference date
 * @param weekStartDay 0=Sunday, 1=Monday, ... 6=Saturday
 */
export function getWeekStartConfigurable(date: Date, weekStartDay: number): Date {
	const d = new Date(date);
	const day = d.getDay();
	const diff = (day - weekStartDay + 7) % 7;
	d.setDate(d.getDate() - diff);
	d.setHours(0, 0, 0, 0);
	return d;
}

/**
 * Get all 7 days of the week containing the given date, respecting configurable week start day.
 */
export function getWeekDaysConfigurable(date: Date, weekStartDay: number): Date[] {
	const start = getWeekStartConfigurable(date, weekStartDay);
	const days: Date[] = [];
	for (let i = 0; i < 7; i++) {
		const d = new Date(start);
		d.setDate(d.getDate() + i);
		days.push(d);
	}
	return days;
}
