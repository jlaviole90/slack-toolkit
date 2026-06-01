#!/usr/bin/env node
// slack-toolkit: small CLI to read channels and author Slack canvases.
// All commands are parametrized; no hardcoded channel/canvas IDs.

import fs from 'node:fs';
import { api, resolveChannel, loadToken, tokenKind } from '../lib/slack.mjs';

const HELP = `slack-toolkit - read channels and author Slack canvases

Usage:
  slack-toolkit whoami
      Show which workspace/identity the current token belongs to.

  slack-toolkit channels [--types public_channel,private_channel]
      List channels this token can see (a bot only sees channels it has been invited to).

  slack-toolkit canvas:create --channel <#name|ID> --title "<title>" (--file <path>|--file - |--md "<markdown>")
      Create a channel canvas (the channel "tab"). Reads markdown from a file, stdin (-), or inline.

  slack-toolkit canvas:edit --canvas <CANVAS_ID> (--file <path>|--file - |--md "<markdown>")
      Replace a canvas's full content.

  slack-toolkit post --channel <#name|ID> --text "<message>"
      Post a message to a channel.

  slack-toolkit bookmark:add --channel <#name|ID> --title "<title>" --link <url>
      Add a link bookmark/tab to a channel.

Token resolution: SLACK_TOKEN env, else ~/.config/slack-toolkit/token (run: node setup.mjs <token>).
`;

function parseArgs(argv) {
  const args = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, args };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function getMarkdown(args) {
  if (typeof args.md === 'string') return args.md;
  if (args.file === '-' || args.file === true) return readStdin();
  if (typeof args.file === 'string') return fs.readFileSync(args.file, 'utf8');
  throw new Error('Provide canvas content with --file <path>, --file - (stdin), or --md "<markdown>"');
}

async function main() {
  const { positional, args } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];

  switch (cmd) {
    case 'whoami': {
      const me = await api('auth.test');
      console.log(`workspace: ${me.team} (${me.team_id})`);
      console.log(`identity:  ${me.user} (${me.user_id})`);
      console.log(`tokenKind: ${tokenKind(loadToken())}`);
      console.log(`url:       ${me.url}`);
      break;
    }

    case 'channels': {
      const data = await api('users.conversations', {
        types: args.types || 'public_channel,private_channel',
        exclude_archived: true,
        limit: 1000,
      });
      const rows = (data.channels || []).sort((a, b) => a.name.localeCompare(b.name));
      if (!rows.length) console.log('(no channels visible to this token)');
      for (const c of rows) {
        console.log(`${c.id}\t${c.is_private ? 'private' : 'public '}\t#${c.name}`);
      }
      break;
    }

    case 'canvas:create': {
      const channel = await resolveChannel(args.channel);
      const markdown = await getMarkdown(args);
      const data = await api(
        'canvases.create',
        {
          title: args.title || 'Untitled',
          channel_id: channel,
          document_content: { type: 'markdown', markdown },
        },
        { json: true },
      );
      console.log(`created canvas: ${data.canvas_id}`);
      break;
    }

    case 'canvas:edit': {
      if (!args.canvas) throw new Error('--canvas <CANVAS_ID> is required');
      const markdown = await getMarkdown(args);
      await api(
        'canvases.edit',
        {
          canvas_id: args.canvas,
          changes: [{ operation: 'replace', document_content: { type: 'markdown', markdown } }],
        },
        { json: true },
      );
      console.log(`edited canvas: ${args.canvas}`);
      break;
    }

    case 'post': {
      const channel = await resolveChannel(args.channel);
      const data = await api('chat.postMessage', {
        channel,
        text: typeof args.text === 'string' ? args.text : '',
        mrkdwn: true,
      });
      console.log(`posted message ts: ${data.ts}`);
      break;
    }

    case 'bookmark:add': {
      const channel = await resolveChannel(args.channel);
      if (!args.link) throw new Error('--link <url> is required');
      const data = await api('bookmarks.add', {
        channel_id: channel,
        title: args.title || args.link,
        type: 'link',
        link: args.link,
      });
      console.log(`bookmark added: ${data.bookmark?.id || 'ok'}`);
      break;
    }

    case undefined:
    case 'help':
      console.log(HELP);
      break;

    default:
      console.error(`Unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('Error:', e.message);
  process.exitCode = 1;
});
