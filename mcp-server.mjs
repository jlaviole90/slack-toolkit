#!/usr/bin/env node
// MCP server exposing Slack channel + canvas tools over stdio.
// Token comes from the environment (SLACK_TOKEN / SLACK_MCP_XOXB_TOKEN / SLACK_MCP_XOXP_TOKEN),
// which the client (Claude Code / Claude Desktop / Cursor) injects from its MCP config.
//
// IMPORTANT: stdio transport uses stdout for the JSON-RPC protocol, so this file must never
// write to stdout directly (use stderr for any diagnostics).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { api, resolveChannel, loadToken } from './lib/slack.mjs';

const server = new McpServer({ name: 'slack-toolkit', version: '0.1.0' });

const ok = (text) => ({ content: [{ type: 'text', text }] });
const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });

// Behavior hints so clients can reason about each tool (e.g. auto-approve read-only ones).
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
const WRITE_DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

// Find the canvas file ID attached to a channel. Slack exposes it either as
// properties.canvas.file_id or as a tab of type "canvas" in properties.tabs[].
async function canvasFileIdForChannel(channelId) {
  const info = await api('conversations.info', { channel: channelId });
  const props = info.channel?.properties || {};
  return (
    props.canvas?.file_id ||
    (props.tabs || []).find((t) => t.type === 'canvas' && t.data?.file_id)?.data?.file_id ||
    null
  );
}

server.registerTool(
  'slack_list_channels',
  {
    title: 'List Slack channels',
    description:
      'List the Slack channels this app can see, returning the channel ID, visibility, and #name for each. ' +
      'Use this first to discover the channel ID to pass to the other tools. ' +
      'Note: with a bot token you only see channels the bot has been invited to (/invite @Slack Toolkit); ' +
      'a user token sees everything that user can see. Read-only.',
    inputSchema: {
      types: z
        .string()
        .optional()
        .describe(
          'Comma-separated Slack conversation types to include. Default: "public_channel,private_channel". ' +
            'Other values: im, mpim.',
        ),
    },
    annotations: READ_ONLY,
  },
  async ({ types }) => {
    try {
      const data = await api('users.conversations', {
        types: types || 'public_channel,private_channel',
        exclude_archived: true,
        limit: 1000,
      });
      const rows = (data.channels || [])
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((c) => `${c.id}\t${c.is_private ? 'private' : 'public'}\t#${c.name}`);
      return ok(
        rows.length
          ? `id\tvisibility\tname\n${rows.join('\n')}`
          : '(no channels visible to this token; invite the bot with /invite @Slack Toolkit)',
      );
    } catch (e) {
      return fail(`Error: ${e.message}`);
    }
  },
);

server.registerTool(
  'slack_read_channel',
  {
    title: 'Read recent channel messages',
    description:
      'Read the most recent messages from a channel, newest last. Accepts a "#name" or a channel ID ' +
      '(Cxxxx/Gxxxx). Returns one line per message as "[ts] author: text". Read-only. ' +
      'Requires channels:history / groups:history scope.',
    inputSchema: {
      channel: z
        .string()
        .describe('Target channel as "#name" or a channel ID (Cxxxx/Gxxxx). Use slack_list_channels to find IDs.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe('How many recent messages to return (1-100, default 20).'),
    },
    annotations: READ_ONLY,
  },
  async ({ channel, limit }) => {
    try {
      const id = await resolveChannel(channel);
      const data = await api('conversations.history', { channel: id, limit: limit || 20 });
      const lines = (data.messages || [])
        .reverse()
        .map((m) => `[${m.ts}] ${m.user || m.bot_id || 'unknown'}: ${(m.text || '').replace(/\n/g, ' ')}`);
      return ok(lines.length ? lines.join('\n') : '(no messages)');
    } catch (e) {
      return fail(`Error: ${e.message}`);
    }
  },
);

server.registerTool(
  'slack_get_canvas',
  {
    title: 'Read a canvas',
    description:
      "Fetch a canvas's current content as text/markdown. Provide EITHER `channel` (to read the canvas " +
      'attached to that channel) OR `canvas_id` (Fxxxx). Returns the raw canvas document. ' +
      'Use this before slack_edit_canvas so you edit against the live content. Read-only. ' +
      'Requires files:read scope; if you get missing_scope, reinstall the Slack app to grant it.',
    inputSchema: {
      channel: z
        .string()
        .optional()
        .describe('Channel whose attached canvas to read, as "#name" or ID. Provide this OR canvas_id.'),
      canvas_id: z
        .string()
        .optional()
        .describe('A specific canvas/file ID (Fxxxx) to read. Provide this OR channel.'),
    },
    annotations: READ_ONLY,
  },
  async ({ channel, canvas_id }) => {
    try {
      let fileId = canvas_id;
      if (!fileId) {
        if (!channel) return fail('Provide either `channel` or `canvas_id`.');
        const id = await resolveChannel(channel);
        fileId = await canvasFileIdForChannel(id);
        if (!fileId) return fail('No canvas is attached to that channel.');
      }
      const fi = await api('files.info', { file: fileId });
      const url = fi.file?.url_private_download || fi.file?.url_private;
      if (!url) return fail('Canvas file has no downloadable content URL.');
      const res = await fetch(url, { headers: { Authorization: `Bearer ${loadToken()}` } });
      if (!res.ok) return fail(`Failed to download canvas (HTTP ${res.status}).`);
      const body = await res.text();
      return ok(`canvas_id: ${fileId}\n\n${body}`);
    } catch (e) {
      return fail(`Error: ${e.message}`);
    }
  },
);

server.registerTool(
  'slack_create_canvas',
  {
    title: 'Create a channel canvas',
    description:
      'Create a canvas and attach it to a channel (the channel "Canvas" tab). Provide a channel ' +
      '("#name" or ID), a title, and the body as markdown. Returns the new canvas ID (Fxxxx), which you ' +
      'pass to slack_edit_canvas / slack_get_canvas. A channel can hold one channel canvas; calling this ' +
      'on a channel that already has one creates an additional canvas rather than overwriting. ' +
      'Requires canvases:write scope.',
    inputSchema: {
      channel: z.string().describe('Target channel as "#name" or ID.'),
      title: z.string().describe('Canvas title shown in the channel.'),
      markdown: z.string().describe('Canvas body in Slack-flavored markdown.'),
    },
    annotations: WRITE,
  },
  async ({ channel, title, markdown }) => {
    try {
      const id = await resolveChannel(channel);
      const data = await api(
        'canvases.create',
        { title, channel_id: id, document_content: { type: 'markdown', markdown } },
        { json: true },
      );
      return ok(`Created canvas ${data.canvas_id} in ${id}.`);
    } catch (e) {
      return fail(`Error: ${e.message}`);
    }
  },
);

server.registerTool(
  'slack_edit_canvas',
  {
    title: 'Replace canvas content',
    description:
      'Replace the ENTIRE content of an existing canvas by its ID with new markdown. This overwrites the ' +
      'whole document, so read the current content first with slack_get_canvas if you intend to preserve ' +
      'parts of it. Requires canvases:write scope.',
    inputSchema: {
      canvas_id: z.string().describe('The canvas/file ID to overwrite (Fxxxx), e.g. from slack_create_canvas.'),
      markdown: z.string().describe('The full new canvas body in Slack-flavored markdown (replaces everything).'),
    },
    annotations: WRITE_DESTRUCTIVE,
  },
  async ({ canvas_id, markdown }) => {
    try {
      await api(
        'canvases.edit',
        {
          canvas_id,
          changes: [{ operation: 'replace', document_content: { type: 'markdown', markdown } }],
        },
        { json: true },
      );
      return ok(`Edited canvas ${canvas_id}.`);
    } catch (e) {
      return fail(`Error: ${e.message}`);
    }
  },
);

server.registerTool(
  'slack_post_message',
  {
    title: 'Post a message',
    description:
      'Post a message to a channel. Accepts a "#name" or channel ID and the message text ' +
      '(Slack markdown supported). Returns the message timestamp (ts). Requires chat:write scope, and ' +
      'for a bot token the bot must be a member of the channel. Not idempotent (each call posts again).',
    inputSchema: {
      channel: z.string().describe('Target channel as "#name" or ID.'),
      text: z.string().describe('Message body (Slack-flavored markdown).'),
    },
    annotations: WRITE,
  },
  async ({ channel, text }) => {
    try {
      const id = await resolveChannel(channel);
      const data = await api('chat.postMessage', { channel: id, text, mrkdwn: true });
      return ok(`Posted to ${id} (ts ${data.ts}).`);
    } catch (e) {
      return fail(`Error: ${e.message}`);
    }
  },
);

server.registerTool(
  'slack_add_bookmark',
  {
    title: 'Add a channel bookmark',
    description:
      'Add a link bookmark (a pinned link tab) to a channel. Accepts a "#name" or channel ID, a title, ' +
      'and a URL. Returns the new bookmark ID. Requires bookmarks:write scope.',
    inputSchema: {
      channel: z.string().describe('Target channel as "#name" or ID.'),
      title: z.string().describe('Display title for the bookmark.'),
      link: z.string().url().describe('The URL to bookmark (must be a valid http/https URL).'),
    },
    annotations: WRITE,
  },
  async ({ channel, title, link }) => {
    try {
      const id = await resolveChannel(channel);
      const data = await api('bookmarks.add', { channel_id: id, title, type: 'link', link });
      return ok(`Bookmark added to ${id} (${data.bookmark?.id || 'ok'}).`);
    } catch (e) {
      return fail(`Error: ${e.message}`);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('slack-toolkit MCP server running on stdio.');
