import { Vault, TFile, TFolder } from 'obsidian';
import { PluginSettings, TeamRollup } from '../types';
import { TeamRollupService } from './teamRollupService';
import { JiraTeamService } from './jiraTeamService';
import { formatDateISO, formatDateDisplay } from '../utils/dateUtils';

/** Generates a pasteable team-status markdown note under {teamFolderPath}/Status/. */
export class TeamDigestService {
	constructor(
		private vault: Vault,
		private getSettings: () => PluginSettings,
		private rollupService: TeamRollupService,
		private teamJiraService: JiraTeamService,
	) {}

	getDigestPath(date: Date): string {
		return `${this.getSettings().teamFolderPath}/Status/${formatDateISO(date)}.md`;
	}

	/** Refresh team JIRA if stale, build the roll-up, write the digest (overwrite if exists). */
	async generateDigest(date: Date = new Date()): Promise<TFile> {
		if (this.teamJiraService.isEnabled() && this.teamJiraService.isStale()) {
			try { await this.teamJiraService.refresh(); } catch { /* tolerate — digest falls back to topics */ }
		}
		const rollup = this.rollupService.buildRollup(date);
		const md = this.buildMarkdown(rollup, date);
		const path = this.getDigestPath(date);

		const folder = path.substring(0, path.lastIndexOf('/'));
		if (folder && !(this.vault.getAbstractFileByPath(folder) instanceof TFolder)) {
			try { await this.vault.createFolder(folder); } catch { /* already exists */ }
		}

		const existing = this.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await this.vault.modify(existing, md);
			return existing;
		}
		return await this.vault.create(path, md);
	}

	/** Pure: render a roll-up to markdown. Reused by the "Copy digest" button. */
	buildMarkdown(r: TeamRollup, date: Date): string {
		const lines: string[] = [];
		lines.push('---');
		lines.push('type: team-status');
		lines.push(`generated: ${formatDateISO(date)}`);
		lines.push(`jira_included: ${r.jiraIncluded}`);
		lines.push('---');
		lines.push('');
		lines.push(`# Team status — ${formatDateDisplay(date)}`);
		lines.push('');
		if (!r.jiraIncluded) {
			lines.push('> JIRA not included (module off or unavailable) — figures are topic-only.');
			lines.push('');
		}

		lines.push('## Top blockers');
		if (r.topBlockers.length === 0) lines.push('- _None_');
		else for (const b of r.topBlockers) {
			const owner = b.ownerName ? ` (${b.ownerName})` : '';
			const ref = b.url ? `[${b.ref}](${b.url})` : b.ref;
			lines.push(`- **${b.title}**${owner} — ${b.detail ?? ''} · ${ref}`);
		}
		lines.push('');

		lines.push('## At risk (due soon / overdue)');
		if (r.atRisk.length === 0) lines.push('- _None_');
		else for (const a of r.atRisk) {
			const owner = a.ownerName ? ` (${a.ownerName})` : '';
			const ref = a.url ? `[${a.ref}](${a.url})` : a.ref;
			const when = a.daysUntilDue < 0 ? `${-a.daysUntilDue}d overdue` : `due in ${a.daysUntilDue}d`;
			lines.push(`- **${a.title}**${owner} — ${when} (${a.dueDate}) · ${ref}`);
		}
		lines.push('');

		lines.push('## Currently driving');
		const driving = r.members.filter(m => m.drivingJira.length + m.drivingTopics.length > 0);
		if (driving.length === 0) lines.push('- _Nothing in progress_');
		else for (const m of driving) {
			const items = [...m.drivingTopics.map(t => t.title), ...m.drivingJira.map(i => i.key)];
			lines.push(`- **${m.displayName}**: ${items.join(', ')}`);
		}
		lines.push('');

		lines.push('## 1:1 cadence');
		if (r.overdueOneOnOnes.length === 0) lines.push('- _All on track_');
		else for (const o of r.overdueOneOnOnes) lines.push(`- **${o.name}** — ${o.daysOverdue}d overdue`);
		lines.push('');

		lines.push('## Workload');
		lines.push('| Member | Committed | Capacity | Band |');
		lines.push('| --- | --- | --- | --- |');
		for (const m of r.members) {
			lines.push(`| ${m.displayName} | ${m.load.committed} | ${m.load.target.toFixed(0)} | ${m.load.band} |`);
		}
		lines.push('');

		return lines.join('\n');
	}
}
