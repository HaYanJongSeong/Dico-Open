# Open_Cord

기존 Kimaki가 현재 OpenCode CLI v2 환경에서 동작하지 않아 바이브 코딩으로 만든 Discord 브릿지입니다.

OpenCode CLI v2 ↔ Discord bridge. It maps Discord channels to local OpenCode projects and root sessions to threads. Configured projects reconnect automatically; `/new` and `/connect` remain available.

This repository is a Node.js and TypeScript project using `discord.js` v14 and `@opencode-ai/sdk/v2`.

## What It Does

Each configured Discord channel points at one local project path. The bot starts one `opencode serve` process per unique project path (or attaches to a configured shared server), creates Discord threads for root sessions, streams OpenCode output back to Discord, and persists runtime state so sessions can recover after restarts. Auto-connect skips sessions with `parentID`; it does not relay child-only SSE output into the parent thread. Parent replies are still streamed normally.

Typical flow:

1. Configure a Discord server and one or more channel mappings in `config.yaml`.
2. Run the bot locally on the machine that has access to the configured project paths.
3. Use `/new` in a mapped Discord channel to create an OpenCode session thread.
4. Send normal messages in the thread to talk to the OpenCode agent.
5. Use slash commands in the thread for agent/model selection, interruption, diffs, and synchronization.

> The npm package is `open_cord`. **Do not run `npx opencord`**: that name belongs to an unrelated project.

## Requirements

| Requirement | Notes |
| --- | --- |
| Node.js | 24 or newer; `.nvmrc` pins the tested version. |
| pnpm | Required only when building from source; the repo declares `pnpm@10.33.1`. |
| OpenCode CLI | Install OpenCode CLI v2. On Windows the bot checks the global npm installation, then `PATH`. Set `OPENCODE_EXECUTABLE` in `.env` to override either location. |
| Discord bot token | Create an application and bot in the Discord Developer Portal. |
| Discord message content intent | Required for thread passthrough messages. |
| Local project paths | The bot must run on the same machine where configured projects exist. |

## npm 설치 (권장)

1. [Node.js](https://nodejs.org/) 24 이상과 [OpenCode CLI](https://opencode.ai/docs/) v2를 설치합니다. 터미널에서 `node --version`과 `opencode --version`을 확인합니다. OpenCode가 실행되지 않으면 먼저 설치하거나 작업 폴더의 `.env`에서 `OPENCODE_EXECUTABLE`을 지정합니다.
2. [Discord Developer Portal](https://discord.com/developers/applications)에서 앱과 봇을 만들고 토큰을 복사합니다. **Message Content Intent**를 켭니다. OAuth2 URL Generator에서 `bot`, `applications.commands` 범위를 선택해 서버에 초대합니다. 봇에는 **View Channel**, **Read Message History**, **Send Messages**, **Create Public Threads**, **Send Messages in Threads** 권한이 필요합니다. 사용자와 봇만 접근 가능한 텍스트 채널을 만드세요. Discord 사용자 설정에서 개발자 모드를 켠 뒤 서버·채널·본인 계정의 ID를 우클릭해 복사합니다.
3. 봇 전용 작업 폴더를 만들고 그 폴더 안에 `config.yaml`을 저장합니다. 아래 **모든** 자리표시자를 실제 값으로 바꿉니다.

```yaml
discordToken: "YOUR_DISCORD_BOT_TOKEN"
servers:
  - serverId: "YOUR_DISCORD_SERVER_ID"
    channels:
      - channelId: "YOUR_PRIVATE_CHANNEL_ID"
        projectPath: "C:/path/to/your/project"
        allowedUsers: ["YOUR_DISCORD_USER_ID"]
        permissions: interactive
        autoConnect: true
```

`projectPath`는 봇이 실행되는 컴퓨터의 **존재하는** 프로젝트 폴더입니다. macOS/Linux에서는 `/home/you/project`처럼 절대 경로를 사용하세요. `allowedUsers`는 봇 사용만 제한합니다. **채널 읽기 권한은 Discord에서 별도로 제한**하세요. 서버 관리자는 여전히 접근할 수 있습니다. `interactive`는 OpenCode 권한 요청을 Discord 승인 버튼으로 표시합니다.

4. 같은 작업 폴더를 현재 디렉터리로 두고 실행합니다.

```bash
npx open_cord
```

첫 실행 시 npm 패키지를 내려받고 설치 확인을 요청할 수 있습니다. 터미널을 켜 두세요. 종료는 Ctrl+C입니다. 봇은 **현재 작업 폴더**에서 `config.yaml`과 선택적 `.env`를 읽고 `state.json`을 만듭니다. Discord 채널에서 `/help`, `/new`를 실행하고 새 스레드에 메시지를 보내 확인하세요. 봇은 하나만 실행하세요. `npx`는 Discord 봇·채널·`config.yaml`을 만들지 않습니다. **`npx opencord`는 다른 프로젝트이므로 실행하지 마세요.**

## Install from source

1. Create a Discord application and bot in the [Developer Portal](https://discord.com/developers/applications). Enable **Message Content Intent**. Invite the bot with the `bot` and `applications.commands` scopes. Give it permission to view the project channel, send/read messages, and create/send in public threads. A channel-creating setup wizard also needs **Manage Channels**.
2. Install Node.js 24+, pnpm 10.33.1, and OpenCode CLI v2 on the computer that hosts your projects. Download and extract this repository's ZIP from [GitHub](https://github.com/HaYanJongSeong/Open_Cord). Open a terminal in the extracted directory.
3. Install and build:

```bash
pnpm install
pnpm build
```

4. Copy `config.example.yaml` to `config.yaml` (PowerShell: `Copy-Item config.example.yaml config.yaml`; macOS/Linux: `cp config.example.yaml config.yaml`). Replace the example Discord **bot token**, server ID, channel ID, project path, and allowed user ID with your own. The channel must already exist and be private; use only one channel entry at first. Alternatively, `pnpm run setup` creates a private channel for one user; it needs the bot's **Manage Channels** permission. The wizard refuses to reuse a channel with the same name; configure existing channels manually. Keep the generated `config.yaml` and backups local.
5. Start from the same directory:

```bash
pnpm start
```

On Windows, double-click `opencord.cmd` instead (or run `.\opencord.cmd` in PowerShell). It opens a visible terminal and retries after errors. Start only one bot instance. Test `/help` in the mapped channel, then `/new` or create an OpenCode root session and set `autoConnect: true` for its channel.

The Discord bot token is currently stored in **local `config.yaml`, not an environment variable**. Both `config.yaml` and `.env` are excluded from the npm package and ignored by git. For a pre-existing shared OpenCode server, copy `.env.example` to `.env` and set `OPENCODE_SERVER_PASSWORD`, `OPENCODE_SHARED_SERVER_URL`, and `OPENCODE_SHARED_SERVER_PROJECT`. The CLI reads `.env` from the current working directory before loading bot modules; existing environment variables take precedence. Never upload local config, state, credentials, backups, or logs. Ignoring files does not remove anything already committed to repository history.

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

## Configuration

Runtime configuration lives in `config.yaml` in the working directory. This file is ignored by git because it contains secrets.

Use `config.example.yaml` as the reference. Minimal, restricted shape:

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
- The current history reader fetches at most the latest 100 messages in one read; it does not support a working cursor. `connectHistoryLimit: 0` does **not** guarantee full history. If the saved message marker is older than those 100 messages, recovery skips that gap rather than risking duplicate messages.
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

For a visible Windows Terminal session with a two-second restart after an error, run `opencord.cmd` **after** `pnpm build`. It calls `scripts\start-visible.cmd`, which reads the password from `.env`; neither script contains credentials. Restart the bot to load changed `.env` values.

## Discord Usage

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

## Command Overview

| Command | Context | Purpose |
| --- | --- | --- |
| `/new` | Channel | Create a new OpenCode session thread. |
| `/connect` | Channel | Attach a Discord thread to an existing OpenCode session. |
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

## Runtime Files

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

Project conventions are documented in `AGENTS.md`. The short version is strict TypeScript, named exports, Zod config validation, `BotError` for structured errors, atomic state writes, and TDD for code changes.

## Operational Notes

The bot manages `opencode serve` processes itself unless a shared server is configured. It starts servers on demand, shares one server per project path, watches health, and persists process metadata in `state.json`. Auto-connect covers configured projects only; child sessions do not get separate threads. If a configured Discord channel is deleted, rerun setup or update `config.yaml` instead of silently creating an unrestricted replacement.

동기화는 변경 시 1초부터 재시작하고, 변경이 없으면 최대 1분 간격까지 점차 느려집니다. 수동 `/sync now`는 즉시 실행합니다. 공유 OpenCode 서비스를 설정했다면 모든 프로젝트의 SSE를 해당 서비스에서 받습니다. CLI v2의 `session.step.started` 이벤트도 사용자 메시지 즉시 동기화를 시작합니다. 봇은 최근 OpenCode 응답과 실제 Discord 봇 메시지 시각을 비교합니다. 2분 이상 뒤처지면 해당 스레드에 경고하고 로그를 남깁니다(스레드당 10분에 한 번). 전송 확인 조회는 이력 동기화를 막지 않으며 스레드당 최대 1분에 한 번 실행합니다. 경고만으로 이전에 놓친 메시지를 자동 재전송하지는 않습니다. 시각 비교는 다른 봇 메시지나 최근 25건 밖의 응답을 완전히 구별하지 못하므로, 정확한 복구에는 메시지별 전송 확인 기록이 필요합니다. 사용자별 `allowedUsers`는 메시지와 승인 버튼을 제한하지만 읽기 권한까지 제한하지는 않습니다. 민감한 채널은 Discord에서도 접근을 제한하세요.

연결된 모든 세션에서 **새로 작성한 OpenCode 사용자 메시지**도 해당 Discord 스레드에 자동 전송합니다. 사용자 메시지는 응답과 별도의 저장된 확인 ID로 복구합니다. 기존 기록은 사용자 메시지에 대해 소급 전송하지 않습니다. Discord에서 봇에 보낸 프롬프트는 출처를 표시해 되울림을 방지합니다. 첨부파일을 보내는 구형 프롬프트 경로는 출처 표시가 없어 최근 100개 Discord 메시지의 본문과 60초 이내 시각을 비교합니다. 같은 본문을 터미널에서 반복하면 한 건이 누락될 수 있습니다. `/inspect`는 현재 스레드의 최근 100개 OpenCode 메시지에서 유형별 개수를 표시합니다. 유형을 여러 개 선택하면 최근 5건을 항목당 최대 1,500자로 비공개 조회합니다. 기본 선택은 사용자·응답·생각입니다. 코드 블록은 별도 메시지 유형이 아니라 응답에 포함됩니다. 시스템 메시지와 도구 원문은 자동 전송하지 않으며, `/inspect`에서도 서버 관리자만 볼 수 있습니다. 선택 조회는 자동 전송 설정을 변경하지 않습니다.

모델이 생성하는 reasoning의 언어는 봇이 강제할 수 없습니다. 일부 모델은 영어 reasoning summary를 보냅니다. 한국어 생성이 필수라면 해당 모델의 출력을 실환경에서 검증하기 전 공개 배포하지 마세요.

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
