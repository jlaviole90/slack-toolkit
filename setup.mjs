// One-time per-person setup. Designed for Claude Code (cross-platform: macOS, Linux, Windows).
//
//   1. validate the Slack token,
//   2. store it at <config>/slack-toolkit/token (for the canvas CLI),
//   3. register the "slack-toolkit" MCP server via `claude mcp add` (Claude Code handles
//      where its own config lives, on every OS).
//
// Usage:
//   node setup.mjs <xoxb-... | xoxp-...> [--client claude-code|cursor|all]
//   SLACK_TOKEN=xoxb-... node setup.mjs
//
// Default target is Claude Code. Pass --client cursor (or all) to also wire Cursor's mcp.json.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CONFIG_DIR, TOKEN_FILE, tokenKind } from './lib/slack.mjs';

const isWindows = process.platform === 'win32';
const SERVER_KEY = 'slack-toolkit';

// Node 18+ is required for the global fetch used to validate the token.
if (typeof fetch !== 'function') {
  console.error('This script needs Node 18 or newer (it uses built-in fetch). Run `node -v` to check.');
  process.exit(1);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--client') args.client = argv[++i];
    else if (a.startsWith('--client=')) args.client = a.split('=')[1];
    else args._.push(a);
  }
  return args;
}

// The command Claude Code / Cursor should run to start the MCP server.
// On Windows, npx must be wrapped in `cmd /c` or the server fails to launch.
function serverInvocation() {
  const base = ['npx', '-y', 'slack-mcp-server@latest', '--transport', 'stdio'];
  return isWindows ? ['cmd', '/c', ...base] : base;
}

function envEntries(token, kind) {
  return {
    [kind === 'bot' ? 'SLACK_MCP_XOXB_TOKEN' : 'SLACK_MCP_XOXP_TOKEN']: token,
    SLACK_MCP_ADD_MESSAGE_TOOL: 'true',
  };
}

// --- Claude Code (via its own CLI; cross-platform) ----------------------------

function runClaude(args) {
  // shell:true on Windows so `claude.cmd` resolves on PATH.
  return spawnSync('claude', args, { encoding: 'utf8', shell: isWindows });
}

function hasClaudeCli() {
  const r = runClaude(['--version']);
  return r.status === 0;
}

function registerWithClaudeCode(token, kind) {
  // Idempotent: drop any existing entry first (ignore failure if absent).
  runClaude(['mcp', 'remove', SERVER_KEY, '--scope', 'user']);

  const env = envEntries(token, kind);
  const args = ['mcp', 'add', '--scope', 'user', '--transport', 'stdio'];
  for (const [k, v] of Object.entries(env)) args.push('--env', `${k}=${v}`);
  args.push(SERVER_KEY, '--', ...serverInvocation());

  const r = runClaude(args);
  if (r.status !== 0) {
    throw new Error(`claude mcp add failed: ${(r.stderr || r.stdout || '').trim() || 'unknown error'}`);
  }
}

// --- Cursor (writes ~/.cursor/mcp.json; same path on every OS) ----------------

function registerWithCursor(token, kind) {
  const cfgPath = path.join(os.homedir(), '.cursor', 'mcp.json');
  let cfg = { mcpServers: {} };
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.mcpServers = cfg.mcpServers || {};
  } catch {
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  }
  const [command, ...args] = serverInvocation();
  cfg.mcpServers[SERVER_KEY] = { command, args, env: envEntries(token, kind) };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  return cfgPath;
}

// --- main ---------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = (args._[0] || process.env.SLACK_TOKEN || '').trim();
  if (!token) {
    console.error('Usage: node setup.mjs <token> [--client claude-code|cursor|all]');
    console.error('  token starts with xoxb- (bot) or xoxp- (user)');
    process.exit(1);
  }
  const kind = tokenKind(token);
  if (kind !== 'bot' && kind !== 'user') {
    console.error(`That does not look like an app token (got "${token.slice(0, 6)}..."). Expected xoxb- or xoxp-.`);
    process.exit(1);
  }

  // 1. Validate against Slack.
  let auth;
  try {
    const res = await fetch('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    auth = await res.json();
  } catch (e) {
    console.error(`Could not reach Slack to validate the token: ${e.message}`);
    process.exit(1);
  }
  if (!auth.ok) {
    console.error(`Token rejected by Slack: ${auth.error}`);
    process.exit(1);
  }
  console.log(`Validated. Workspace "${auth.team}", identity "${auth.user}", token kind: ${kind}.`);

  // 2. Store the token locally for the canvas CLI (never in the repo).
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, token + '\n');
  try {
    fs.chmodSync(TOKEN_FILE, 0o600); // best-effort; no-op on some Windows setups
  } catch {
    /* ignore */
  }
  console.log(`Stored token -> ${TOKEN_FILE}`);

  // 3. Decide which client(s) to configure.
  const claudePresent = hasClaudeCli();
  let targets;
  if (args.client === 'all') targets = ['claude-code', 'cursor'];
  else if (args.client) targets = [args.client];
  else {
    targets = [];
    if (claudePresent) targets.push('claude-code');
    if (fs.existsSync(path.join(os.homedir(), '.cursor'))) targets.push('cursor');
    if (targets.length === 0) targets = ['claude-code']; // will surface a clear error below
    console.log(`Auto-detected client(s): ${targets.join(', ')} (override with --client)`);
  }

  const restart = new Set();
  for (const t of targets) {
    try {
      if (t === 'claude-code') {
        if (!claudePresent) {
          throw new Error(
            'Claude Code CLI not found on PATH. Install it (https://docs.claude.com/en/docs/claude-code) ' +
              'or re-run with --client cursor.',
          );
        }
        registerWithClaudeCode(token, kind);
        console.log(`Registered "${SERVER_KEY}" with Claude Code (user scope, all projects).`);
        restart.add('Claude Code (start a new session)');
      } else if (t === 'cursor') {
        console.log(`Updated ${registerWithCursor(token, kind)}`);
        restart.add('Cursor (quit and reopen)');
      } else {
        console.warn(`Skipping unknown client "${t}".`);
      }
    } catch (e) {
      console.warn(`Could not configure ${t}: ${e.message}`);
    }
  }

  console.log('\nNext steps:');
  if (restart.size) console.log(`  1. Restart: ${[...restart].join(' / ')}.`);
  if (kind === 'bot') {
    console.log('  2. Invite the bot to channels you want to use:  /invite @Slack Toolkit');
  }
  console.log('  3. Verify the MCP server:  claude mcp list');
  console.log('  4. Verify the CLI:         node bin/slack-toolkit.mjs whoami');
}

main().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
