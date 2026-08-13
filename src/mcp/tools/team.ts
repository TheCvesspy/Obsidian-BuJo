import { TeamMemberPage, TeamMemberStatus, OneOnOneCadence } from '../../types';
import { TeamMemberService, MemberFrontmatterUpdate } from '../../services/teamMemberService';
import { VaultScanner } from '../../services/vaultScanner';
import { formatDateISO } from '../../utils/dateUtils';
import {
	McpTool,
	McpToolResult,
	jsonResult,
	ToolError,
	requireString,
	optionalString,
	optionalEnum,
	optionalBoolean,
} from '../tool';

interface TeamDeps {
	teamMemberService: TeamMemberService;
	/** Used to refresh the scanner's cache after a write so reads are immediately consistent. */
	scanner: VaultScanner;
}

const MEMBER_STATUS = ['active', 'on_leave', 'departed'] as const;
const CADENCE = ['weekly', 'biweekly', 'monthly', 'skip'] as const;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/** Build all team-management MCP tools (person pages + 1:1 cadence). */
export function teamTools(deps: TeamDeps): McpTool[] {
	return [
		teamMembersListTool(deps),
		teamMemberGetTool(deps),
		oneOnOnesDueTool(deps),
		oneOnOneLogTool(deps),
		teamMemberCreateTool(deps),
		teamMemberUpdateTool(deps),
	];
}

/** Flatten a person page (plus its computed cadence signal) into a plain result object. */
function serializeMember(svc: TeamMemberService, m: TeamMemberPage): Record<string, unknown> {
	const signal = svc.computeCadenceSignal(m);
	return {
		name: m.name,
		status: m.status,
		role: m.role,
		email: m.email,
		jiraIdentity: m.jiraIdentity,
		cadence: m.cadence,
		startDate: m.startDate ? formatDateISO(m.startDate) : null,
		lastOneOnOne: m.lastOneOnOne ? formatDateISO(m.lastOneOnOne) : null,
		cadenceState: signal.state,
		daysSinceLast: signal.daysSince,
		currentFocus: m.currentFocus,
		sessionCount: m.sessionPaths.length,
		filePath: m.filePath,
		folderPath: m.folderPath,
	};
}

/** Resolve `member` arg to a page or throw a model-readable error. */
function resolveMember(deps: TeamDeps, query: string): TeamMemberPage {
	const member = deps.teamMemberService.findMember(query);
	if (!member) {
		throw new ToolError(`No team member matches "${query}" (try their name, email, or JIRA identity).`);
	}
	return member;
}

// ─── team_members_list ───────────────────────────────────────────────────────

function teamMembersListTool(deps: TeamDeps): McpTool {
	return {
		name: 'team_members_list',
		description:
			'List team members with their 1:1 cadence status. By default excludes departed members. ' +
			'Optional `status` filters to exactly one of active / on_leave / departed. Set `includeDeparted` ' +
			'to include departed members in the default (unfiltered) view. Each entry includes `cadenceState` ' +
			'(on-track / due-soon / overdue / never / suspended) and `daysSinceLast`.',
		inputSchema: {
			type: 'object',
			properties: {
				status: { type: 'string', enum: [...MEMBER_STATUS] },
				includeDeparted: { type: 'boolean' },
			},
			additionalProperties: false,
		},
		handler: async (args): Promise<McpToolResult> => {
			const status = optionalEnum(args, 'status', MEMBER_STATUS);
			const includeDeparted = optionalBoolean(args, 'includeDeparted') ?? false;

			let members = deps.teamMemberService.getAllMembers();
			if (status) {
				members = members.filter(m => m.status === status);
			} else if (!includeDeparted) {
				members = members.filter(m => m.status !== 'departed');
			}

			const out = members
				.map(m => serializeMember(deps.teamMemberService, m))
				.sort((a, b) => String(a.name).localeCompare(String(b.name)));
			return jsonResult({ count: out.length, members: out });
		},
	};
}

// ─── team_member_get ───────────────────────────────────────────────────────

function teamMemberGetTool(deps: TeamDeps): McpTool {
	return {
		name: 'team_member_get',
		description:
			'Get one team member by name, email, or JIRA identity, including cadence status and 1:1 session paths.',
		inputSchema: {
			type: 'object',
			properties: { member: { type: 'string', description: 'Name, email, or JIRA identity.' } },
			required: ['member'],
			additionalProperties: false,
		},
		handler: async (args): Promise<McpToolResult> => {
			const query = requireString(args, 'member');
			const member = resolveMember(deps, query);
			return jsonResult({
				...serializeMember(deps.teamMemberService, member),
				sessionPaths: member.sessionPaths,
			});
		},
	};
}

// ─── oneonones_due ───────────────────────────────────────────────────────────

function oneOnOnesDueTool(deps: TeamDeps): McpTool {
	return {
		name: 'oneonones_due',
		description:
			'List active team members whose 1:1 is overdue (cadence window elapsed). Set `includeDueSoon` to ' +
			'also include members approaching their cadence boundary. Sorted most-overdue first.',
		inputSchema: {
			type: 'object',
			properties: { includeDueSoon: { type: 'boolean' } },
			additionalProperties: false,
		},
		handler: async (args): Promise<McpToolResult> => {
			const includeDueSoon = optionalBoolean(args, 'includeDueSoon') ?? false;
			const wanted = includeDueSoon ? new Set(['overdue', 'due-soon']) : new Set(['overdue']);

			const rows = deps.teamMemberService
				.getActiveMembers()
				.map(m => ({ m, signal: deps.teamMemberService.computeCadenceSignal(m) }))
				.filter(({ signal }) => wanted.has(signal.state))
				.sort((a, b) => (b.signal.daysSince ?? 0) - (a.signal.daysSince ?? 0))
				.map(({ m, signal }) => ({
					name: m.name,
					cadence: m.cadence,
					cadenceState: signal.state,
					daysSinceLast: signal.daysSince,
					lastOneOnOne: m.lastOneOnOne ? formatDateISO(m.lastOneOnOne) : null,
					filePath: m.filePath,
				}));
			return jsonResult({ count: rows.length, due: rows });
		},
	};
}

// ─── oneonone_log ───────────────────────────────────────────────────────────

function oneOnOneLogTool(deps: TeamDeps): McpTool {
	return {
		name: 'oneonone_log',
		description:
			'Record a held 1:1 for a member by creating a session page at {member}/1on1/YYYY-MM-DD.md. ' +
			'This advances the member\'s cadence clock (lastOneOnOne is derived from session dates). ' +
			'`date` defaults to today; optional `agenda` seeds a Prep section. Idempotent — re-logging the ' +
			'same date returns the existing session.',
		inputSchema: {
			type: 'object',
			properties: {
				member: { type: 'string', description: 'Name, email, or JIRA identity.' },
				date: { type: 'string', description: 'Session date, ISO YYYY-MM-DD. Defaults to today.' },
				agenda: { type: 'string', description: 'Optional prep text seeded into the session page.' },
			},
			required: ['member'],
			additionalProperties: false,
		},
		handler: async (args): Promise<McpToolResult> => {
			const query = requireString(args, 'member');
			const member = resolveMember(deps, query);

			const dateStr = optionalString(args, 'date');
			let date = new Date();
			if (dateStr) {
				if (!ISO_DATE_REGEX.test(dateStr)) {
					throw new ToolError(`Invalid "date" — expected ISO YYYY-MM-DD, got "${dateStr}".`);
				}
				const [y, mo, d] = dateStr.split('-').map(Number);
				date = new Date(y, mo - 1, d);
				if (Number.isNaN(date.getTime())) throw new ToolError(`Invalid calendar date: "${dateStr}".`);
			}
			const agenda = optionalString(args, 'agenda');

			const existingPaths = new Set(member.sessionPaths);
			const file = await deps.teamMemberService.startOneOnOne(member, date, agenda);
			await deps.scanner.fullScan();

			return jsonResult({
				logged: true,
				alreadyExisted: existingPaths.has(file.path),
				sessionPath: file.path,
				sessionDate: formatDateISO(date),
				member: member.name,
			});
		},
	};
}

// ─── team_member_create ───────────────────────────────────────────────────────

function teamMemberCreateTool(deps: TeamDeps): McpTool {
	return {
		name: 'team_member_create',
		description:
			'Create a new team member person page at {teamFolderPath}/{Name}/{Name}.md. Fails if a page ' +
			'with that name already exists. `cadence` defaults to weekly, `status` to active.',
		inputSchema: {
			type: 'object',
			properties: {
				name: { type: 'string', description: 'Full display name (also the folder/file name).' },
				role: { type: 'string' },
				email: { type: 'string' },
				jiraIdentity: { type: 'string', description: 'Defaults to email when omitted.' },
				cadence: { type: 'string', enum: [...CADENCE] },
				status: { type: 'string', enum: [...MEMBER_STATUS] },
				startDate: { type: 'string', description: 'ISO YYYY-MM-DD.' },
			},
			required: ['name'],
			additionalProperties: false,
		},
		handler: async (args): Promise<McpToolResult> => {
			const name = requireString(args, 'name');
			const startDate = optionalString(args, 'startDate');
			if (startDate && !ISO_DATE_REGEX.test(startDate)) {
				throw new ToolError(`Invalid "startDate" — expected ISO YYYY-MM-DD, got "${startDate}".`);
			}

			const created = await deps.teamMemberService.createMemberPage({
				name,
				role: optionalString(args, 'role') ?? null,
				email: optionalString(args, 'email') ?? null,
				jiraIdentity: optionalString(args, 'jiraIdentity') ?? null,
				cadence: optionalEnum(args, 'cadence', CADENCE) as OneOnOneCadence | undefined,
				status: optionalEnum(args, 'status', MEMBER_STATUS) as TeamMemberStatus | undefined,
				startDate: startDate ?? null,
			});
			await deps.scanner.fullScan();

			return jsonResult({ created: true, member: serializeMember(deps.teamMemberService, created) });
		},
	};
}

// ─── team_member_update ───────────────────────────────────────────────────────

function teamMemberUpdateTool(deps: TeamDeps): McpTool {
	return {
		name: 'team_member_update',
		description:
			'Update a team member (located by name/email/JIRA identity). Sets role, email, jiraIdentity, ' +
			'startDate, cadence, or status. For role/email/jiraIdentity/startDate, pass an empty string to ' +
			'clear the field. Does not rename the page. Common uses: change cadence, mark on_leave / departed.',
		inputSchema: {
			type: 'object',
			properties: {
				member: { type: 'string', description: 'Name, email, or JIRA identity of the member to update.' },
				role: { type: 'string' },
				email: { type: 'string' },
				jiraIdentity: { type: 'string' },
				startDate: { type: 'string', description: 'ISO YYYY-MM-DD, or empty string to clear.' },
				cadence: { type: 'string', enum: [...CADENCE] },
				status: { type: 'string', enum: [...MEMBER_STATUS] },
			},
			required: ['member'],
			additionalProperties: false,
		},
		handler: async (args): Promise<McpToolResult> => {
			const query = requireString(args, 'member');
			const member = resolveMember(deps, query);

			const updates: MemberFrontmatterUpdate = {};
			// Only include keys the caller actually passed, so we don't clobber existing values.
			if ('role' in args) updates.role = optionalString(args, 'role') ?? null;
			if ('email' in args) updates.email = optionalString(args, 'email') ?? null;
			if ('jiraIdentity' in args) updates.jiraIdentity = optionalString(args, 'jiraIdentity') ?? null;
			if ('startDate' in args) {
				const sd = optionalString(args, 'startDate');
				if (sd && !ISO_DATE_REGEX.test(sd)) {
					throw new ToolError(`Invalid "startDate" — expected ISO YYYY-MM-DD, got "${sd}".`);
				}
				updates.startDate = sd ?? null;
			}
			const cadence = optionalEnum(args, 'cadence', CADENCE);
			if (cadence) updates.cadence = cadence;
			const status = optionalEnum(args, 'status', MEMBER_STATUS);
			if (status) updates.status = status;

			if (Object.keys(updates).length === 0) {
				throw new ToolError('Nothing to update — pass at least one of: role, email, jiraIdentity, startDate, cadence, status.');
			}

			await deps.teamMemberService.updateMemberFrontmatter(member.filePath, updates);
			await deps.scanner.fullScan();

			const refreshed = deps.teamMemberService.getMember(member.folderPath) ?? member;
			return jsonResult({ updated: true, member: serializeMember(deps.teamMemberService, refreshed) });
		},
	};
}
