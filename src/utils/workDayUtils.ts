/**
 * Utility functions for counting work days (Monday–Friday).
 */

/** Returns true if the given date is a weekday (Mon–Fri). */
export function isWorkDay(date: Date): boolean {
	const day = date.getDay();
	return day !== 0 && day !== 6; // 0 = Sunday, 6 = Saturday
}

/**
 * Count work days between two dates (inclusive of start, exclusive of end).
 * If start >= end, returns 0.
 */
export function countWorkDaysBetween(start: Date, end: Date): number {
	let count = 0;
	const current = new Date(start);
	current.setHours(0, 0, 0, 0);
	const endNorm = new Date(end);
	endNorm.setHours(0, 0, 0, 0);

	while (current < endNorm) {
		if (isWorkDay(current)) {
			count++;
		}
		current.setDate(current.getDate() + 1);
	}
	return count;
}

/**
 * Count work days remaining from today until endDate (inclusive of endDate).
 * Returns 0 if endDate is in the past.
 */
export function workDaysRemaining(endDate: Date): number {
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	const end = new Date(endDate);
	end.setHours(0, 0, 0, 0);

	if (end < today) return 0;

	// Count from today up to and including endDate
	let count = 0;
	const current = new Date(today);
	while (current <= end) {
		if (isWorkDay(current)) {
			count++;
		}
		current.setDate(current.getDate() + 1);
	}
	return count;
}

/**
 * Add N work days to a date, returning the resulting date.
 * E.g., addWorkDays(Friday, 1) => Monday.
 */
export function addWorkDays(start: Date, workDays: number): Date {
	const result = new Date(start);
	let added = 0;
	while (added < workDays) {
		result.setDate(result.getDate() + 1);
		if (isWorkDay(result)) {
			added++;
		}
	}
	return result;
}

/**
 * Count total work days in a date range (inclusive of both start and end).
 */
export function totalWorkDays(start: Date, end: Date): number {
	const s = new Date(start);
	s.setHours(0, 0, 0, 0);
	const e = new Date(end);
	e.setHours(0, 0, 0, 0);

	if (e < s) return 0;

	let count = 0;
	const current = new Date(s);
	while (current <= e) {
		if (isWorkDay(current)) {
			count++;
		}
		current.setDate(current.getDate() + 1);
	}
	return count;
}
