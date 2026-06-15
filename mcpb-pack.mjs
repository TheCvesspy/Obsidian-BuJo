/**
 * Package the `mcpb/` directory into `friday-mcp.mcpb` via the official
 * @anthropic-ai/mcpb CLI. The CLI validates the manifest, normalises file
 * paths to forward slashes, and writes a spec-compliant zip.
 *
 * Run with: npm run pack-mcpb
 */
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';

const ROOT = resolve('.');
const SRC = join(ROOT, 'mcpb');
const OUT = join(ROOT, 'friday-mcp.mcpb');

if (!existsSync(SRC)) {
	console.error(`Source directory not found: ${SRC}`);
	process.exit(1);
}

// Ensure a stale output doesn't shadow the new one — the CLI refuses to
// overwrite without warning.
if (existsSync(OUT)) rmSync(OUT);

// `mcpb pack <dir> <out>` validates the manifest then zips. Inherit stdio so
// validation errors surface to the user.
//
// `shell: true` is required on Windows for Node 22+ to spawn .cmd files
// (CVE-2024-27980 removed the auto-shell fallback). With `shell: true`, args
// are joined into the command string by the OS, so paths with spaces have to
// be quoted manually — relative paths sidestep the issue entirely.
const srcRel = relative(ROOT, SRC) || '.';
const outRel = relative(ROOT, OUT);
execFileSync(
	'npx',
	['mcpb', 'pack', srcRel, outRel],
	{ stdio: 'inherit', cwd: ROOT, shell: true },
);
