import { App, TFile } from 'obsidian';
import { TeamRollup } from '../../types';

export interface TeamStatusSummaryOptions {
	onCopyDigest: () => void;
	onGenerateDigest: () => void;
}

/** Live "team status" block rendered above the person cards on the Team Dashboard.
 *  Read-only view of a TeamRollup: top blockers, at-risk, currently-driving, overdue 1:1s. */
export class TeamStatusSummary {
	constructor(
		private container: HTMLElement,
		private app: App,
		private rollup: TeamRollup,
		private freshnessLabel: string,
		private opts: TeamStatusSummaryOptions,
	) {}

	render(): void {
		const el = this.container.createDiv({ cls: 'friday-team-status' });

		const header = el.createDiv({ cls: 'friday-team-status-header' });
		header.createEl('h3', { text: 'Team status' });
		header.createSpan({ cls: 'friday-team-status-meta', text: this.freshnessLabel });
		const copyBtn = header.createEl('button', { cls: 'friday-btn', text: 'Copy digest' });
		copyBtn.addEventListener('click', () => this.opts.onCopyDigest());
		const genBtn = header.createEl('button', { cls: 'friday-btn', text: 'Generate digest' });
		genBtn.addEventListener('click', () => this.opts.onGenerateDigest());

		// "Currently driving" now lives on each person card, so it's omitted here to avoid duplication.
		this.renderBlockers(el);
		this.renderAtRisk(el);
		this.renderCadence(el);
	}

	private section(parent: HTMLElement, title: string): HTMLElement {
		const sec = parent.createDiv({ cls: 'friday-team-status-section' });
		sec.createEl('h4', { text: title });
		return sec;
	}

	private renderBlockers(parent: HTMLElement): void {
		const sec = this.section(parent, `Top blockers (${this.rollup.topBlockers.length})`);
		if (this.rollup.topBlockers.length === 0) {
			sec.createDiv({ cls: 'friday-empty', text: 'No blockers.' });
			return;
		}
		for (const b of this.rollup.topBlockers.slice(0, 12)) {
			const row = sec.createDiv({ cls: 'friday-team-status-row' });
			if (b.ownerName) row.createSpan({ cls: 'friday-team-status-owner', text: b.ownerName });
			const titleEl = row.createSpan({ cls: 'friday-team-status-title', text: b.title });
			this.wireRef(titleEl, b.ref, b.url);
			if (b.detail) row.createSpan({ cls: 'friday-team-status-detail', text: b.detail });
		}
	}

	private renderAtRisk(parent: HTMLElement): void {
		const sec = this.section(parent, `At risk (${this.rollup.atRisk.length})`);
		if (this.rollup.atRisk.length === 0) {
			sec.createDiv({ cls: 'friday-empty', text: 'Nothing due soon.' });
			return;
		}
		for (const a of this.rollup.atRisk.slice(0, 12)) {
			const row = sec.createDiv({ cls: 'friday-team-status-row' });
			if (a.ownerName) row.createSpan({ cls: 'friday-team-status-owner', text: a.ownerName });
			const titleEl = row.createSpan({ cls: 'friday-team-status-title', text: a.title });
			this.wireRef(titleEl, a.ref, a.url);
			const when = a.daysUntilDue < 0 ? `${-a.daysUntilDue}d overdue` : `due ${a.daysUntilDue}d`;
			const detail = row.createSpan({ cls: 'friday-team-status-detail', text: when });
			if (a.daysUntilDue < 0) detail.addClass('is-overdue');
		}
	}

	private renderDriving(parent: HTMLElement): void {
		const driving = this.rollup.members.filter(m => m.drivingJira.length + m.drivingTopics.length > 0);
		const sec = this.section(parent, 'Currently driving');
		if (driving.length === 0) {
			sec.createDiv({ cls: 'friday-empty', text: 'Nothing in progress.' });
			return;
		}
		for (const m of driving) {
			const row = sec.createDiv({ cls: 'friday-team-status-row' });
			row.createSpan({ cls: 'friday-team-status-owner', text: m.displayName });
			const items = [...m.drivingTopics.map(t => t.title), ...m.drivingJira.map(i => i.key)];
			row.createSpan({ cls: 'friday-team-status-title', text: items.join(', ') });
		}
	}

	private renderCadence(parent: HTMLElement): void {
		if (this.rollup.overdueOneOnOnes.length === 0) return;
		const sec = this.section(parent, `1:1 cadence overdue (${this.rollup.overdueOneOnOnes.length})`);
		for (const o of this.rollup.overdueOneOnOnes) {
			const row = sec.createDiv({ cls: 'friday-team-status-row' });
			row.createSpan({ cls: 'friday-team-status-owner', text: o.name });
			row.createSpan({ cls: 'friday-team-status-detail', text: `${o.daysOverdue}d overdue` });
		}
	}

	/** Clicking a row opens its JIRA issue (url) or its topic file (vault path). */
	private wireRef(el: HTMLElement, ref: string, url: string | null): void {
		el.addClass('friday-clickable');
		el.addEventListener('click', () => {
			if (url) { window.open(url, '_blank'); return; }
			const file = this.app.vault.getAbstractFileByPath(ref);
			if (file instanceof TFile) {
				const leaf = this.app.workspace.getLeaf(false);
				void leaf.openFile(file);
				this.app.workspace.revealLeaf(leaf);
			}
		});
	}
}
