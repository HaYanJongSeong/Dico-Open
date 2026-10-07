# Open_Cord

[한국어](README.md) | [English](README.en.md)

Open_Cord is a Discord bridge built through vibe coding because the existing Kimaki did not work with OpenCode CLI v2.

Discord channels map to local projects, and threads map to OpenCode sessions. Use `/new` or `/connect` to link a session. Existing connections recover after a restart. External sessions get new threads only when `autoConnect: true` is enabled.

This repository is a Node.js and TypeScript project using `discord.js` v14 and `@opencode-ai/sdk/v2`.

## What it does

Each configured Discord channel points to one local project path. The bot starts one `opencode serve` process per unique project path, or uses a configured shared server. It streams replies into connected threads and saves connections for recovery after a restart. With the default `autoConnect: false`, it does not create threads automatically. When auto-connect is enabled, it skips sessions with `parentID`; child-only SSE output is not relayed into the parent thread. Parent replies are still streamed normally. User-created Discord threads are ignored until `/connect` is run inside them.

Typical flow:

1. Configure a Discord server and one or more channel mappings in `config.yaml`.
2. Run the bot locally on the machine that has access to the configured project paths.
3. Use `/new` in a mapped Discord channel to create an OpenCode session thread.
4. Send normal messages in the thread to talk to the OpenCode agent.
5. Use slash commands in the thread for agent/model selection, interruption, diffs, and synchronization.

> The npm package has not been published. Use the source installation below. The npm instructions are a reference for a possible future release, not a working installation route today. Do not run `npx opencord`; it is a different project.

## Requirements

| Requirement | Notes |
| --- | --- |
| Node.js | 24 or newer; `.nvmrc` pins the tested version. |
| pnpm | Required only when building from source; the repo declares `pnpm@10.33.1`. |
| OpenCode CLI | Install OpenCode CLI v2. On Windows the bot checks the global npm installation, then `PATH`. Set `OPENCODE_EXECUTABLE` in `.env` to override either location. |
| Discord bot token | Create an application and bot in the Discord Developer Portal. |
| Discord message content intent | Required for thread passthrough messages. |
| Local project paths | The bot must run on the same machine where configured projects exist. |

## npm installation (after publication)

These steps are for use after the package is published. Source installation is the currently supported route.

1. Install [Node.js](https://nodejs.org/) 24 or newer and [OpenCode CLI](https://opencode.ai/v2/docs/) v2. Check `node --version` and `opencode --version` in a terminal. If OpenCode does not start, install it first or set `OPENCODE_EXECUTABLE` in the working directory's `.env`.
2. Create an application and bot in the [Discord Developer Portal](https://discord.com/developers/applications), then copy the token. Enable Message Content Intent. In the OAuth2 URL Generator, select the `bot` and `applications.commands` scopes and invite the bot to your server. The bot needs View Channel, Read Message History, Send Messages, Create Public Threads, and Send Messages in Threads permissions. Create a text channel that only you and the bot can access. Enable Developer Mode in Discord's user settings, then right-click to copy the server, channel, and your own account IDs.
3. Create a working directory for the bot and save `config.yaml` there. Replace every placeholder below with your own values.

```yaml
discordToken: "YOUR_DISCORD_BOT_TOKEN"
servers:
  - serverId: "YOUR_DISCORD_SERVER_ID"
    channels:
      - channelId: "YOUR_PRIVATE_CHANNEL_ID"
        projectPath: "C:/path/to/your/project"
        allowedUsers: ["YOUR_DISCORD_USER_ID"]
        permissions: interactive
        autoConnect: false
```

`projectPath` must point to an existing project directory on the computer running the bot. On macOS/Linux, use an absolute path such as `/home/you/project`. `allowedUsers` only limits who can use the bot. Restrict channel read access separately in Discord. Server administrators can still access the channel. `interactive` displays OpenCode permission requests as approval buttons in Discord.

4. Run the following with that working directory as your current directory:

```bash
npx open_cord
```

On the first run, npm may download the package and ask you to confirm installation. Keep the terminal open; press Ctrl+C to stop. The bot reads `config.yaml` and the optional `.env` from the current working directory and creates `state.json` there. Run `/help` and `/new` in the Discord channel, then send a message in the new thread to check the connection. Run only one bot instance. `npx` does not create the Discord bot, channel, or `config.yaml` for you. Do not run `npx opencord`; it is a different project.

## Install from source

1. Create a Discord application and bot in the [Developer Portal](https://discord.com/developers/applications). Enable Message Content Intent. Invite the bot with the `bot` and `applications.commands` scopes. Give it permission to view the project channel, send/read messages, and create/send in public threads. A channel-creating setup wizard also needs Manage Channels.
2. Install Node.js 24+, pnpm 10.33.1, and OpenCode CLI v2 on the computer that hosts your projects. Download and extract this repository's ZIP from [GitHub](https://github.com/HaYanJongSeong/Open_Cord). Open a terminal in the extracted directory.
3. Install and build:

```bash
pnpm install
pnpm build
```

4. Copy `config.example.yaml` to `config.yaml` (PowerShell: `Copy-Item config.example.yaml config.yaml`; macOS/Linux: `cp config.example.yaml config.yaml`). Replace the example Discord bot token, server ID, channel ID, project path, and allowed user ID with your own. The channel must already exist and be private; use only one channel entry at first. Alternatively, `pnpm run setup` creates a private channel for one user; it needs the bot's Manage Channels permission. The wizard refuses to reuse a channel with the same name; configure existing channels manually. Keep the generated `config.yaml` and backups local.
5. Start from the same directory:

```bash
pnpm start
```

On Windows, double-click `opencord.cmd` instead (or run `.\opencord.cmd` in PowerShell). It opens a visible terminal and retries after errors. Start only one bot instance. Test `/help` in the mapped channel, then `/new`. Set `autoConnect: true` only when you intentionally want every externally created OpenCode session to get a Discord thread.

The Discord bot token is currently stored in local `config.yaml`, not an environment variable. Both `config.yaml` and `.env` are excluded from the npm package and ignored by git. For a pre-existing shared OpenCode server, copy `.env.example` to `.env` and set `OPENCODE_SERVER_PASSWORD`, `OPENCODE_SHARED_SERVER_URL`, and `OPENCODE_SHARED_SERVER_PROJECT`. The CLI reads `.env` from the current working directory before loading bot modules; existing environment variables take precedence. Never upload local config, state, credentials, backups, or logs. Ignoring files does not remove anything already committed to repository history.

Set `OPENCODE_DISCORD_SYNC_IMAGES=true` in `.env` to attach newly displayed OpenCode tool images to their mapped Discord threads across all projects. Existing images are not bulk-replayed when enabled. Only PNG, JPEG, WebP, and GIF `data:` images are sent (up to 8 MiB); remote URLs and local paths are never fetched. Members with thread access can see the images. Restart the bot after changing `.env`.

Run in development from a source checkout:

```bash
pnpm dev
```

Run checks from a source checkout:

```bash
pnpm typecheck
pnpm test
pnpm build
```

## Installation verification

On 2026-10-07, source commit `09ec76f` was extracted into a separate Windows directory with no existing `node_modules`, local configuration, or build output. Installation with pnpm 10.33.1, type checking, building, and all 515 tests passed. The checks passed on Node.js 24.15.0 (the `.nvmrc` version) and 24.16.0. The compiled entrypoint also rejected a missing `config.yaml` with the expected configuration error. Validation of `config.example.yaml` passed as well.

If `pnpm` is not on your `PATH`, use these commands from the extracted source directory. They run the same package scripts without a global pnpm installation:

```bash
npx --yes pnpm@10.33.1 install --frozen-lockfile
npx --yes pnpm@10.33.1 typecheck
npx --yes pnpm@10.33.1 build
npx --yes pnpm@10.33.1 test
```

After creating your own `config.yaml` as described above, start with `npx --yes pnpm@10.33.1 start`. This verifies a clean project directory on the existing Windows machine, not a fresh operating system or first-time setup with a new Discord bot account. macOS/Linux installation and a published npm installation have not been tested in this run. No npm publication was performed.

## Configuration

Runtime configuration lives in `config.yaml` in the working directory. This file is ignored by git because it contains secrets.

Use `config.example.yaml` as the reference. Minimal, restricted configuration:

```yaml
discordToken: "YOUR_DISCORD_BOT_TOKEN"
servers:
  - serverId: "YOUR_DISCORD_SERVER_ID"
    channels:
      - channelId: "YOUR_PRIVATE_CHANNEL_ID"
        projectPath: "../project"
        allowedUsers: ["YOUR_DISCORD_USER_ID"]
        permissions: interactive
```

Channel options:

| Field | Default | Purpose |
| --- | --- | --- |
| `channelId` | Required | Discord text channel ID. |
| `projectPath` | Required | Local project path served by OpenCode. Absolute paths, config-relative paths such as `../project`, and home-relative paths such as `~/Developer/project` are supported. |
| `defaultAgent` | `build` in callers when omitted | Agent used when a command does not specify one. |
| `allowAgentSwitch` | `true` | Allows `/agent set` and `/new agent:<name>`. |
| `allowedAgents` | `[]` | Agent allowlist. Empty means all agents. |
| `allowedUsers` | `[]` | Discord user allowlist. Empty means all channel members. |
| `permissions` | `auto` | `auto` grants agent permissions automatically. `interactive` asks with buttons. |
| `questionTimeout` | `300` | Seconds to wait for user answers to agent questions. |
| `connectHistoryLimit` | `30` | Number of recent messages requested on connection. `0` requests all available messages, but the legacy server reader may cap the result at 100. |
| `autoConnect` | `false` | Auto-create Discord threads for externally created OpenCode sessions. |

Notes:

| Topic | Behavior |
| --- | --- |
| Multiple channels per project | Allowed. They share one `opencode serve` process for the same `projectPath`. |
| Multiple `autoConnect` channels | Avoid this for the same `projectPath`. The implementation uses the first matching channel. |
| Model config | Configure models in each project OpenCode config, or set a channel `model`. |
| Hot reload | Config changes are watched and valid reloads update in-memory config. Invalid reloads are rejected and the previous config remains active. |

## Large sessions and Discord limits

- Discord limits normal message content to 2,000 characters. The bot splits long live replies and history messages automatically.
- Discord has no table renderer. Markdown tables in replies and replayed history are wrapped in a code fence so columns stay aligned. Text already inside a code fence is left unchanged.
- The current history reader fetches at most the latest 100 messages in one read; it does not support a working cursor. `connectHistoryLimit: 0` does not guarantee full history. If the saved message marker is older than those 100 messages, recovery skips that gap rather than risking duplicate messages.
- Discord does not impose a fixed practical message-count limit per thread. Do not create a new thread only because a thread has many messages.
- Discord may archive inactive threads. Re-open the thread in Discord before sending a new prompt if needed.
- Large history imports can be throttled by Discord. Use a smaller `connectHistoryLimit` for faster initial connections.

## Windows and Korean text

Use UTF-8 in PowerShell before starting the bot:

```powershell
[Console]::InputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)
```

Do not commit `config.yaml`, `state.json`, logs, bot tokens, or OpenCode server passwords.

For a visible Windows Terminal session with a two-second restart after an error, run `opencord.cmd` after `pnpm build`. It calls `scripts\start-visible.cmd`, which reads the password from `.env`; neither script contains credentials. Restart the bot to load changed `.env` values.

## Discord usage

Use channel-level commands in configured parent channels. Use thread-level commands inside session threads.

Channel-level flow:

1. Run `/new prompt:<text>` to create a new OpenCode session and Discord thread.
2. Optionally pass `agent:<name>` and `title:<thread title>`.
3. Use `/connect session:<id>` to attach a new thread to an existing OpenCode session.
4. Use `/status`, `/agent list`, `/model list`, `/sync status`, and `/help` from a mapped channel.

Thread-level flow:

1. Send normal messages in the thread to prompt the agent.
2. Messages sent during an active turn go directly to OpenCode (`delivery: steer`). The bot does not currently add them to its own queue.
3. Use `/interrupt` to abort the current session work. It does not delete the session.
4. Use `/info`, `/inspect`, and `/diff` to examine the session. Use `/sync now` for a manual sync.

## Command overview

| Command | Context | Purpose |
| --- | --- | --- |
| `/new` | Channel | Create a new OpenCode session thread. |
| `/connect` | Channel or thread | In a channel, create a thread for an existing session. In a thread, attach that current thread. |
| `/agent set` | Thread | Change the active session agent. |
| `/agent list` | Channel or thread | List available agents. |
| `/model set` | Thread | Change the active session model. |
| `/model list` | Channel or thread | List available models. |
| `/interrupt` | Thread | Abort the active OpenCode session task. |
| `/info` | Thread | Show session metadata, queue length, MCP status, usage, and cost. |
| `/inspect` | Thread | Privately inspect recent messages by type. |
| `/status` | Channel | Show project server and active session status. |
| `/help` | Channel or thread | Show context-aware command help. |
| `/sync status` | Channel or thread | Show synchronization status. |
| `/sync now` | Channel or thread | Synchronize immediately. |
| `/restart` | Channel or thread | Confirm and restart a server started by this bot process. Shared and recovered servers are refused without stopping them. It does not restart the bot. |
| `/diff` | Thread | Show OpenCode session diff. |

When OpenCode asks a question through the `question` tool, the bot posts one message per question. Questions with 5 or fewer choices use voting-style buttons; those with more choices use a select menu. Clicking a voting button records the answer immediately. For questions that allow multiple selections, select the items and click the Submit answer button. Select-menu choices take effect immediately. After an answer is recorded, the message changes to `✓ selected choices` and its controls disappear. Once every question is answered, the bot submits all answers to OpenCode together. You can also send `a`, `b`, or the answer itself in the thread. If there are more than 26 choices or no answer within 5 minutes, the request is canceled and the thread receives a notification. Requests already answered in the CLI are detected through `form.replied`, clearing the pending state in Discord.

Menu selections are accepted only from accounts in the channel's `allowedUsers`. Clicks from other accounts are rejected with an ephemeral message.

## Runtime files

| Path | Purpose |
| --- | --- |
| `config.yaml` | Local bot configuration and Discord token. Ignored by git. |
| `.env` | Local shared-server password and optional runtime settings. Ignored by git and excluded from the package. |
| `state.json` | Persisted server, session, and queue state. Ignored by git. |
| `.cache/` | Cached agents, models, sessions, and MCP status. Ignored by git. |
| `logs/` | LaunchAgent stdout and stderr logs. Ignored by git. |
| `<project>/.opencode/attachments/` | Downloaded Discord attachments for prompt file parts. |

## Development

Useful scripts:

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Run `src/cli.ts` through `tsx` and load local `.env`. |
| `pnpm build` | Compile `src/` and `scripts/discord/` into `dist/`. |
| `pnpm start` | Start compiled `dist/src/cli.js` and load local `.env`. |
| `pnpm test` | Run Vitest once. |
| `pnpm test:watch` | Run Vitest in watch mode. |
| `pnpm typecheck` | Run TypeScript without emitting files. |
| `pnpm service:setup` | Install/update the macOS LaunchAgent and start the bot at user login. |
| `pnpm service:status` | Print LaunchAgent status for `com.opencode.discord`. |
| `pnpm service:stop` | Stop the running LaunchAgent-managed process without removing auto-start. |
| `pnpm service:restart` | Restart the LaunchAgent-managed process. |
| `pnpm service:unsetup` | Stop, unload, and remove the macOS LaunchAgent. |

The code uses strict TypeScript, named exports, Zod config validation, `BotError` for structured errors, and atomic state writes. Add a regression test for each bug fix.

## Operational notes

The bot manages `opencode serve` processes itself unless a shared server is configured. It starts servers on demand, shares one server per project path, watches health, and persists process metadata in `state.json`. Auto-connect covers configured projects only; child sessions do not get separate threads. If a configured Discord channel is deleted, rerun setup or update `config.yaml` instead of silently creating an unrestricted replacement.

History polling intervals depend on recent activity: 1 second when less than 10 seconds have passed since activity, 2 seconds when less than 30 seconds have passed, 5 seconds when less than 60 seconds have passed, 10 seconds when less than 120 seconds have passed, and 15 seconds after that. Detecting new messages or changes returns polling to the faster interval. These intervals are delays after a complete scan, not total delivery times; delivery also includes the time spent fetching and sending each session's messages. `/sync now` skips the delay, but waits for any scan already in progress.

When a shared OpenCode service is configured, the bot receives SSE for all projects from that service. CLI v2's `session.step.started` event also triggers immediate user-message synchronization. The bot compares recent OpenCode replies with Discord bot-message timestamps. If a thread is at least 2 minutes behind, it posts a warning and writes a log entry, at most once every 10 minutes per thread. Delivery-check polling does not block history synchronization and runs at most once per minute per thread. A warning alone does not resend missed messages. Timestamps cannot reliably distinguish messages from other bots or replies outside the latest 25 messages. Accurate recovery requires per-message delivery acknowledgments.

`allowedUsers` restricts messages and approval buttons, not read access. Restrict access to sensitive channels in Discord as well.

New OpenCode user messages in every connected session are also sent automatically to the corresponding Discord thread. User messages recover through a saved acknowledgment ID separate from the one used for replies. Existing user-message history is not replayed retroactively. Prompts sent to the bot from Discord are marked with their source to prevent echoes. The legacy prompt path for attachments has no source marker, so the bot compares text and timestamps within 60 seconds against the latest 100 Discord messages. Repeating the same text in the terminal can cause one message to be skipped. `/inspect` shows counts by type from the current thread's latest 100 OpenCode messages. When you select multiple types, it privately displays the latest 5 messages, with up to 1,500 characters per item. User messages, replies, and thoughts are selected by default. Code blocks are part of replies, not a separate message type. System messages and raw tool output are not sent automatically; only server administrators can view them through `/inspect`. Inspecting selected types does not change automatic forwarding settings.

The bot cannot enforce the language of model-generated reasoning. Some models send English reasoning summaries. If Korean output is required, do not deploy publicly until you have checked that model's output in the actual runtime environment.

macOS background service management is available through `pnpm service:*` scripts. The service starts when the current macOS user logs in, selects the Node.js version from `.nvmrc` through `nvm`, runs `node dist/src/cli.js` from this repository, and writes logs to `logs/out.log` and `logs/err.log`.

Before enabling the service, install the `.nvmrc` Node.js version and project dependencies manually:

 ```bash
 nvm install
 nvm use
  pnpm install
  pnpm build
 ```

The service does not build at startup. If Node.js or `dist/src/cli.js` is missing, check `logs/err.log`, build manually, and run `pnpm service:restart`.

For production-like use:

1. Keep `config.yaml`, `state.json`, `.cache/`, and logs out of git.
2. Run the bot on a machine with stable access to every configured project path.
3. Enable the Discord bot intents needed for guild messages and message content.
4. Treat `permissions: auto` as full trust for the configured project.

## Publishing

`npm pack --dry-run --json` shows the allowlisted package contents. The npm release includes compiled code, launch scripts, example config, example env file, README, and LICENSE. Never publish local `config.yaml`, `.env`, `state.json`, backups, or logs. The npm package runs locally; it is not a hosted Discord service. The Discord token stays in ignored `config.yaml`; the optional shared-server password stays in ignored `.env`. `.gitignore` does not remove already-tracked or historical files. A clean package installation was checked on Windows; first-run Discord/OpenCode setup on other machines has not been verified.

OpenCord is based on [joaogsleite/opencode-discord](https://github.com/joaogsleite/opencode-discord) (ISC). This repository starts with a new public history so local configuration and development notes are not included.
