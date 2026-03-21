import { TaskItem, TaskStatus, WeeklySnapshot, PluginSettings } from '../types';
import { TaskStore } from './taskStore';
import { getWeekId, getWeekStartConfigurable, formatDateISO } from '../utils/dateUtils';

export interface WeeklyStats {
	weekId: string;
	weekStart: Date;
	totalPlanned: number;
	totalCompleted: number;
	totalMigrated: number;
	totalCancelled: number;
	completionRate: number;
	workTypeBreakdown: Map<string, { planned: number; completed: number }>;
	purposeBreakdown: Map<string, { planned: number; completed: number }>;
}

export class AnalyticsService {
	private statsCache: { storeVersion: number; weekId: string; stats: WeeklyStats } | null = null;

	constructor(
		private store: TaskStore,
		private getSettings: () => PluginSettings,
	) {}

	/** Compute stats for the current week */
	getCurrentWeekStats(): WeeklyStats {
		const settings = this.getSettings();
		const now = new Date();
		const weekStart = getWeekStartConfigurable(now, settings.weekStartDay);
		const weekId = getWeekId(weekStart);

		// Return cached stats if store data hasn't changed
		if (this.statsCache && this.statsCache.storeVersion === this.store.version && this.statsCache.weekId === weekId) {
			return this.statsCache.stats;
		}

		const weekEnd = new Date(weekStart);
		weekEnd.setDate(weekEnd.getDate() + 6);
		weekEnd.setHours(23, 59, 59, 999);

		const stats = this.computeStats(weekStart, weekEnd);
		this.statsCache = { storeVersion: this.store.version, weekId, stats };
		return stats;
	}

	/** Compute stats for a specific week start date */
	getStatsForWeek(weekStart: Date): WeeklyStats {
		const weekEnd = new Date(weekStart);
		weekEnd.setDate(weekEnd.getDate() + 6);
		weekEnd.setHours(23, 59, 59, 999);

		return this.computeStats(weekStart, weekEnd);
	}

	/** Create a snapshot from current stats */
	createSnapshot(stats: WeeklyStats): WeeklySnapshot {
		const workTypeBreakdown: Record<string, { planned: number; completed: number }> = {};
		stats.workTypeBreakdown.forEach((v, k) => { workTypeBreakdown[k] = v; });

		const purposeBreakdown: Record<string, { planned: number; completed: number }> = {};
		stats.purposeBreakdown.forEach((v, k) => { purposeBreakdown[k] = v; });

		return {
			weekId: stats.weekId,
			weekStart: formatDateISO(stats.weekStart),
			totalPlanned: stats.totalPlanned,
			totalCompleted: stats.totalCompleted,
			totalMigrated: stats.totalMigrated,
			totalCancelled: stats.totalCancelled,
			workTypeBreakdown,
			purposeBreakdown,
			savedAt: new Date().toISOString(),
		};
	}

	private computeStats(weekStart: Date, weekEnd: Date): WeeklyStats {
		const weekId = getWeekId(weekStart);
		const allTasks = this.store.getTasks();
		const settings = this.getSettings();

		// Filter tasks relevant to this week:
		// 1. Tasks with due dates within the week
		// 2. Tasks from daily note files dated within the week (even without due dates)
		const dailyPrefix = settings.dailyNotePath ? settings.dailyNotePath + '/' : '';
		const weekTasks = allTasks.filter(t => {
			// Check due date in range
			if (t.dueDate && t.dueDate >= weekStart && t.dueDate <= weekEnd) return true;
			// Check if task lives in a daily note file dated within the week
			if (dailyPrefix && t.sourcePath.startsWith(dailyPrefix)) {
				const fileDate = this.parseDateFromPath(t.sourcePath);
				if (fileDate && fileDate >= weekStart && fileDate <= weekEnd) return true;
			}
			return false;
		});

		let totalPlanned = weekTasks.length;
		let totalCompleted = 0;
		let totalMigrated = 0;
		let totalCancelled = 0;

		const workTypeBreakdown = new Map<string, { planned: number; completed: number }>();
		const purposeBreakdown = new Map<string, { planned: number; completed: number }>();

		for (const task of weekTasks) {
			if (task.status === TaskStatus.Done) totalCompleted++;
			if (task.status === TaskStatus.Migrated) totalMigrated++;
			if (task.status === TaskStatus.Cancelled) totalCancelled++;

			// Work type breakdown
			const wt = task.workType || 'Untagged';
			if (!workTypeBreakdown.has(wt)) {
				workTypeBreakdown.set(wt, { planned: 0, completed: 0 });
			}
			const wtEntry = workTypeBreakdown.get(wt)!;
			wtEntry.planned++;
			if (task.status === TaskStatus.Done) wtEntry.completed++;

			// Purpose breakdown
			const p = task.purpose || 'Untagged';
			if (!purposeBreakdown.has(p)) {
				purposeBreakdown.set(p, { planned: 0, completed: 0 });
			}
			const pEntry = purposeBreakdown.get(p)!;
			pEntry.planned++;
			if (task.status === TaskStatus.Done) pEntry.completed++;
		}

		const completionRate = totalPlanned > 0 ? (totalCompleted / totalPlanned) * 100 : 0;

		return {
			weekId,
			weekStart,
			totalPlanned,
			totalCompleted,
			totalMigrated,
			totalCancelled,
			completionRate,
			workTypeBreakdown,
			purposeBreakdown,
		};
	}

	/** Extract a Date from a daily note file path like "BuJo/Daily/2026-03-17.md" */
	private parseDateFromPath(path: string): Date | null {
		const match = path.match(/(\d{4}-\d{2}-\d{2})\.md$/);
		if (!match) return null;
		const d = new Date(match[1] + 'T00:00:00');
		return isNaN(d.getTime()) ? null : d;
	}
}
