import { PluginData } from '../types';
import { formatDateISO } from '../utils/dateUtils';

/**
 * Morning Review daily guard.
 *
 * v3 retired the old "daily migration" morning-shuffle (tasks now float by date and
 * surface in the Today view — no carry-forward ritual). What survived is the start-of-day
 * *nudge* surface: overdue 1:1s and stale waiting-on topics, plus a quick capture. This
 * service holds nothing but the once-per-day guard so the startup prompt fires at most
 * once each day; the nudge content itself is gathered by `MorningReviewModal` from the
 * team- and topic-services.
 */
export class MorningReviewService {
    constructor(
        private getData: () => PluginData,
        private saveData: () => Promise<void>,
    ) {}

    /** True if the Morning Review was already shown today (startup prompt guard). */
    alreadyReviewedToday(): boolean {
        return this.getData().lastMorningReviewDate === formatDateISO(new Date());
    }

    /** Stamp today's date so the startup prompt does not re-open for the rest of the day. */
    async markReviewedToday(): Promise<void> {
        this.getData().lastMorningReviewDate = formatDateISO(new Date());
        await this.saveData();
    }
}
