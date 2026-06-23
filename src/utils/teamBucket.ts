import { JiraDashboardIssue, TeamMember } from '../types';

/**
 * Bucket JIRA issues by team member. Matches assignee email first (most reliable), then
 * falls back to display-name. Issues matching no member are dropped. Returns a map keyed
 * by member email (every member gets an entry, possibly empty).
 */
export function bucketIssuesByMember(
	issues: JiraDashboardIssue[],
	members: TeamMember[],
): Map<string, JiraDashboardIssue[]> {
	const byEmail = new Map<string, TeamMember>();
	const byName = new Map<string, TeamMember>();
	for (const m of members) {
		if (m.email) byEmail.set(m.email.toLowerCase(), m);
		if (m.fullName) byName.set(m.fullName.toLowerCase().trim(), m);
	}

	const out = new Map<string, JiraDashboardIssue[]>();
	for (const m of members) out.set(m.email, []);

	for (const issue of issues) {
		let member: TeamMember | undefined;
		if (issue.assigneeEmail) member = byEmail.get(issue.assigneeEmail.toLowerCase());
		if (!member && issue.assignee) member = byName.get(issue.assignee.toLowerCase().trim());
		if (member) out.get(member.email)!.push(issue);
	}
	return out;
}
