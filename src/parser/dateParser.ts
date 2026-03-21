/**
 * Parses due-date strings in DD-MM-YYYY or DD-MM format.
 * DD-MM resolves to the nearest future occurrence of that date.
 */
export function parseDueDate(raw: string): Date | null {
	const parts = raw.split('-');
	if (parts.length < 2 || parts.length > 3) return null;

	const day = parseInt(parts[0], 10);
	const month = parseInt(parts[1], 10);

	if (isNaN(day) || isNaN(month) || month < 1 || month > 12 || day < 1 || day > 31) {
		return null;
	}

	if (parts.length === 3) {
		const year = parseInt(parts[2], 10);
		if (isNaN(year)) return null;
		const date = new Date(year, month - 1, day);
		// Validate the date components didn't overflow (e.g. Feb 30)
		if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
			return null;
		}
		return date;
	}

	// DD-MM only: resolve to nearest future occurrence
	const today = new Date();
	today.setHours(0, 0, 0, 0);

	const thisYear = today.getFullYear();
	const candidate = new Date(thisYear, month - 1, day);

	// Validate date components
	if (candidate.getMonth() !== month - 1 || candidate.getDate() !== day) {
		return null;
	}

	if (candidate >= today) {
		return candidate;
	}

	// Date is in the past this year, use next year
	const nextYear = new Date(thisYear + 1, month - 1, day);
	return nextYear;
}
