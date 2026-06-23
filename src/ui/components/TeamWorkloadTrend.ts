import { TeamRollup, WorkloadSnapshot } from '../../types';
import { createLoadChip } from '../icons';

/** Capacity table (committed vs. target, with a load band) + per-member committed sparklines
 *  and a team-total trend, drawn from persisted weekly workload snapshots. DOM-only. */
export class TeamWorkloadTrend {
	constructor(
		private container: HTMLElement,
		private rollup: TeamRollup,
		private snapshots: WorkloadSnapshot[],
	) {}

	render(): void {
		// Per-member load now lives on the cards; this block is purely the historical trend.
		const recent = this.snapshots.slice(-8);
		if (recent.length < 2) return; // not enough history to trend yet

		const el = this.container.createDiv({ cls: 'friday-team-trend' });
		el.createEl('h4', { text: 'Workload trend (committed / week)' });
		const totals = recent.map(s => s.totals.committed);
		this.renderSpark(el, 'Team total', totals);
		const delta = totals[totals.length - 1] - totals[totals.length - 2];
		el.createDiv({ cls: 'friday-team-trend-delta', text: `${delta >= 0 ? '+' : ''}${delta} since last week` });
		for (const m of this.rollup.members) {
			this.renderSpark(el, m.displayName, recent.map(s => s.members[m.email]?.committed ?? 0));
		}
	}

	private renderSpark(parent: HTMLElement, name: string, series: number[]): void {
		const row = parent.createDiv({ cls: 'friday-team-trend-row' });
		row.createSpan({ cls: 'friday-team-trend-name', text: name });
		const spark = row.createDiv({ cls: 'friday-team-trend-spark' });
		const max = Math.max(1, ...series);
		for (const v of series) {
			const bar = spark.createDiv({ cls: 'friday-team-trend-bar' });
			bar.style.height = `${(v / max) * 100}%`;
			bar.setAttribute('title', String(v));
		}
	}
}
