import { TaskStatus, PluginSettings, PluginData, MonthlySnapshot } from '../types';
import { TaskStore } from './taskStore';
import { getMonthId, getMonthStart, getMonthEnd } from '../utils/monthUtils';

export interface MonthlyStats {
	monthId: string;
	totalPlanned: number;
	totalCompleted: number;
	totalMigrated: number;
	totalCancelled: number;
	completionRate: number;
}

export class MonthlyAnalyticsService {
	private statsCache: { storeVersion: number; monthId: string; stats: MonthlyStats } | null = null;

	constructor(
		private store: TaskStore,
		private getSettings: () => PluginSettings,
		private getData: () => PluginData,
	) {}

	/** Compute stats for the current month */
	getCurrentMonthStats(): MonthlyStats {
		const now = new Date();
		const monthId = getMonthId(now);

		if (this.statsCache && this.statsCache.storeVersion === this.store.version && this.statsCache.monthId === monthId) {
			return this.statsCache.stats;
		}

		const stats = this.computeStats(now);
		this.statsCache = { storeVersion: this.store.version, monthId, stats };
		return stats;
	}

	/** Compute stats for a specific month */
	getStatsForMonth(date: Date): MonthlyStats {
		return this.computeStats(date);
	}

	/** Create a snapshot from stats */
	createSnapshot(stats: MonthlyStats, reflections: string): MonthlySnapshot {
		return {
			monthId: stats.monthId,
			totalPlanned: stats.totalPlanned,
			totalCompleted: stats.totalCompleted,
			totalMigrated: stats.totalMigrated,
			totalCancelled: stats.totalCancelled,
			completionRate: stats.completionRate,
			reflections,
			savedAt: new Date().toISOString(),
		};
	}

	private computeStats(date: Date): MonthlyStats {
		const monthId = getMonthId(date);
		const monthStart = getMonthStart(date);
		const monthEnd = getMonthEnd(date);
		const settings = this.getSettings();

		// Aggregate from weekly snapshots whose weekStart falls in this month
		const weeklyHistory = this.getData().weeklyHistory;
		let totalPlanned = 0;
		let totalCompleted = 0;
		let totalMigrated = 0;
		let totalCancelled = 0;

		for (const snapshot of weeklyHistory) {
			const weekStart = new Date(snapshot.weekStart + 'T00:00:00');
			if (weekStart >= monthStart && weekStart <= monthEnd) {
				totalPlanned += snapshot.totalPlanned;
				totalCompleted += snapshot.totalCompleted;
				totalMigrated += snapshot.totalMigrated;
				totalCancelled += snapshot.totalCancelled;
			}
		}

		// If no weekly snapshots cover this month, compute live from task data
		if (totalPlanned === 0) {
			const allTasks = this.store.getTasks();
			const dailyPrefix = settings.dailyNotePath ? settings.dailyNotePath + '/' : '';
			const monthlyPath = settings.monthlyNotePath ? settings.monthlyNotePath + '/' : '';

			for (const t of allTasks) {
				if (t.parentId !== null) continue;
				let inMonth = false;
				// Check due date in range
				if (t.dueDate && t.dueDate >= monthStart && t.dueDate <= monthEnd) inMonth = true;
				// Check if task lives in a daily note file dated within the month
				if (!inMonth && dailyPrefix && t.sourcePath.startsWith(dailyPrefix)) {
					const fileDate = this.parseDateFromPath(t.sourcePath);
					if (fileDate && fileDate >= monthStart && fileDate <= monthEnd) inMonth = true;
				}
				// Check if task lives in this month's monthly note
				if (!inMonth && monthlyPath && t.sourcePath.startsWith(monthlyPath)) {
					const fileMonthId = this.parseMonthFromPath(t.sourcePath);
					if (fileMonthId === monthId) inMonth = true;
				}
				if (!inMonth) continue;

				totalPlanned++;
				if (t.status === TaskStatus.Done) totalCompleted++;
				if (t.status === TaskStatus.Migrated) totalMigrated++;
				if (t.status === TaskStatus.Cancelled) totalCancelled++;
			}
		}

		const completionRate = totalPlanned > 0 ? (totalCompleted / totalPlanned) * 100 : 0;

		return {
			monthId,
			totalPlanned,
			totalCompleted,
			totalMigrated,
			totalCancelled,
			completionRate,
		};
	}

	private parseDateFromPath(path: string): Date | null {
		const match = path.match(/(\d{4}-\d{2}-\d{2})\.md$/);
		if (!match) return null;
		const d = new Date(match[1] + 'T00:00:00');
		return isNaN(d.getTime()) ? null : d;
	}

	private parseMonthFromPath(path: string): string | null {
		const match = path.match(/(\d{4}-\d{2})\.md$/);
		return match ? match[1] : null;
	}
}
