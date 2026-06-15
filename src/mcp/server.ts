import * as http from 'http';
import { randomBytes } from 'crypto';
import { Notice } from 'obsidian';
import { PluginSettings } from '../types';
import { McpTool, McpToolResult } from './tool';

/** MCP protocol version this server speaks. */
const MCP_PROTOCOL_VERSION = '2025-06-18';

/** JSON-RPC 2.0 error codes used by the MCP protocol. */
const JSONRPC_PARSE_ERROR = -32700;
const JSONRPC_INVALID_REQUEST = -32600;
const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INVALID_PARAMS = -32602;
const JSONRPC_INTERNAL_ERROR = -32603;

interface JsonRpcRequest {
	jsonrpc: '2.0';
	id?: number | string | null;
	method: string;
	params?: any;
}

interface JsonRpcResponse {
	jsonrpc: '2.0';
	id: number | string | null;
	result?: any;
	error?: { code: number; message: string; data?: any };
}

export interface McpServerStatus {
	state: 'stopped' | 'running' | 'error';
	host?: string;
	port?: number;
	url?: string;
	message?: string;
}

/**
 * Embedded HTTP server that speaks the MCP (Model Context Protocol) JSON-RPC
 * wire format. Implements just the subset the plugin needs: `initialize`,
 * `tools/list`, `tools/call`, and `notifications/*` (acknowledged + ignored).
 *
 * Each POST /mcp request is a self-contained JSON-RPC envelope — no session
 * management, no SSE streaming. That's enough for Claude Desktop / Claude Code
 * tool calls and avoids the SDK dep.
 */
export class McpServer {
	private server: http.Server | null = null;
	private tools: Map<string, McpTool> = new Map();
	private status: McpServerStatus = { state: 'stopped' };
	private listeners: Array<(status: McpServerStatus) => void> = [];

	registerTool(tool: McpTool): void {
		this.tools.set(tool.name, tool);
	}

	/** Replace the entire tool set (called once at startup from the orchestrator). */
	setTools(tools: McpTool[]): void {
		this.tools.clear();
		for (const t of tools) this.tools.set(t.name, t);
	}

	getStatus(): McpServerStatus {
		return this.status;
	}

	onStatusChange(cb: (status: McpServerStatus) => void): void {
		this.listeners.push(cb);
	}

	offStatusChange(cb: (status: McpServerStatus) => void): void {
		this.listeners = this.listeners.filter(l => l !== cb);
	}

	private setStatus(next: McpServerStatus): void {
		this.status = next;
		for (const l of this.listeners) l(next);
	}

	async start(settings: Pick<PluginSettings, 'mcpHost' | 'mcpPort' | 'mcpToken'>): Promise<void> {
		await this.stop();

		const token = settings.mcpToken;
		const host = settings.mcpHost || '127.0.0.1';
		const port = settings.mcpPort || 27225;

		const server = http.createServer((req, res) => this.handleRequest(req, res, token));

		await new Promise<void>((resolve, reject) => {
			const onError = (err: Error & { code?: string }) => {
				server.removeListener('listening', onListening);
				const message = err.code === 'EADDRINUSE'
					? `Port ${port} is already in use. Pick another port in settings.`
					: `Failed to start MCP server: ${err.message}`;
				this.setStatus({ state: 'error', host, port, message });
				reject(err);
			};
			const onListening = () => {
				server.removeListener('error', onError);
				resolve();
			};
			server.once('error', onError);
			server.once('listening', onListening);
			server.listen(port, host);
		});

		this.server = server;
		this.setStatus({
			state: 'running',
			host,
			port,
			url: `http://${host}:${port}/mcp`,
		});
	}

	async stop(): Promise<void> {
		const server = this.server;
		this.server = null;
		if (!server) {
			if (this.status.state !== 'stopped') this.setStatus({ state: 'stopped' });
			return;
		}
		await new Promise<void>(resolve => server.close(() => resolve()));
		this.setStatus({ state: 'stopped' });
	}

	private handleRequest(req: http.IncomingMessage, res: http.ServerResponse, token: string): void {
		// CORS preflight — be permissive for localhost development. The bearer-token
		// requirement on the actual POST is the real auth gate.
		if (req.method === 'OPTIONS') {
			res.writeHead(204, {
				'Access-Control-Allow-Origin': '*',
				'Access-Control-Allow-Methods': 'POST, OPTIONS',
				'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id',
				'Access-Control-Max-Age': '86400',
			});
			res.end();
			return;
		}

		if (req.method !== 'POST' || (req.url ?? '').split('?')[0] !== '/mcp') {
			this.writePlain(res, 404, 'Not found. POST /mcp with a JSON-RPC body.');
			return;
		}

		// Bearer-token check. Token is generated on first enable; clients put it
		// in the Authorization header.
		const auth = req.headers['authorization'];
		const expected = `Bearer ${token}`;
		if (!token || auth !== expected) {
			res.writeHead(401, {
				'WWW-Authenticate': 'Bearer realm="friday-mcp"',
				'Access-Control-Allow-Origin': '*',
			});
			res.end('Unauthorized');
			return;
		}

		let body = '';
		req.setEncoding('utf8');
		req.on('data', chunk => { body += chunk; });
		req.on('end', () => {
			void this.dispatch(body, res);
		});
		req.on('error', () => this.writePlain(res, 400, 'Read error'));
	}

	private async dispatch(body: string, res: http.ServerResponse): Promise<void> {
		let parsed: JsonRpcRequest | JsonRpcRequest[];
		try {
			parsed = JSON.parse(body);
		} catch {
			this.writeJsonRpc(res, {
				jsonrpc: '2.0',
				id: null,
				error: { code: JSONRPC_PARSE_ERROR, message: 'Invalid JSON' },
			});
			return;
		}

		// MCP supports batched requests. Handle both shapes.
		if (Array.isArray(parsed)) {
			const responses: JsonRpcResponse[] = [];
			for (const r of parsed) {
				const resp = await this.handleRpc(r);
				if (resp) responses.push(resp);
			}
			if (responses.length === 0) {
				res.writeHead(202, this.corsHeaders());
				res.end();
			} else {
				this.writeJsonRpc(res, responses);
			}
			return;
		}

		const resp = await this.handleRpc(parsed);
		if (!resp) {
			// Notification — no response body.
			res.writeHead(202, this.corsHeaders());
			res.end();
			return;
		}
		this.writeJsonRpc(res, resp);
	}

	private async handleRpc(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
		if (!req || req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
			return {
				jsonrpc: '2.0',
				id: req?.id ?? null,
				error: { code: JSONRPC_INVALID_REQUEST, message: 'Invalid JSON-RPC request' },
			};
		}

		// Notifications carry no id and expect no response.
		const isNotification = req.id === undefined || req.id === null;

		try {
			switch (req.method) {
				case 'initialize':
					return this.ok(req.id, {
						protocolVersion: MCP_PROTOCOL_VERSION,
						capabilities: { tools: {} },
						serverInfo: { name: 'friday', version: '2.1.0' },
					});

				case 'notifications/initialized':
				case 'notifications/cancelled':
				case 'notifications/progress':
					return null;

				case 'ping':
					return this.ok(req.id, {});

				case 'tools/list':
					return this.ok(req.id, {
						tools: Array.from(this.tools.values()).map(t => ({
							name: t.name,
							description: t.description,
							inputSchema: t.inputSchema,
						})),
					});

				case 'tools/call':
					return await this.handleToolCall(req);

				default:
					if (isNotification) return null;
					return {
						jsonrpc: '2.0',
						id: req.id ?? null,
						error: { code: JSONRPC_METHOD_NOT_FOUND, message: `Unknown method: ${req.method}` },
					};
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (isNotification) return null;
			return {
				jsonrpc: '2.0',
				id: req.id ?? null,
				error: { code: JSONRPC_INTERNAL_ERROR, message },
			};
		}
	}

	private async handleToolCall(req: JsonRpcRequest): Promise<JsonRpcResponse> {
		const params = req.params ?? {};
		const name: unknown = params.name;
		const args: unknown = params.arguments ?? {};

		if (typeof name !== 'string') {
			return {
				jsonrpc: '2.0',
				id: req.id ?? null,
				error: { code: JSONRPC_INVALID_PARAMS, message: 'tools/call requires a string "name"' },
			};
		}

		const tool = this.tools.get(name);
		if (!tool) {
			return {
				jsonrpc: '2.0',
				id: req.id ?? null,
				error: { code: JSONRPC_METHOD_NOT_FOUND, message: `Unknown tool: ${name}` },
			};
		}

		let result: McpToolResult;
		try {
			result = await tool.handler(args && typeof args === 'object' ? args as Record<string, unknown> : {});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			result = {
				content: [{ type: 'text', text: `Tool "${name}" threw: ${message}` }],
				isError: true,
			};
		}

		return this.ok(req.id, result);
	}

	private ok(id: number | string | null | undefined, result: any): JsonRpcResponse {
		return { jsonrpc: '2.0', id: id ?? null, result };
	}

	private writeJsonRpc(res: http.ServerResponse, payload: JsonRpcResponse | JsonRpcResponse[]): void {
		const body = JSON.stringify(payload);
		res.writeHead(200, {
			'Content-Type': 'application/json',
			'Content-Length': Buffer.byteLength(body),
			...this.corsHeaders(),
		});
		res.end(body);
	}

	private writePlain(res: http.ServerResponse, status: number, text: string): void {
		res.writeHead(status, {
			'Content-Type': 'text/plain; charset=utf-8',
			...this.corsHeaders(),
		});
		res.end(text);
	}

	private corsHeaders(): Record<string, string> {
		return {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id',
		};
	}
}

/** Generate a fresh URL-safe token. 24 random bytes → 32-char base64url. */
export function generateMcpToken(): string {
	return randomBytes(24).toString('base64')
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

/** Pop a Notice if the MCP server entered an error state. Callers use this so the
 *  user sees port-in-use failures without opening the console. */
export function noticeForError(status: McpServerStatus): void {
	if (status.state === 'error' && status.message) {
		new Notice(`Friday MCP: ${status.message}`);
	}
}
