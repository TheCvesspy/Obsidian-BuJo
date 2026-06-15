#!/usr/bin/env node
/**
 * Friday MCPB bridge — stdio ⇄ HTTP proxy for the Friday Obsidian plugin.
 *
 * Claude Desktop spawns this Node process with its bundled Node runtime and
 * speaks newline-delimited JSON-RPC over stdin/stdout. Each line is forwarded
 * to the Friday plugin's local HTTP server (started inside Obsidian); the HTTP
 * response is written back as a single stdout line.
 *
 * Why bridge instead of running the MCP server here directly? The plugin
 * already owns the live TaskStore cache, the vault.process write paths, and
 * the JIRA service caches — duplicating those in a standalone process would
 * be a maintenance trap. The bridge stays tiny (no deps) and the plugin
 * remains the single source of truth.
 *
 * Configured via env vars (set by Claude Desktop from the user_config block in
 * manifest.json):
 *   FRIDAY_MCP_HOST  — defaults to 127.0.0.1
 *   FRIDAY_MCP_PORT  — defaults to 27225
 *   FRIDAY_MCP_TOKEN — required; bearer token from the plugin's settings tab
 */
'use strict';

const http = require('http');
const readline = require('readline');

const HOST = process.env.FRIDAY_MCP_HOST || '127.0.0.1';
const PORT = parseInt(process.env.FRIDAY_MCP_PORT || '27225', 10);
const TOKEN = process.env.FRIDAY_MCP_TOKEN || '';

/** Write to stderr so it shows up in Claude Desktop's MCP server log without
 *  corrupting the stdout JSON-RPC stream. */
function log(...args) {
	console.error('[friday-bridge]', ...args);
}

if (!TOKEN) {
	log('FATAL: FRIDAY_MCP_TOKEN env var is empty. Set it from Friday\'s settings tab.');
	process.exit(1);
}
if (isNaN(PORT) || PORT < 1 || PORT > 65535) {
	log(`FATAL: FRIDAY_MCP_PORT is invalid: "${process.env.FRIDAY_MCP_PORT}"`);
	process.exit(1);
}

log(`Bridging stdio ⇄ http://${HOST}:${PORT}/mcp`);

/**
 * Forward one JSON-RPC envelope to the plugin's HTTP endpoint.
 * Returns the parsed JSON response, or null if the plugin returned 202
 * (which it does for notifications).
 */
function forward(envelope) {
	return new Promise((resolve, reject) => {
		const body = JSON.stringify(envelope);
		const req = http.request(
			{
				host: HOST,
				port: PORT,
				path: '/mcp',
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(body),
					'Authorization': `Bearer ${TOKEN}`,
				},
			},
			res => {
				let chunks = '';
				res.setEncoding('utf8');
				res.on('data', d => { chunks += d; });
				res.on('end', () => {
					if (res.statusCode === 202 || !chunks) {
						resolve(null);
						return;
					}
					if (res.statusCode === 401) {
						reject(new Error('Plugin rejected the bearer token (HTTP 401). Re-copy from Friday settings → MCP Server.'));
						return;
					}
					if (res.statusCode !== 200) {
						reject(new Error(`Plugin returned HTTP ${res.statusCode}: ${chunks.slice(0, 200)}`));
						return;
					}
					try {
						resolve(JSON.parse(chunks));
					} catch (err) {
						reject(new Error(`Plugin returned non-JSON body: ${chunks.slice(0, 200)}`));
					}
				});
			},
		);
		req.on('error', err => {
			// Most common case: Obsidian not running, or plugin disabled / not enabled.
			if (err && err.code === 'ECONNREFUSED') {
				reject(new Error(
					`Could not reach Friday plugin at http://${HOST}:${PORT}. ` +
					'Open Obsidian, enable the Friday plugin, then turn on Settings → MCP Server.',
				));
			} else {
				reject(err);
			}
		});
		req.write(body);
		req.end();
	});
}

/** Build a JSON-RPC error envelope when the bridge itself can't fulfill the request. */
function bridgeError(id, message) {
	return {
		jsonrpc: '2.0',
		id: id === undefined ? null : id,
		error: { code: -32000, message: `friday-bridge: ${message}` },
	};
}

/** Emit one JSON-RPC envelope on stdout as a single newline-terminated line. */
function emit(envelope) {
	process.stdout.write(JSON.stringify(envelope) + '\n');
}

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', async line => {
	const trimmed = line.trim();
	if (!trimmed) return;

	let envelope;
	try {
		envelope = JSON.parse(trimmed);
	} catch {
		emit(bridgeError(null, `Could not parse JSON from stdin: ${trimmed.slice(0, 120)}`));
		return;
	}

	// Notifications carry no id and expect no response — but we still forward
	// them so the plugin can react (e.g. notifications/initialized).
	const isNotification = envelope.id === undefined || envelope.id === null;

	try {
		const response = await forward(envelope);
		if (response === null) {
			// Plugin returned 202 — notification acknowledged, nothing to emit.
			return;
		}
		emit(response);
	} catch (err) {
		const msg = err && err.message ? err.message : String(err);
		if (isNotification) {
			// Notifications don't get error responses on the wire, but the user
			// still wants to see what went wrong — surface in the MCP log.
			log(`Notification "${envelope.method}" failed: ${msg}`);
			return;
		}
		emit(bridgeError(envelope.id, msg));
	}
});

rl.on('close', () => {
	log('stdin closed, exiting');
	process.exit(0);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
