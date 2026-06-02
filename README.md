# Slack Toolkit

A shareable Slack integration for a team, built for **Claude Code** and also working with **Claude Desktop** and **Cursor** (macOS, Linux, and Windows). It ships its **own MCP server** so the agent can drive Slack directly:

1. **MCP integration** (`mcp-server.mjs`) — exposes Slack tools to Claude Code / Claude Desktop / Cursor: list channels, read messages, post messages, **create and edit channel canvases**, and add link bookmarks. Canvas authoring is a first-class MCP tool, so you can just ask the agent to "create a canvas in #channel".
2. **A small CLI** (`slack-toolkit`) — the same operations from a terminal, handy for scripts or when you want to pipe a markdown file in.

It is backed by **one shared Slack app** (defined by [`manifest.yaml`](manifest.yaml)) that gets installed to the workspace once. After that, each teammate runs a one-line setup.

### MCP tools

Each tool ships a full schema (typed, documented parameters) and behavior annotations
(read-only vs. write/destructive), so agents discover and use them correctly.

| Tool | Read/Write | What it does |
| --- | --- | --- |
| `slack_list_channels` | read | List channels the token can see (a bot sees channels it was invited to); returns IDs to pass to other tools |
| `slack_read_channel` | read | Read recent messages from a channel (`#name` or ID) |
| `slack_get_canvas` | read | Fetch a canvas's current content by channel or canvas ID (needs `files:read`) |
| `slack_post_message` | write | Post a message to a channel |
| `slack_create_canvas` | write | Create a channel canvas from a title + markdown; returns the canvas ID |
| `slack_edit_canvas` | write (destructive) | Replace an existing canvas's full content by ID |
| `slack_add_bookmark` | write | Add a link bookmark/tab to a channel |

---

## Why a shared app (and the token decision)

A Slack token is a credential and **should never be shared in chat or committed to git.** There are two token models; pick one for the team:

| | **Bot token (`xoxb-`)** | **User token (`xoxp-`)** |
| --- | --- | --- |
| Acts as | a named bot ("Slack Toolkit") | the individual person |
| Distribution | **one token for the whole team** | one token per person |
| Channel access | only channels the bot is **invited** to | everything that person can already see |
| Message search | not available (Slack blocks `search.messages` for bots) | available |
| Best for | **shared use (recommended default)** | people who need to act as themselves or search |

The app declares both scope sets, so the setup script auto-detects whichever kind of token you give it.

---

## One-time: create and install the Slack app (an admin does this once)

1. Go to <https://api.slack.com/apps> and click **Create New App -> From a manifest**.
2. Pick your **workspace**, then paste the contents of [`manifest.yaml`](manifest.yaml) and create the app.
3. Open **Install App** (left sidebar) and **Install to Workspace**. Approve the scopes. (If your workspace requires admin approval for apps, an admin approves here.)
4. Copy the token for the model you chose:
   - **Bot token:** Install App page -> **Bot User OAuth Token** (`xoxb-...`).
   - **User token:** OAuth & Permissions page -> **User OAuth Token** (`xoxp-...`).
5. Share the **bot** token with the team through a secret manager (1Password, etc.), **not** in Slack/email. (User tokens are generated per person in step 4, so nothing is shared.)

---

## Per-person setup (everyone who wants it)

Prerequisites: **Node 18+** (`node -v`) and the **Claude Code CLI** (`claude --version`). Works the same on macOS, Linux, and Windows.

```bash
git clone <this-repo-url> slack-toolkit
cd slack-toolkit
npm install                                    # installs the MCP SDK the server needs

# Pass the token once. It is validated, stored locally for the CLI, and registered with Claude Code.
node setup.mjs xoxb-your-team-bot-token        # or your own xoxp- user token
```

What the one command does (everything happens inside this single command; nothing runs in the background):

- Verifies the token against Slack.
- Stores it at `~/.config/slack-toolkit/token` (used by the CLI) — never in the repo.
- Registers the MCP server with **Claude Code** by running `claude mcp add ... --scope user` for you, pointing at this clone's `mcp-server.mjs`. The server launches with plain `node`, so there is no OS-specific shell wrapper to worry about.
- If you also have Claude Desktop or Cursor installed, it wires those too (same MCP config schema).

Target a specific client if you want:

```bash
node setup.mjs <token> --client claude-code     # Claude Code (default)
node setup.mjs <token> --client claude-desktop  # Claude Desktop app
node setup.mjs <token> --client cursor          # Cursor
node setup.mjs <token> --client all             # all three
```

With no flag, it auto-detects which of these are installed and wires up each one it finds. **Claude Desktop and Cursor use the same MCP config schema**, so the server works there identically; the only difference is the config file location, which the script handles per-OS.

Then:

1. **Start a new Claude Code session** (and quit/reopen Cursor or Claude Desktop if you wired them) so the MCP server loads.
2. If you used the **bot token**, invite the bot to each channel: `/invite @Slack Toolkit`.
3. Verify: `claude mcp list` (should show `slack-toolkit  ...  ✓ Connected`).

### Manual alternative (no script)

If you'd rather not run the script, register it directly after `npm install`. Use the **absolute path** to this clone's `mcp-server.mjs`. macOS/Linux:

```bash
claude mcp add --scope user slack-toolkit \
  -e SLACK_TOKEN=xoxb-your-token \
  -- node /absolute/path/to/slack-toolkit/mcp-server.mjs
```

Windows (PowerShell/cmd) — same shape, just a Windows path:

```bat
claude mcp add --scope user slack-toolkit ^
  -e SLACK_TOKEN=xoxb-your-token ^
  -- node C:\path\to\slack-toolkit\mcp-server.mjs
```

> Argument order matters: the server **name comes before** `-e`, and the launch command goes after `--`. `-e/--env` is variadic and will otherwise swallow the name.

---

## Using it from Claude Code

After setup and a new Claude Code session, just ask the agent in natural language, e.g.:

- "List the Slack channels the toolkit can see."
- "Create a canvas titled 'Weekly Notes' in #your-channel with these sections..."
- "Update canvas F0XXXXXXXXX to add a Risks section."
- "Post 'Draft is in the canvas' to #your-channel."

The agent calls the MCP tools in the table above. Canvas create/edit is native — no CLI round-trip required.

---

## Using the CLI

The CLI is plain Node and mirrors the MCP tools, useful for scripting or piping markdown files.

```bash
# Who am I / which workspace?
node bin/slack-toolkit.mjs whoami

# List channels this token can see
node bin/slack-toolkit.mjs channels

# Create a channel canvas from a markdown file
node bin/slack-toolkit.mjs canvas:create --channel "#your-channel" --title "Weekly Notes" --file ./my-canvas.md

# Pipe markdown in from stdin instead of a file
cat my-canvas.md | node bin/slack-toolkit.mjs canvas:create --channel C0XXXXXXXXX --title "Notes" --file -

# Replace an existing canvas's content
node bin/slack-toolkit.mjs canvas:edit --canvas F0XXXXXXXXX --file ./my-canvas.md

# Post a message
node bin/slack-toolkit.mjs post --channel "#your-channel" --text "Draft is in the canvas."

# Add a link bookmark/tab
node bin/slack-toolkit.mjs bookmark:add --channel "#your-channel" --title "Team Calendar" --link "https://example.com/..."
```

`--channel` accepts a `#name` or a channel ID (`C...`/`G...`).

---

## Security notes

- **Never** paste a token into Slack, email, or a commit. `.gitignore` blocks common token filenames as a backstop.
- Tokens live only in `~/.config/slack-toolkit/token` (per machine) and inside each client's MCP config.
- Prefer the **bot token** for shared use: actions are attributed to the bot, scopes are minimal, and you can rotate one credential (app **Install App -> Reinstall**) if it leaks.
- Scopes are limited to read + post + canvases + bookmarks. Widen only by editing `manifest.yaml` and re-applying it.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `slack-toolkit` missing from `claude mcp list` | Make sure you ran `npm install`, then re-run `node setup.mjs <token>` and start a **new** Claude Code session. |
| Server shows "failed" / "connection closed" | Usually a missing `npm install` (the SDK isn't there) or a wrong path in the registration. Re-run `npm install` then `node setup.mjs <token>`. |
| `channel_not_found` / channel missing from `channels` | Bot tokens only see channels they are invited to: `/invite @Slack Toolkit`. |
| `not_authed` / `invalid_auth` | Token missing or wrong. Re-run `node setup.mjs <token>`. |
| `missing_scope (needed: ...)` | Add the scope to `manifest.yaml`, re-apply the manifest, **reinstall** the app, then re-run setup with the new token. |
| `search` fails on a bot token | Expected — Slack blocks message search for bots. Use a user token if you need search. |
| `claude: command not found` | Install the Claude Code CLI, or run `node setup.mjs <token> --client cursor`. |

---

## Repo layout

```
manifest.yaml             Slack app definition (scopes, name). Source of truth for the app.
mcp-server.mjs            The MCP server (stdio). Exposes the Slack tools to the agent.
setup.mjs                 Cross-platform setup: validate token, store it, register the MCP server with each client.
bin/slack-toolkit.mjs     The CLI (whoami, channels, canvas:create/edit, post, bookmark:add).
lib/slack.mjs             Tiny Slack Web API helper (token resolution + request wrapper).
package.json              Node project. Depends on @modelcontextprotocol/sdk and zod.
```
