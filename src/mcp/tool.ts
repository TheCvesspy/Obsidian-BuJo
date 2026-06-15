/** Shared types for MCP tool registration. The server reads from these directly. */

/** A single content block in an MCP tool result. Friday tools only emit text blocks. */
export interface McpTextContent {
	type: 'text';
	text: string;
}

/** Result shape returned by an MCP tool. `isError` lets the model see that a
 *  call failed without breaking JSON-RPC (which would be an error envelope and
 *  invisible to the model). */
export interface McpToolResult {
	content: McpTextContent[];
	isError?: boolean;
}

/** A registered MCP tool. `inputSchema` is a raw JSON Schema (draft 2020-12
 *  compatible) — clients use it to know how to call the tool. */
export interface McpTool {
	name: string;
	description: string;
	inputSchema: {
		type: 'object';
		properties?: Record<string, unknown>;
		required?: string[];
		additionalProperties?: boolean;
	};
	handler: (args: Record<string, unknown>) => Promise<McpToolResult>;
}

/** Convenience: build a success result that serializes `value` as pretty JSON. */
export function jsonResult(value: unknown): McpToolResult {
	return {
		content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
	};
}

/** Convenience: build an error result the model can read. */
export function errorResult(message: string): McpToolResult {
	return {
		content: [{ type: 'text', text: message }],
		isError: true,
	};
}

/** Throwable used by tool handlers to short-circuit with a structured error. */
export class ToolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ToolError';
	}
}

/** Validate that `args[key]` is a non-empty string. Throws ToolError otherwise. */
export function requireString(args: Record<string, unknown>, key: string): string {
	const v = args[key];
	if (typeof v !== 'string' || v.length === 0) {
		throw new ToolError(`Missing or invalid "${key}" (expected non-empty string).`);
	}
	return v;
}

/** Read an optional string. Returns undefined when missing or empty. */
export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
	const v = args[key];
	if (v === undefined || v === null) return undefined;
	if (typeof v !== 'string') {
		throw new ToolError(`Invalid "${key}" (expected string).`);
	}
	return v.length === 0 ? undefined : v;
}

/** Read an optional enum value. Returns undefined when missing; throws on bad value. */
export function optionalEnum<T extends string>(
	args: Record<string, unknown>,
	key: string,
	allowed: readonly T[],
): T | undefined {
	const v = args[key];
	if (v === undefined || v === null || v === '') return undefined;
	if (typeof v !== 'string' || !allowed.includes(v as T)) {
		throw new ToolError(`Invalid "${key}" — must be one of: ${allowed.join(', ')}.`);
	}
	return v as T;
}

/** Read an optional boolean. Throws on non-boolean. */
export function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
	const v = args[key];
	if (v === undefined || v === null) return undefined;
	if (typeof v !== 'boolean') {
		throw new ToolError(`Invalid "${key}" (expected boolean).`);
	}
	return v;
}
