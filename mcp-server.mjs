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
import { api, resolveChannel } from './lib/slack.mjs';

const server = new McpServer({ name: 'slack-toolkit', version: '0.1.0' });

const ok = (text) => ({ content: [{ type: 'text', text }] });
const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });

server.registerTool(
  'slack_list_channels',
  {
    title: 'List Slack channels',
    description:
      'List the Slack channels this app can see. With a bot token, that is the channels the bot has been invited to. Returns id, visibility, and #name for each.',
    inputSchema: {
      types: z
        .string()
        .optional()
        .describe('Comma-separated channel types. Default: public_channel,private_channel'),
    },
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
      return ok(rows.length ? rows.join('\n') : '(no channels visible to this token)');
    } catch (e) {
      return fail(`Error: ${e.message}`);
    }
  },
);

server.registerTool(
  'slack_read_channel',
  {
    title: 'Read recent messages',
    description: 'Read the most recent messages from a channel. Accepts a #name or a channel ID.',
    inputSchema: {
      channel: z.string().describe('Channel as #name or ID (Cxxxx/Gxxxx)'),
      limit: z.number().int().min(1).max(100).optional().describe('How many messages (default 20)'),
    },
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
  'slack_post_message',
  {
    title: 'Post a message',
    description: 'Post a message to a channel. Accepts a #name or a channel ID.',
    inputSchema: {
      channel: z.string().describe('Channel as #name or ID'),
      text: z.string().describe('Message text (Slack markdown supported)'),
    },
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
  'slack_create_canvas',
  {
    title: 'Create a channel canvas',
    description:
      'Create a canvas and attach it to a channel (the channel "tab"). Accepts a #name or channel ID, a title, and markdown content. Returns the new canvas ID.',
    inputSchema: {
      channel: z.string().describe('Channel as #name or ID'),
      title: z.string().describe('Canvas title'),
      markdown: z.string().describe('Canvas body as markdown'),
    },
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
    description: 'Replace the full content of an existing canvas by its ID.',
    inputSchema: {
      canvas_id: z.string().describe('Canvas ID (e.g. F0XXXXXXXXX)'),
      markdown: z.string().describe('New canvas body as markdown'),
    },
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
  'slack_add_bookmark',
  {
    title: 'Add a channel bookmark',
    description: 'Add a link bookmark/tab to a channel. Accepts a #name or channel ID.',
    inputSchema: {
      channel: z.string().describe('Channel as #name or ID'),
      title: z.string().describe('Bookmark title'),
      link: z.string().describe('URL to bookmark'),
    },
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
