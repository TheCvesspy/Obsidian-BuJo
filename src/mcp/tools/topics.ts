import {
	SprintTopic,
	TopicStatus,
	TopicImpact,
	TopicEffort,
	Priority,
	Sprint,
} from '../../types';
import { SprintService } from '../../services/sprintService';
import { SprintTopicService } from '../../services/sprintTopicService';
import {
	McpTool,
	McpToolResult,
	jsonResult,
	errorResult,
	ToolError,
	requireString,
	optionalString,
	optionalEnum,
	optionalBoolean,
} from '../tool';

interface TopicsDeps {
	sprintService: SprintService;
	sprintTopicService: SprintTopicService;
}

const TOPIC_STATUS = ['open', 'in-progress', 'done'] as const;
const TOPIC_IMPACT = ['critical', 'high', 'medium', 'low'] as const;
const TOPIC_EFFORT = ['xs', 's', 'm', 'l', 'xl'] as const;
const TOPIC_PRIORITY = ['high', 'medium', 'low', 'none'] as const;

/** Build all sprint/topic-related MCP tools. */
export function topicTools(deps: TopicsDeps): McpTool[] {
	return [
		sprintsListTool(deps),
		sprintCreateTool(deps),
		sprintCompleteTool(deps),
		topicsListTool(deps),
		topicGetTool(deps),
		topicCreateTool(deps),
		topicUpdateTool(deps),
		topicAssignTool(deps),
	];
}

// ─── sprints_list ──────────────────────────────────────────────────────────

function sprintsListTool(deps: TopicsDeps): McpTool {
	return {
		name: 'sprints_list',
		description:
			'Return every sprint defined in the plugin data (active, planned, completed). ' +
			'Use this to discover sprint IDs before calling topic_assign_to_sprint or topic_create. ' +
			'`activeSprintId` is also returned for convenience.',
		inputSchema: { type: 'object', properties: {}, additionalProperties: false },
		handler: async (): Promise<McpToolResult> => {
			const sprints = deps.sprintService.getSprints();
			const active = deps.sprintService.getActiveSprint();
			return jsonResult({
				activeSprintId: active?.id ?? null,
				sprints: sprints.map(toSprintDto),
			});
		},
	};
}

// ─── sprint_create ─────────────────────────────────────────────────────────

function sprintCreateTool(deps: TopicsDeps): McpTool {
	return {
		name: 'sprint_create',
		description:
			'Create a new sprint. `startDate` and `endDate` are ISO YYYY-MM-DD. If omitted, ' +
			'the plugin defaults are used (start = tomorrow, end = start + defaultSprintLength, ' +
			'respecting work-days-only if configured).',
		inputSchema: {
			type: 'object',
			properties: {
				name: { type: 'string', description: 'Display name for the sprint.' },
				startDate: { type: 'string', description: 'ISO YYYY-MM-DD. Optional.' },
				endDate: { type: 'string', description: 'ISO YYYY-MM-DD. Optional.' },
			},
			required: ['name'],
			additionalProperties: false,
		},
		handler: async (args): Promise<McpToolResult> => {
			try {
				const name = requireString(args, 'name');
				const startDate = optionalIsoDate(args, 'startDate');
				const endDate = optionalIsoDate(args, 'endDate');
				const created = await deps.sprintService.createSprint(name, startDate, endDate);
				return jsonResult({ ok: true, sprint: toSprintDto(created) });
			} catch (err) {
				if (err instanceof ToolError) return errorResult(err.message);
				throw err;
			}
		},
	};
}

// ─── sprint_complete ───────────────────────────────────────────────────────

function sprintCompleteTool(deps: TopicsDeps): McpTool {
	return {
		name: 'sprint_complete',
		description:
			'Mark a sprint as completed. If the "auto-start next sprint" setting is on, a new ' +
			'sprint is opened immediately and returned in `next`. Topic carry-forward is NOT ' +
			'automatic — use topic_assign_to_sprint per topic to move work onto the new sprint.',
		inputSchema: {
			type: 'object',
			properties: { sprintId: { type: 'string' } },
			required: ['sprintId'],
			additionalProperties: false,
		},
		handler: async (args): Promise<McpToolResult> => {
			try {
				const sprintId = requireString(args, 'sprintId');
				const next = await deps.sprintService.completeSprint(sprintId);
				return jsonResult({
					ok: true,
					completedSprintId: sprintId,
					next: next ? toSprintDto(next) : null,
				});
			} catch (err) {
				if (err instanceof ToolError) return errorResult(err.message);
				if (err instanceof Error) return errorResult(err.message);
				throw err;
			}
		},
	};
}

// ─── topics_list ───────────────────────────────────────────────────────────

function topicsListTool(deps: TopicsDeps): McpTool {
	return {
		name: 'topics_list',
		description:
			'List sprint topics. `scope` can be a specific sprintId, "active" (the currently ' +
			'active sprint), "backlog" (topics with no sprint assignment), or "all" (default). ' +
			'Optional `status` and `blocked` further filter the result.',
		inputSchema: {
			type: 'object',
			properties: {
				scope: {
					type: 'string',
					description: 'sprintId, "active", "backlog", or "all". Default "all".',
				},
				status: { type: 'string', enum: [...TOPIC_STATUS] },
				blocked: { type: 'boolean' },
			},
			additionalProperties: false,
		},
		handler: async (args): Promise<McpToolResult> => {
			try {
				const scope = optionalString(args, 'scope') ?? 'all';
				const status = optionalEnum(args, 'status', TOPIC_STATUS);
				const blocked = optionalBoolean(args, 'blocked');

				const all = await deps.sprintTopicService.getAllTopics();

				let filtered = all;
				if (scope === 'backlog') {
					filtered = all.filter(t => !t.sprintId);
				} else if (scope === 'active') {
					const active = deps.sprintService.getActiveSprint();
					if (!active) {
						return jsonResult({ scope, activeSprintId: null, total: 0, topics: [] });
					}
					filtered = all.filter(t => t.sprintId === active.id);
				} else if (scope !== 'all') {
					filtered = all.filter(t => t.sprintId === scope);
				}

				if (status) filtered = filtered.filter(t => t.status === status);
				if (blocked !== undefined) filtered = filtered.filter(t => t.blocked === blocked);

				return jsonResult({
					scope,
					total: filtered.length,
					topics: filtered.map(toTopicDto),
				});
			} catch (err) {
				if (err instanceof ToolError) return errorResult(err.message);
				throw err;
			}
		},
	};
}

// ─── topic_get ─────────────────────────────────────────────────────────────

function topicGetTool(deps: TopicsDeps): McpTool {
	return {
		name: 'topic_get',
		description: 'Fetch a single topic by file path (the natural key for topics).',
		inputSchema: {
			type: 'object',
			properties: { path: { type: 'string' } },
			required: ['path'],
			additionalProperties: false,
		},
		handler: async (args): Promise<McpToolResult> => {
			try {
				const path = requireString(args, 'path');
				const all = await deps.sprintTopicService.getAllTopics();
				const topic = all.find(t => t.filePath === path);
				if (!topic) return errorResult(`Topic not found at "${path}".`);
				return jsonResult(toTopicDto(topic));
			} catch (err) {
				if (err instanceof ToolError) return errorResult(err.message);
				throw err;
			}
		},
	};
}

// ─── topic_create ──────────────────────────────────────────────────────────

function topicCreateTool(deps: TopicsDeps): McpTool {
	return {
		name: 'topic_create',
		description:
			'Create a new sprint topic file. By default the topic is placed on the currently ' +
			'active sprint; pass `sprintId="backlog"` for a backlog topic, or an explicit ID. ' +
			'`jira` accepts one key (PROJ-123) or a comma-separated list (PROJ-1, PROJ-2). ' +
			'`linkedPages` are wiki-link basenames written into the ## Linked Pages section.',
		inputSchema: {
			type: 'object',
			properties: {
				title: { type: 'string' },
				sprintId: {
					type: 'string',
					description: 'Sprint ID, "active" (default), or "backlog".',
				},
				jira: { type: 'string', description: 'Single key or comma-separated list.' },
				priority: { type: 'string', enum: [...TOPIC_PRIORITY] },
				impact: { type: 'string', enum: [...TOPIC_IMPACT] },
				effort: { type: 'string', enum: [...TOPIC_EFFORT] },
				dueDate: { type: 'string', description: 'ISO YYYY-MM-DD.' },
				assignee: { type: 'string', description: 'Team member email.' },
				waitingOn: { type: 'string', description: 'Email or free text.' },
				linkedPages: {
					type: 'array',
					items: { type: 'string' },
					description: 'Wiki-link basenames (e.g. ["Project X"]).',
				},
			},
			required: ['title'],
			additionalProperties: false,
		},
		handler: async (args): Promise<McpToolResult> => {
			try {
				const title = requireString(args, 'title');
				const sprintArg = optionalString(args, 'sprintId') ?? 'active';
				const sprintId = resolveSprintId(deps, sprintArg);

				const jira = optionalString(args, 'jira') ?? null;
				const priorityName = optionalEnum(args, 'priority', TOPIC_PRIORITY) ?? 'none';
				const impact = optionalEnum(args, 'impact', TOPIC_IMPACT) ?? null;
				const effort = optionalEnum(args, 'effort', TOPIC_EFFORT) ?? null;
				const dueDate = optionalIsoDate(args, 'dueDate') ?? null;
				const assignee = optionalString(args, 'assignee') ?? null;
				const waitingOn = optionalString(args, 'waitingOn') ?? null;

				const linkedPagesRaw = args.linkedPages;
				const linkedPages: string[] = [];
				if (Array.isArray(linkedPagesRaw)) {
					for (const entry of linkedPagesRaw) {
						if (typeof entry !== 'string') {
							return errorResult('"linkedPages" must be an array of strings.');
						}
						const trimmed = entry.trim();
						if (trimmed) linkedPages.push(trimmed);
					}
				} else if (linkedPagesRaw !== undefined && linkedPagesRaw !== null) {
					return errorResult('"linkedPages" must be an array of strings.');
				}

				const topic = await deps.sprintTopicService.createTopic(
					title,
					jira,
					priorityToEnum(priorityName),
					linkedPages,
					sprintId,
					impact,
					effort,
					dueDate,
					assignee,
					waitingOn,
					null,
				);
				return jsonResult({ ok: true, topic: toTopicDto(topic) });
			} catch (err) {
				if (err instanceof ToolError) return errorResult(err.message);
				if (err instanceof Error) return errorResult(err.message);
				throw err;
			}
		},
	};
}

// ─── topic_update ──────────────────────────────────────────────────────────

function topicUpdateTool(deps: TopicsDeps): McpTool {
	return {
		name: 'topic_update',
		description:
			'Update one or more frontmatter fields on a topic in place. Only the fields you pass ' +
			'are touched; omitting a field leaves it unchanged. Pass `null` for impact / effort / ' +
			'dueDate / assignee / waitingOn to clear them. Status / blocked / priority require a value.',
		inputSchema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Topic file path.' },
				status: { type: 'string', enum: [...TOPIC_STATUS] },
				blocked: { type: 'boolean' },
				priority: { type: 'string', enum: [...TOPIC_PRIORITY] },
				impact: {
					anyOf: [{ type: 'string', enum: [...TOPIC_IMPACT] }, { type: 'null' }],
				},
				effort: {
					anyOf: [{ type: 'string', enum: [...TOPIC_EFFORT] }, { type: 'null' }],
				},
				dueDate: {
					anyOf: [{ type: 'string', description: 'ISO YYYY-MM-DD' }, { type: 'null' }],
				},
				assignee: { anyOf: [{ type: 'string' }, { type: 'null' }] },
				waitingOn: { anyOf: [{ type: 'string' }, { type: 'null' }] },
			},
			required: ['path'],
			additionalProperties: false,
		},
		handler: async (args): Promise<McpToolResult> => {
			try {
				const path = requireString(args, 'path');
				const all = await deps.sprintTopicService.getAllTopics();
				const existing = all.find(t => t.filePath === path);
				if (!existing) return errorResult(`Topic not found at "${path}".`);

				const changes: string[] = [];

				if ('status' in args) {
					const status = optionalEnum(args, 'status', TOPIC_STATUS);
					if (status) {
						await deps.sprintTopicService.setTopicStatus(path, status as TopicStatus);
						changes.push(`status=${status}`);
					}
				}
				if ('blocked' in args) {
					const blocked = optionalBoolean(args, 'blocked');
					if (blocked !== undefined) {
						await deps.sprintTopicService.setTopicBlocked(path, blocked);
						changes.push(`blocked=${blocked}`);
					}
				}
				if ('priority' in args) {
					const priority = optionalEnum(args, 'priority', TOPIC_PRIORITY);
					if (priority) {
						await deps.sprintTopicService.updateTopicFrontmatter(path, {
							priority: priority === 'none' ? 'none' : priority,
						});
						changes.push(`priority=${priority}`);
					}
				}
				if ('impact' in args) {
					const raw = args.impact;
					if (raw === null) {
						await deps.sprintTopicService.setTopicImpact(path, null);
						changes.push('impact=null');
					} else {
						const impact = optionalEnum(args, 'impact', TOPIC_IMPACT);
						if (impact) {
							await deps.sprintTopicService.setTopicImpact(path, impact as TopicImpact);
							changes.push(`impact=${impact}`);
						}
					}
				}
				if ('effort' in args) {
					const raw = args.effort;
					if (raw === null) {
						await deps.sprintTopicService.setTopicEffort(path, null);
						changes.push('effort=null');
					} else {
						const effort = optionalEnum(args, 'effort', TOPIC_EFFORT);
						if (effort) {
							await deps.sprintTopicService.setTopicEffort(path, effort as TopicEffort);
							changes.push(`effort=${effort}`);
						}
					}
				}
				if ('dueDate' in args) {
					const raw = args.dueDate;
					if (raw === null) {
						await deps.sprintTopicService.setTopicDueDate(path, null);
						changes.push('dueDate=null');
					} else {
						const due = optionalIsoDate(args, 'dueDate');
						if (due) {
							await deps.sprintTopicService.setTopicDueDate(path, due);
							changes.push(`dueDate=${due}`);
						}
					}
				}
				if ('assignee' in args) {
					const raw = args.assignee;
					if (raw === null) {
						await deps.sprintTopicService.updateTopicFrontmatter(path, { assignee: null });
						changes.push('assignee=null');
					} else {
						const v = optionalString(args, 'assignee');
						if (v) {
							await deps.sprintTopicService.updateTopicFrontmatter(path, { assignee: v });
							changes.push(`assignee=${v}`);
						}
					}
				}
				if ('waitingOn' in args) {
					const raw = args.waitingOn;
					if (raw === null) {
						await deps.sprintTopicService.updateTopicFrontmatter(path, { waitingOn: null });
						changes.push('waitingOn=null');
					} else {
						const v = optionalString(args, 'waitingOn');
						if (v) {
							await deps.sprintTopicService.updateTopicFrontmatter(path, { waitingOn: v });
							changes.push(`waitingOn=${v}`);
						}
					}
				}

				if (changes.length === 0) {
					return errorResult('No update fields provided. Pass one or more of: status, blocked, priority, impact, effort, dueDate, assignee, waitingOn.');
				}

				const after = await deps.sprintTopicService.getAllTopics();
				const updated = after.find(t => t.filePath === path);
				return jsonResult({
					ok: true,
					path,
					changes,
					topic: updated ? toTopicDto(updated) : null,
				});
			} catch (err) {
				if (err instanceof ToolError) return errorResult(err.message);
				if (err instanceof Error) return errorResult(err.message);
				throw err;
			}
		},
	};
}

// ─── topic_assign_to_sprint ────────────────────────────────────────────────

function topicAssignTool(deps: TopicsDeps): McpTool {
	return {
		name: 'topic_assign_to_sprint',
		description:
			'Move a topic to a different sprint, the active sprint, or the backlog. ' +
			'`sprintId` accepts a real sprint ID, "active" (the currently active sprint), or ' +
			'"backlog" (clear the sprint assignment). Sprint history is appended automatically.',
		inputSchema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Topic file path.' },
				sprintId: { type: 'string' },
			},
			required: ['path', 'sprintId'],
			additionalProperties: false,
		},
		handler: async (args): Promise<McpToolResult> => {
			try {
				const path = requireString(args, 'path');
				const arg = requireString(args, 'sprintId');
				if (arg === 'backlog') {
					await deps.sprintTopicService.moveTopicToBacklog(path);
					return jsonResult({ ok: true, path, sprintId: null });
				}
				const sprintId = resolveSprintId(deps, arg);
				await deps.sprintTopicService.assignTopicToSprint(path, sprintId);
				return jsonResult({ ok: true, path, sprintId: sprintId || null });
			} catch (err) {
				if (err instanceof ToolError) return errorResult(err.message);
				if (err instanceof Error) return errorResult(err.message);
				throw err;
			}
		},
	};
}

// ─── helpers ────────────────────────────────────────────────────────────────

function toSprintDto(s: Sprint): Record<string, unknown> {
	return {
		id: s.id,
		name: s.name,
		startDate: s.startDate,
		endDate: s.endDate,
		status: s.status,
	};
}

function toTopicDto(t: SprintTopic): Record<string, unknown> {
	return {
		path: t.filePath,
		title: t.title,
		status: t.status,
		priority: t.priority,
		blocked: t.blocked,
		sprintId: t.sprintId,
		sortOrder: t.sortOrder,
		impact: t.impact,
		effort: t.effort,
		dueDate: t.dueDate,
		jira: t.jira,
		linkedPages: t.linkedPages,
		taskTotal: t.taskTotal,
		taskDone: t.taskDone,
		sprintHistory: t.sprintHistory,
		assignee: t.assignee,
		waitingOn: t.waitingOn,
		lastNudged: t.lastNudged,
		refs: t.refs,
	};
}

function priorityToEnum(name: string): Priority {
	switch (name) {
		case 'high': return Priority.High;
		case 'medium': return Priority.Medium;
		case 'low': return Priority.Low;
		case 'none':
		default:
			return Priority.None;
	}
}

/** Resolve a "sprintId" argument that may be a real ID, "active", or "backlog". */
function resolveSprintId(deps: TopicsDeps, raw: string): string {
	if (raw === 'backlog') return '';
	if (raw === 'active') {
		const active = deps.sprintService.getActiveSprint();
		if (!active) {
			throw new ToolError('No active sprint. Pass an explicit sprint ID or "backlog".');
		}
		return active.id;
	}
	return raw;
}

/** Parse an optional ISO date input. Returns undefined when missing, the original
 *  string when valid, throws ToolError when present-but-malformed. */
function optionalIsoDate(args: Record<string, unknown>, key: string): string | undefined {
	const v = args[key];
	if (v === undefined || v === null || v === '') return undefined;
	if (typeof v !== 'string') {
		throw new ToolError(`"${key}" must be ISO YYYY-MM-DD.`);
	}
	const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (!m) throw new ToolError(`"${key}" must be ISO YYYY-MM-DD; got "${v}".`);
	const y = parseInt(m[1], 10);
	const mo = parseInt(m[2], 10);
	const d = parseInt(m[3], 10);
	const date = new Date(y, mo - 1, d);
	if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) {
		throw new ToolError(`"${key}" is not a real calendar date: "${v}".`);
	}
	return v;
}
