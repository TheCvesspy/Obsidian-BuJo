import {
	SprintTopic,
	TopicStatus,
	TopicImpact,
	TopicEffort,
	Priority,
	PluginSettings,
} from '../../types';
import { SprintTopicService } from '../../services/sprintTopicService';
import { JiraService } from '../../services/jiraService';
import { createTopicFromJiraInfo, syncTopicDependenciesFromJira } from '../../services/topicFromJira';
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
	sprintTopicService: SprintTopicService;
	jiraService: JiraService;
	getSettings: () => PluginSettings;
}

const TOPIC_STATUS = ['backlog', 'open', 'in-progress', 'done'] as const;
const TOPIC_IMPACT = ['critical', 'high', 'medium', 'low'] as const;
const TOPIC_EFFORT = ['xs', 's', 'm', 'l', 'xl'] as const;
const TOPIC_PRIORITY = ['high', 'medium', 'low', 'none'] as const;

/** Build all topic-related MCP tools (the Kanban board). */
export function topicTools(deps: TopicsDeps): McpTool[] {
	return [
		topicsListTool(deps),
		topicGetTool(deps),
		topicCreateTool(deps),
		topicCreateFromJiraTool(deps),
		topicSyncDependenciesTool(deps),
		topicUpdateTool(deps),
		topicLinkTool(deps),
	];
}

// ─── topics_list ───────────────────────────────────────────────────────────

function topicsListTool(deps: TopicsDeps): McpTool {
	return {
		name: 'topics_list',
		description:
			'List Kanban topics. Optional `status` filters to a single column ' +
			'(backlog, open = "To Do", in-progress, done). Optional `blocked` filters to blocked topics only.',
		inputSchema: {
			type: 'object',
			properties: {
				status: { type: 'string', enum: [...TOPIC_STATUS] },
				blocked: { type: 'boolean' },
			},
			additionalProperties: false,
		},
		handler: async (args): Promise<McpToolResult> => {
			try {
				const status = optionalEnum(args, 'status', TOPIC_STATUS);
				const blocked = optionalBoolean(args, 'blocked');

				let filtered = await deps.sprintTopicService.getAllTopics();
				if (status) filtered = filtered.filter(t => t.status === status);
				if (blocked !== undefined) filtered = filtered.filter(t => t.blocked === blocked);

				return jsonResult({
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
			'Create a new Kanban topic file. The topic lands in the Backlog column. ' +
			'`jira` accepts one key (PROJ-123) or a comma-separated list (PROJ-1, PROJ-2). ' +
			'`linkedPages` are wiki-link basenames written into the ## Linked Pages section.',
		inputSchema: {
			type: 'object',
			properties: {
				title: { type: 'string' },
				jira: { type: 'string', description: 'Single key or comma-separated list.' },
				priority: { type: 'string', enum: [...TOPIC_PRIORITY] },
				impact: { type: 'string', enum: [...TOPIC_IMPACT] },
				effort: { type: 'string', enum: [...TOPIC_EFFORT] },
				dueDate: { type: 'string', description: 'ISO YYYY-MM-DD. Doubles as the roadmap bar end.' },
				startDate: { type: 'string', description: 'Planned roadmap start, ISO YYYY-MM-DD.' },
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
				const jira = optionalString(args, 'jira') ?? null;
				const priorityName = optionalEnum(args, 'priority', TOPIC_PRIORITY) ?? 'none';
				const impact = optionalEnum(args, 'impact', TOPIC_IMPACT) ?? null;
				const effort = optionalEnum(args, 'effort', TOPIC_EFFORT) ?? null;
				const dueDate = optionalIsoDate(args, 'dueDate') ?? null;
				const startDate = optionalIsoDate(args, 'startDate') ?? null;
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
					impact,
					effort,
					dueDate,
					assignee,
					waitingOn,
					null,
					[],
					startDate,
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

// ─── topic_create_from_jira ──────────────────────────────────────────────────

function topicCreateFromJiraTool(deps: TopicsDeps): McpTool {
	return {
		name: 'topic_create_from_jira',
		description:
			'Create a Kanban topic from a JIRA issue key. Fetches the issue and fills the topic: title ' +
			'from the summary, links the key, maps the priority, copies the due date, seeds a roadmap start ' +
			'date, resolves the assignee to a team member, and drops the description into the Notes section. ' +
			'If a topic already links the key, returns that topic (alreadyLinked: true) instead of creating a ' +
			'duplicate. Does not wire blocked-by links — use topic dependency tools or the in-app sync for that. ' +
			'Requires the JIRA module to be enabled.',
		inputSchema: {
			type: 'object',
			properties: { key: { type: 'string', description: 'JIRA issue key, e.g. PROJ-123.' } },
			required: ['key'],
			additionalProperties: false,
		},
		handler: async (args): Promise<McpToolResult> => {
			try {
				const rawKey = requireString(args, 'key');
				if (!deps.jiraService.isEnabled()) {
					return errorResult('JIRA module is disabled. Enable it in Friday settings to create topics from issues.');
				}
				const key = deps.jiraService.extractIssueKey(rawKey.toUpperCase());
				if (!key) return errorResult(`"${rawKey}" is not a valid JIRA issue key (expected e.g. PROJ-123).`);

				const all = await deps.sprintTopicService.getAllTopics();
				const existing = all.find(t => t.jira.includes(key));
				if (existing) {
					return jsonResult({ ok: true, alreadyLinked: true, topic: toTopicDto(existing) });
				}

				const info = await deps.jiraService.fetchIssue(key);
				if (!info) {
					const err = deps.jiraService.getError(key);
					return errorResult(err ? `Couldn't fetch ${key}: ${err}` : `Couldn't fetch ${key}.`);
				}

				const todayIso = new Date().toISOString().slice(0, 10);
				const topic = await createTopicFromJiraInfo(
					deps.sprintTopicService,
					info,
					{ teamMembers: deps.getSettings().teamMembers ?? [], todayIso },
				);
				return jsonResult({ ok: true, created: true, topic: toTopicDto(topic) });
			} catch (err) {
				if (err instanceof ToolError) return errorResult(err.message);
				if (err instanceof Error) return errorResult(err.message);
				throw err;
			}
		},
	};
}

// ─── topic_sync_dependencies ─────────────────────────────────────────────────

function topicSyncDependenciesTool(deps: TopicsDeps): McpTool {
	return {
		name: 'topic_sync_dependencies',
		description:
			'Wire topic blocked-by dependencies from JIRA across the whole board. For every topic linked ' +
			'to a JIRA issue, reads that issue\'s "is blocked by" links and adds a topic dependency wherever ' +
			'the blocking issue is also linked to a topic (self/cycles/duplicates skipped). Idempotent. ' +
			'Returns counts (scanned, added, rejected). Requires the JIRA module to be enabled.',
		inputSchema: {
			type: 'object',
			properties: {},
			additionalProperties: false,
		},
		handler: async (): Promise<McpToolResult> => {
			try {
				if (!deps.jiraService.isEnabled()) {
					return errorResult('JIRA module is disabled. Enable it in Friday settings to sync dependencies.');
				}
				const all = await deps.sprintTopicService.getAllTopics();
				const result = await syncTopicDependenciesFromJira(deps.sprintTopicService, deps.jiraService, all);
				return jsonResult({ ok: true, ...result });
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
			'dueDate / startDate / assignee / waitingOn to clear them. Status / blocked / priority require a value. ' +
			'Setting status stamps the Kanban flow timestamps automatically.',
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
				startDate: {
					anyOf: [{ type: 'string', description: 'Planned roadmap start, ISO YYYY-MM-DD' }, { type: 'null' }],
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
				if ('startDate' in args) {
					const raw = args.startDate;
					if (raw === null) {
						await deps.sprintTopicService.setTopicStartDate(path, null);
						changes.push('startDate=null');
					} else {
						const v = optionalIsoDate(args, 'startDate');
						if (v) {
							await deps.sprintTopicService.setTopicStartDate(path, v);
							changes.push(`startDate=${v}`);
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
					return errorResult('No update fields provided. Pass one or more of: status, blocked, priority, impact, effort, dueDate, startDate, assignee, waitingOn.');
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

// ─── topic_link ──────────────────────────────────────────────────────────────

function topicLinkTool(deps: TopicsDeps): McpTool {
	return {
		name: 'topic_link',
		description:
			'Add or remove a topic dependency: mark `path` as blocked-by `blockerPath`. ' +
			'`action` is "add" or "remove". Adding rejects self-links and cycles.',
		inputSchema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Topic file path (the blocked topic).' },
				blockerPath: { type: 'string', description: 'Topic file path (the blocking topic).' },
				action: { type: 'string', enum: ['add', 'remove'] },
			},
			required: ['path', 'blockerPath', 'action'],
			additionalProperties: false,
		},
		handler: async (args): Promise<McpToolResult> => {
			try {
				const path = requireString(args, 'path');
				const blockerPath = requireString(args, 'blockerPath');
				const action = optionalEnum(args, 'action', ['add', 'remove'] as const) ?? 'add';
				if (action === 'remove') {
					await deps.sprintTopicService.removeDependency(path, blockerPath);
					return jsonResult({ ok: true, path, blockerPath, action });
				}
				const res = await deps.sprintTopicService.addDependency(path, blockerPath);
				if (!res.ok) return errorResult(res.reason ?? 'Could not add dependency.');
				return jsonResult({ ok: true, path, blockerPath, action });
			} catch (err) {
				if (err instanceof ToolError) return errorResult(err.message);
				if (err instanceof Error) return errorResult(err.message);
				throw err;
			}
		},
	};
}

// ─── helpers ────────────────────────────────────────────────────────────────

function toTopicDto(t: SprintTopic): Record<string, unknown> {
	return {
		path: t.filePath,
		title: t.title,
		status: t.status,
		priority: t.priority,
		blocked: t.blocked,
		sortOrder: t.sortOrder,
		impact: t.impact,
		effort: t.effort,
		dueDate: t.dueDate,
		startDate: t.startDate,
		jira: t.jira,
		linkedPages: t.linkedPages,
		taskTotal: t.taskTotal,
		taskDone: t.taskDone,
		statusSince: t.statusSince,
		startedAt: t.startedAt,
		doneAt: t.doneAt,
		assignee: t.assignee,
		waitingOn: t.waitingOn,
		lastNudged: t.lastNudged,
		refs: t.refs,
		blockedBy: t.blockedBy,
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
