import { TaskItem, TaskStatus, ItemCategory, PluginData, PluginSettings } from '../types';
import { TaskStore } from './taskStore';
import { TaskWriter } from './taskWriter';
import { MonthlyNoteService } from './monthlyNoteService';
import { getMonthId, getPreviousMonth } from '../utils/monthUtils';

export type MonthlyMigrationAction = 'forward-all' | 'forward-goal-only' | 'done' | 'cancel';

export interface MonthlyMigrationDecision {
	goal: TaskItem;
	action: MonthlyMigrationAction;
}

export interface MonthlyMigrationResult {
	forwardedAll: number;
	forwardedGoalOnly: number;
	completed: number;
	cancelled: number;
}

export interface MonthlyReviewData {
	/** Open root goals from last month's note */
	incompleteGoals: TaskItem[];
	/** Month ID of the previous month (YYYY-MM) */
	lastMonthId: string;
}

export class MonthlyMigrationService {
	constructor(
		private store: TaskStore,
		private writer: TaskWriter,
		private monthlyNotes: MonthlyNoteService,
		private getData: () => PluginData,
		private saveData: () => Promise<void>,
		private getSettings: () => PluginSettings,
	) {}

	/** Check if monthly migration is needed */
	needsMonthlyMigration(): boolean {
		const { lastMonthlyMigrationMonth } = this.getData();
		const currentMonthId = getMonthId(new Date());

		if (lastMonthlyMigrationMonth === currentMonthId) {
			return false;
		}

		// Check if there are actually open goals in the previous month's note
		const reviewData = this.getMonthlyReviewData();
		return reviewData.incompleteGoals.length > 0;
	}

	/** Gather data for the monthly migration modal */
	getMonthlyReviewData(): MonthlyReviewData {
		const prevMonth = getPreviousMonth(new Date());
		const lastMonthId = getMonthId(prevMonth);
		const settings = this.getSettings();
		const lastMonthNotePath = `${settings.monthlyNotePath}/${lastMonthId}.md`;

		// Get open root goals from the previous month's note
		const incompleteGoals = this.store.getGoalsForPath(lastMonthNotePath)
			.filter(g => g.status === TaskStatus.Open);

		return { incompleteGoals, lastMonthId };
	}

	/** Execute monthly migration decisions */
	async executeMigrations(decisions: MonthlyMigrationDecision[]): Promise<MonthlyMigrationResult> {
		const result: MonthlyMigrationResult = {
			forwardedAll: 0,
			forwardedGoalOnly: 0,
			completed: 0,
			cancelled: 0,
		};

		const today = new Date();

		for (const decision of decisions) {
			const { goal } = decision;
			const openChildren = goal.childrenIds
				.map(id => this.store.getTaskById(id))
				.filter((c): c is TaskItem => c !== undefined && c.status === TaskStatus.Open);

			switch (decision.action) {
				case 'forward-all': {
					// Mark goal as migrated
					await this.writer.setStatus(goal, TaskStatus.Migrated);
					// Mark open children as migrated
					if (openChildren.length > 0) {
						await this.writer.setStatusBatch(openChildren, TaskStatus.Migrated);
					}
					// Add goal + open children to new month
					await this.monthlyNotes.addMigratedGoal(goal, openChildren, today);
					result.forwardedAll++;
					break;
				}

				case 'forward-goal-only': {
					// Mark goal as migrated (children stay in old note)
					await this.writer.setStatus(goal, TaskStatus.Migrated);
					// Add goal only (fresh start) to new month
					await this.monthlyNotes.addMigratedGoalOnly(goal, today);
					result.forwardedGoalOnly++;
					break;
				}

				case 'done': {
					const toComplete = openChildren.length > 0 ? [goal, ...openChildren] : [goal];
					await this.writer.setStatusBatch(toComplete, TaskStatus.Done);
					result.completed++;
					break;
				}

				case 'cancel': {
					const toCancel = openChildren.length > 0 ? [goal, ...openChildren] : [goal];
					await this.writer.setStatusBatch(toCancel, TaskStatus.Cancelled);
					result.cancelled++;
					break;
				}
			}
		}

		await this.markMonthlyMigrationDone();
		return result;
	}

	async markMonthlyMigrationDone(): Promise<void> {
		this.getData().lastMonthlyMigrationMonth = getMonthId(new Date());
		await this.saveData();
	}
}
