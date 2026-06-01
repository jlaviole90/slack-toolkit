// Minimal Slack Web API helper. Zero dependencies (uses global fetch, Node >= 18).
// Token resolution order: SLACK_TOKEN env -> SLACK_MCP_XOXP/XOXB env -> ~/.config/slack-toolkit/token

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONFIG_DIR = path.join(os.homedir(), '.config', 'slack-toolkit');
export const TOKEN_FILE = path.join(CONFIG_DIR, 'token');

export function loadToken() {
  const fromEnv =
    process.env.SLACK_TOKEN ||
    process.env.SLACK_MCP_XOXP_TOKEN ||
    process.env.SLACK_MCP_XOXB_TOKEN;
  if (fromEnv) return fromEnv.trim();
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    throw new Error(
      `No Slack token found. Set SLACK_TOKEN or run "node setup.mjs <token>". Looked at ${TOKEN_FILE}`,
    );
  }
}

export function tokenKind(token) {
  if (token.startsWith('xoxp-')) return 'user';
  if (token.startsWith('xoxb-')) return 'bot';
  if (token.startsWith('xoxc-')) return 'browser';
  return 'unknown';
}

// Call any Slack Web API method. Set { json: true } for methods that take a JSON body
// (canvases.create, canvases.edit); otherwise params are sent as form-encoded.
export async function api(method, params = {}, { json = false, token } = {}) {
  const bearer = token || loadToken();
  const url = `https://slack.com/api/${method}`;
  let res;
  if (json) {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(params),
    });
  } else {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form,
    });
  }
  const data = await res.json();
  if (!data.ok) {
    const needed = data.needed ? ` (needed scope: ${data.needed})` : '';
    throw new Error(`Slack API "${method}" failed: ${data.error}${needed}`);
  }
  return data;
}

// Accept a channel ID (Cxxxx / Gxxxx) or a "#name" and return the ID.
// Resolves names against the channels this token can see (a bot sees only channels it is in).
export async function resolveChannel(idOrName, { token } = {}) {
  if (!idOrName) throw new Error('--channel is required (#name or channel ID)');
  if (/^[CG][A-Z0-9]+$/.test(idOrName)) return idOrName;
  const name = idOrName.replace(/^#/, '');
  let cursor = '';
  do {
    const data = await api(
      'users.conversations',
      {
        types: 'public_channel,private_channel',
        exclude_archived: true,
        limit: 1000,
        cursor: cursor || undefined,
      },
      { token },
    );
    const hit = data.channels.find((c) => c.name === name);
    if (hit) return hit.id;
    cursor = data.response_metadata?.next_cursor || '';
  } while (cursor);
  throw new Error(
    `Channel "${idOrName}" not found or not visible to this token. ` +
      `If using a bot token, invite the bot to the channel first (/invite @Slack Toolkit).`,
  );
}
