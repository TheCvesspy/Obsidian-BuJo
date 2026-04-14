/**
 * Day-of-week names for natural language parsing.
 */
const DAY_NAMES: Record<string, number> = {
	'sunday': 0, 'sun': 0,
	'monday': 1, 'mon': 1,
	'tuesday': 2, 'tue': 2,
	'wednesday': 3, 'wed': 3,
	'thursday': 4, 'thu': 4,
	'friday': 5, 'fri': 5,
	'saturday': 6, 'sat': 6,
};

/**
 * Parse natural language date expressions.
 * Returns null if no pattern matches.
 */
function parseNaturalDate(raw: string): Date | null {
	const input = raw.toLowerCase().trim();
	const today = new Date();
	today.setHours(0, 0, 0, 0);

	// Simple keywords
	if (input === 'today') {
		return new Date(today);
	}
	if (input === 'tomorrow') {
		const d = new Date(today);
		d.setDate(d.getDate() + 1);
		return d;
	}
	if (input === 'yesterday') {
		const d = new Date(today);
		d.setDate(d.getDate() - 1);
		return d;
	}

	// "next week" → next Monday
	if (input === 'next week') {
		const d = new Date(today);
		const daysUntilMonday = ((1 - d.getDay()) + 7) % 7 || 7;
		d.setDate(d.getDate() + daysUntilMonday);
		return d;
	}

	// "next month" → 1st of next month
	if (input === 'next month') {
		const d = new Date(today);
		d.setMonth(d.getMonth() + 1, 1);
		return d;
	}

	// "end of week" → next Friday (or this Friday if today is before Friday)
	if (input === 'end of week' || input === 'eow') {
		const d = new Date(today);
		const dayOfWeek = d.getDay();
		const daysUntilFriday = ((5 - dayOfWeek) + 7) % 7 || 7;
		d.setDate(d.getDate() + daysUntilFriday);
		return d;
	}

	// "end of month" / "eom" → last day of current month
	if (input === 'end of month' || input === 'eom') {
		const d = new Date(today.getFullYear(), today.getMonth() + 1, 0);
		return d;
	}

	// "next <dayname>" or just "<dayname>" → next occurrence of that weekday
	const nextDayMatch = input.match(/^(?:next\s+)?(\w+)$/);
	if (nextDayMatch && DAY_NAMES[nextDayMatch[1]] !== undefined) {
		const targetDay = DAY_NAMES[nextDayMatch[1]];
		const d = new Date(today);
		const currentDay = d.getDay();
		let daysAhead = (targetDay - currentDay + 7) % 7;
		if (daysAhead === 0) daysAhead = 7; // always go to next week if same day
		d.setDate(d.getDate() + daysAhead);
		return d;
	}

	// "in N days/weeks/months"
	const inMatch = input.match(/^in\s+(\d+)\s+(days?|weeks?|months?)$/);
	if (inMatch) {
		const n = parseInt(inMatch[1], 10);
		const unit = inMatch[2];
		const d = new Date(today);
		if (unit.startsWith('day')) {
			d.setDate(d.getDate() + n);
		} else if (unit.startsWith('week')) {
			d.setDate(d.getDate() + n * 7);
		} else if (unit.startsWith('month')) {
			d.setMonth(d.getMonth() + n);
		}
		return d;
	}

	return null;
}

/**
 * Parses due-date strings.
 * Tries natural language first (today, tomorrow, next friday, in 3 days, etc.),
 * then falls back to DD-MM-YYYY or DD-MM format.
 * DD-MM resolves to the nearest future occurrence of that date.
 */
export function parseDueDate(raw: string): Date | null {
	// Try natural language parsing first
	const natural = parseNaturalDate(raw.trim());
	if (natural) return natural;

	// Fall back to DD-MM-YYYY or DD-MM numeric parsing
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
