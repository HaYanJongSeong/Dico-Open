# Dis-code

[한국어](README.md) | [English](README.en.md)

기존 Kimaki가 현재 OpenCode CLI v2 환경에서 동작하지 않아 바이브 코딩으로 만든 Discord 브릿지입니다.

OpenCode CLI v2와 Discord를 연결합니다. Discord 채널은 로컬 프로젝트에, 스레드는 OpenCode 세션에 연결됩니다. `/new`나 `/connect`로 세션을 연결하세요. 기존 연결은 재시작 후 복구하며 외부에서 만든 세션은 `autoConnect: true`일 때만 새 스레드를 만듭니다.

Node.js와 TypeScript로 작성했으며 `discord.js` v14와 `@opencode-ai/sdk/v2`를 사용합니다.

## 주요 기능

설정한 Discord 채널마다 로컬 프로젝트 경로 하나를 연결합니다. 봇은 서로 다른 프로젝트 경로마다 `opencode serve` 프로세스를 하나씩 실행하거나, 설정된 공유 서버를 사용합니다. 연결된 스레드로 응답을 실시간 전송하고 연결 정보를 저장해 재시작 후 복구합니다. 자동 스레드 생성은 기본적으로 꺼져 있습니다. 자동 연결을 켜도 `parentID`가 있는 세션은 건너뛰며 자식 세션에만 속하는 SSE 출력은 부모 스레드로 전송하지 않습니다. 부모 세션의 응답은 정상적으로 실시간 전송합니다. 사용자가 직접 만든 Discord 스레드는 그 안에서 `/connect`를 실행하기 전까지 연결하지 않습니다.

기본 사용 흐름:

1. `config.yaml`에 Discord 서버와 하나 이상의 채널 연결을 설정합니다.
2. 설정한 프로젝트 경로에 접근할 수 있는 컴퓨터에서 봇을 실행합니다.
3. 연결된 Discord 채널에서 `/new`로 OpenCode 세션 스레드를 만듭니다.
4. 스레드에 일반 메시지를 보내 OpenCode 에이전트와 대화합니다.
5. 스레드의 슬래시 명령으로 에이전트·모델 선택, 작업 중단, 변경 사항 확인, 동기화를 수행합니다.

> npm 패키지명과 실행 명령은 `dis-code`입니다. **`npx opencord`는 다른 프로젝트이므로 실행하지 마세요.**

## 요구 사항

| 항목 | 설명 |
| --- | --- |
| Node.js | 24 이상. `.nvmrc`에 테스트한 버전을 고정해 두었습니다. |
| pnpm | 소스에서 빌드할 때만 필요합니다. 저장소에 선언된 버전은 `pnpm@10.33.1`입니다. |
| OpenCode CLI | OpenCode CLI v2를 설치하세요. Windows에서는 전역 npm 설치 경로를 먼저 확인하고 그다음 `PATH`를 확인합니다. `.env`의 `OPENCODE_EXECUTABLE`로 실행 파일 경로를 직접 지정할 수 있습니다. |
| Discord 봇 토큰 | Discord Developer Portal에서 애플리케이션과 봇을 만드세요. |
| Discord Message Content Intent | 스레드의 일반 메시지를 전달하는 데 필요합니다. |
| 로컬 프로젝트 경로 | 설정한 프로젝트가 있는 컴퓨터에서 봇을 실행해야 합니다. |

## npm 설치

소스 빌드 없이 `npx dis-code`로 실행합니다. Discord 봇과 로컬 설정은 먼저 준비해야 합니다.

1. [Node.js](https://nodejs.org/) 24 이상과 [OpenCode CLI](https://opencode.ai/v2/docs/) v2를 설치합니다. 터미널에서 `node --version`과 `opencode --version`을 확인합니다. OpenCode가 실행되지 않으면 먼저 설치하거나 작업 폴더의 `.env`에서 `OPENCODE_EXECUTABLE`을 지정합니다.
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
        autoConnect: false
```

`projectPath`는 봇이 실행되는 컴퓨터의 **존재하는** 프로젝트 폴더입니다. macOS/Linux에서는 `/home/you/project`처럼 절대 경로를 사용하세요. `allowedUsers`는 봇 사용만 제한합니다. **채널 읽기 권한은 Discord에서 별도로 제한**하세요. 서버 관리자는 여전히 접근할 수 있습니다. `interactive`는 OpenCode 권한 요청을 Discord 승인 버튼으로 표시합니다.

4. 같은 작업 폴더를 현재 디렉터리로 두고 실행합니다.

```bash
npx dis-code
```

첫 실행 시 npm 패키지를 내려받고 설치 확인을 요청할 수 있습니다. 터미널을 켜 두세요. 종료는 Ctrl+C입니다. 봇은 **현재 작업 폴더**에서 `config.yaml`과 선택적 `.env`를 읽고 `state.json`을 만듭니다. Discord 채널에서 `/help`, `/new`를 실행하고 새 스레드에 메시지를 보내 확인하세요. 봇은 하나만 실행하세요. `npx`는 Discord 봇·채널·`config.yaml`을 만들지 않습니다. **`npx opencord`는 다른 프로젝트이므로 실행하지 마세요.**

## 소스 설치

1. [Developer Portal](https://discord.com/developers/applications)에서 Discord 애플리케이션과 봇을 만듭니다. **Message Content Intent**를 켭니다. `bot`과 `applications.commands` 범위를 선택해 봇을 초대합니다. 프로젝트 채널 보기, 메시지 보내기·읽기, 공개 스레드 만들기·메시지 보내기 권한을 부여하세요. 채널을 만드는 설정 마법사에는 **Manage Channels** 권한도 필요합니다.
2. 프로젝트가 있는 컴퓨터에 Node.js 24 이상, pnpm 10.33.1, OpenCode CLI v2를 설치합니다. [GitHub](https://github.com/HaYanJongSeong/Dis-code)에서 이 저장소의 ZIP을 내려받아 압축을 풉니다. 압축을 푼 디렉터리에서 터미널을 여세요.
3. 의존성을 설치하고 빌드합니다.

```bash
pnpm install
pnpm build
```

4. `config.example.yaml`을 `config.yaml`로 복사합니다(PowerShell: `Copy-Item config.example.yaml config.yaml`; macOS/Linux: `cp config.example.yaml config.yaml`). 예제의 Discord **봇 토큰**, 서버 ID, 채널 ID, 프로젝트 경로, 허용할 사용자 ID를 실제 값으로 바꾸세요. 채널은 미리 만든 비공개 채널이어야 합니다. 처음에는 채널 항목을 하나만 사용하세요. 대신 `pnpm run setup`을 실행하면 사용자 한 명을 위한 비공개 채널을 만듭니다. 이때 봇에 **Manage Channels** 권한이 필요합니다. 마법사는 같은 이름의 기존 채널을 재사용하지 않습니다. 기존 채널은 직접 설정하세요. 생성된 `config.yaml`과 백업은 로컬에만 보관하세요.
5. 같은 디렉터리에서 실행합니다.

```bash
pnpm start
```

Windows에서는 `dis-code.cmd`를 더블클릭하거나 PowerShell에서 `.\dis-code.cmd`를 실행해도 됩니다. 터미널 창을 띄우고 오류가 나면 다시 실행합니다. 봇은 하나만 실행하세요. 연결된 채널에서 `/help`, 이어서 `/new`를 확인합니다. 외부에서 만든 OpenCode 세션마다 Discord 스레드를 만들려는 경우에만 `autoConnect: true`를 설정하세요.

Discord 봇 토큰은 현재 **환경 변수가 아닌 로컬 `config.yaml`**에 저장합니다. `config.yaml`과 `.env`는 npm 패키지에서 제외하며 git에서도 무시합니다. 기존 공유 OpenCode 서버를 사용한다면 `.env.example`을 `.env`로 복사하고 `OPENCODE_SERVER_PASSWORD`, `OPENCODE_SHARED_SERVER_URL`, `OPENCODE_SHARED_SERVER_PROJECT`를 설정하세요. CLI는 봇 모듈을 불러오기 전에 현재 작업 디렉터리의 `.env`를 읽습니다. 이미 설정된 환경 변수가 우선합니다. 로컬 설정, 상태, 자격 증명, 백업, 로그를 업로드하지 마세요. 파일을 무시하도록 설정해도 이미 저장소 이력에 커밋한 내용은 지워지지 않습니다.

`.env`에 `OPENCODE_DISCORD_SYNC_IMAGES=true`를 설정하면 모든 프로젝트에서 OpenCode 도구가 새로 표시한 이미지를 연결된 Discord 스레드에 첨부합니다. 설정을 켜도 기존 이미지를 한꺼번에 다시 보내지는 않습니다. PNG, JPEG, WebP, GIF 형식의 `data:` 이미지만 보내며 크기는 최대 8 MiB입니다. 원격 URL이나 로컬 경로의 이미지는 가져오지 않습니다. 스레드에 접근할 수 있는 구성원은 이미지를 볼 수 있습니다. `.env`를 바꾸면 봇을 재시작하세요.

소스 디렉터리에서 개발 모드로 실행:

```bash
pnpm dev
```

소스 디렉터리에서 검사:

```bash
pnpm typecheck
pnpm test
pnpm build
```

## 설치 검증 범위

프로젝트 이름을 Open_Cord에서 Dis-code로 변경했습니다. 아래 `@hayanjongseong/open_cord` 검증 결과는 이전 이름으로 게시한 패키지에 관한 기록입니다. 기존 패키지는 삭제하지 않습니다.

`@hayanjongseong/open_cord@0.1.0`을 npm에 공개했습니다. 레지스트리의 `latest=0.1.0`과 배포 파일의 SHA-512 일치를 확인했습니다. 별도 Windows 디렉터리에서 npm 설치와 새 캐시를 사용하는 `npx @hayanjongseong/open_cord@0.1.0` 실행도 검사했습니다. 두 경로 모두 실행 파일을 불러왔고 로컬 `config.yaml`이 없으면 예상한 설정 오류로 종료했습니다. 이 검사는 패키지 다운로드·실행 검증이며 새 Discord 봇의 최초 연결 검증은 아닙니다.

2026-10-07에 소스 커밋 `09ec76f`를 기존 `node_modules`, 로컬 설정, 빌드 결과가 없는 별도 Windows 디렉터리에 풀어 검사했습니다. pnpm 10.33.1로 의존성을 설치한 뒤 타입 검사·빌드·테스트 515개가 통과했습니다. Node.js 24.15.0(`.nvmrc` 지정 버전)과 24.16.0에서 확인했습니다. 빌드된 실행 파일도 `config.yaml`이 없을 때 예상한 설정 오류로 종료했습니다. `config.example.yaml`의 설정 검증도 통과했습니다.

`pnpm`이 `PATH`에 없다면 소스 디렉터리에서 다음 명령을 사용하세요. 전역 설치 없이 같은 패키지 스크립트를 실행합니다.

```bash
npx --yes pnpm@10.33.1 install --frozen-lockfile
npx --yes pnpm@10.33.1 typecheck
npx --yes pnpm@10.33.1 build
npx --yes pnpm@10.33.1 test
```

위 안내대로 본인의 `config.yaml`을 만든 뒤 `npx --yes pnpm@10.33.1 start`로 실행합니다. 이번 검증은 기존 Windows 컴퓨터의 새 프로젝트 디렉터리에서 수행했습니다. 새 운영체제나 새 Discord 봇 계정의 최초 설정까지 검증한 것은 아닙니다. macOS/Linux 설치와 게시된 npm 패키지 설치도 이번에는 검사하지 않았습니다. npm 게시는 하지 않았습니다.

## 설정

실행 설정은 작업 디렉터리의 `config.yaml`에 저장합니다. 이 파일에는 비밀 정보가 들어 있으므로 git에서 무시합니다.

`config.example.yaml`을 참고하세요. 사용자 접근을 제한한 최소 설정은 다음과 같습니다.

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

채널 옵션:

| 필드 | 기본값 | 용도 |
| --- | --- | --- |
| `channelId` | 필수 | Discord 텍스트 채널 ID. |
| `projectPath` | 필수 | OpenCode가 사용하는 로컬 프로젝트 경로. 절대 경로, `../project` 같은 설정 파일 기준 상대 경로, `~/Developer/project` 같은 홈 디렉터리 기준 경로를 지원합니다. |
| `defaultAgent` | 생략하면 호출부에서 `build` 사용 | 명령에서 에이전트를 지정하지 않았을 때 사용할 에이전트. |
| `allowAgentSwitch` | `true` | `/agent set`과 `/new agent:<name>` 허용 여부. |
| `allowedAgents` | `[]` | 허용할 에이전트 목록. 비어 있으면 모든 에이전트를 허용합니다. |
| `allowedUsers` | `[]` | 허용할 Discord 사용자 목록. 비어 있으면 채널의 모든 구성원을 허용합니다. |
| `permissions` | `auto` | `auto`는 에이전트 권한을 자동 승인합니다. `interactive`는 버튼으로 승인을 요청합니다. |
| `questionTimeout` | `300` | 에이전트 질문에 대한 사용자 답변을 기다리는 시간(초). |
| `connectHistoryLimit` | `30` | 연결할 때 요청할 최근 메시지 수. `0`이면 사용 가능한 전체 메시지를 요청하지만 구형 서버 조회기는 결과를 100건으로 제한할 수 있습니다. |
| `autoConnect` | `false` | 외부에서 만든 OpenCode 세션에 Discord 스레드를 자동으로 만들지 여부. |

참고 사항:

| 항목 | 동작 |
| --- | --- |
| 프로젝트 하나에 여러 채널 연결 | 가능합니다. 같은 `projectPath`의 채널은 `opencode serve` 프로세스 하나를 공유합니다. |
| 여러 채널에서 `autoConnect` 사용 | 같은 `projectPath`에서는 피하세요. 구현상 처음 일치하는 채널을 사용합니다. |
| 모델 설정 | 프로젝트별 OpenCode 설정에서 모델을 지정하거나 채널의 `model`을 설정하세요. |
| 설정 자동 반영 | 설정 파일 변경을 감시합니다. 유효한 설정은 메모리에 반영하고 유효하지 않은 설정은 거부한 뒤 이전 설정을 유지합니다. |

## 큰 세션과 Discord 제한

- Discord의 일반 메시지 본문은 2,000자까지입니다. 봇은 긴 실시간 응답과 이력 메시지를 자동으로 나눕니다.
- Discord는 표를 렌더링하지 않습니다. 응답과 다시 전송하는 이력의 Markdown 표를 코드 블록으로 감싸 열 정렬을 유지합니다. 이미 코드 블록 안에 있는 텍스트는 바꾸지 않습니다.
- 현재 이력 조회기는 한 번에 최근 메시지 최대 100건을 가져오며 정상 작동하는 커서를 지원하지 않습니다. `connectHistoryLimit: 0`으로 설정해도 전체 이력을 **보장하지 않습니다**. 저장된 메시지 기준점이 최근 100건보다 오래됐으면 복구 시 중복 전송 위험을 피하려고 그 사이 구간을 건너뜁니다.
- Discord 스레드에는 실제 사용을 제약하는 고정 메시지 개수 제한이 없습니다. 메시지가 많다는 이유만으로 새 스레드를 만들지 마세요.
- Discord는 비활성 스레드를 보관 처리할 수 있습니다. 필요하면 Discord에서 스레드를 다시 연 뒤 새 프롬프트를 보내세요.
- 이력을 대량으로 가져오면 Discord가 전송 속도를 제한할 수 있습니다. 처음 연결할 때 시간을 줄이려면 `connectHistoryLimit`을 낮추세요.

## Windows와 한글

봇을 시작하기 전에 PowerShell을 UTF-8로 설정하세요.

```powershell
[Console]::InputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)
```

`config.yaml`, `state.json`, 로그, 봇 토큰, OpenCode 서버 비밀번호를 커밋하지 마세요.

Windows Terminal 창을 띄우고 오류 후 2초 뒤 재시작하려면 **`pnpm build`를 마친 뒤** `dis-code.cmd`를 실행하세요. 이 파일은 `scripts\start-visible.cmd`를 호출하며 해당 스크립트는 `.env`에서 비밀번호를 읽습니다. 두 스크립트 모두 자격 증명을 포함하지 않습니다. `.env` 변경 내용을 불러오려면 봇을 재시작하세요.

## Discord 사용법

채널 명령은 설정한 상위 채널에서, 스레드 명령은 세션 스레드 안에서 사용하세요.

채널에서:

1. `/new prompt:<text>`로 OpenCode 세션과 Discord 스레드를 만듭니다.
2. 필요하면 `agent:<name>`과 `title:<thread title>`을 함께 지정합니다.
3. `/connect session:<id>`로 기존 OpenCode 세션에 새 스레드를 연결합니다.
4. 연결된 채널에서 `/status`, `/agent list`, `/model list`, `/sync status`, `/help`를 사용합니다.

스레드 안에서 `/connect session:<id>`를 실행하면 새 스레드를 만들지 않고 현재 스레드를 연결합니다. 현재 스레드가 종료되지 않은 다른 세션에 연결돼 있으면 기존 연결을 덮어쓰지 않고 요청을 거부합니다. 이미 종료되지 않은 Discord 연결이 있는 세션도 다시 연결하지 않습니다.

스레드에서:

1. 일반 메시지를 보내 에이전트에 프롬프트를 전달합니다.
2. 작업 중 보낸 메시지는 OpenCode로 바로 전달합니다(`delivery: steer`). 현재 봇 자체의 큐에는 추가하지 않습니다.
3. `/interrupt`로 현재 세션의 작업을 중단합니다. 세션은 삭제하지 않습니다.
4. `/info`, `/inspect`, `/diff`로 세션을 확인합니다. 수동 동기화는 `/sync now`를 사용하세요.

## 명령 목록

| 명령 | 사용 위치 | 용도 |
| --- | --- | --- |
| `/new` | 채널 | 새 OpenCode 세션 스레드를 만듭니다. |
| `/connect` | 채널 또는 스레드 | 채널에서는 기존 세션용 스레드를 만들고 스레드에서는 현재 스레드를 연결합니다. |
| `/agent set` | 스레드 | 현재 세션의 에이전트를 바꿉니다. |
| `/agent list` | 채널 또는 스레드 | 사용 가능한 에이전트 목록을 표시합니다. |
| `/model set` | 스레드 | 현재 세션의 모델을 바꿉니다. |
| `/model list` | 채널 또는 스레드 | 사용 가능한 모델 목록을 표시합니다. |
| `/interrupt` | 스레드 | 진행 중인 OpenCode 세션 작업을 중단합니다. |
| `/info` | 스레드 | 세션 정보, 큐 길이, MCP 상태, 사용량, 비용을 표시합니다. |
| `/inspect` | 스레드 | 최근 메시지를 유형별로 비공개 조회합니다. |
| `/status` | 채널 | 프로젝트 서버와 활성 세션 상태를 표시합니다. |
| `/help` | 채널 또는 스레드 | 사용 위치에 맞는 명령 도움말을 표시합니다. |
| `/sync status` | 채널 또는 스레드 | 동기화 상태를 표시합니다. |
| `/sync now` | 채널 또는 스레드 | 즉시 동기화합니다. |
| `/restart` | 채널 또는 스레드 | 확인 후 이 봇 프로세스가 시작한 서버를 재시작합니다. 공유 서버와 복구한 서버는 중지하지 않고 요청을 거부합니다. 봇 자체를 재시작하지는 않습니다. |
| `/diff` | 스레드 | OpenCode 세션의 변경 사항을 표시합니다. |

OpenCode가 확인을 요구하면(`question` 도구) 질문 하나당 메시지 하나가 게시됩니다. 선택지가 5개 이하면 투표 방식 버튼이 붙고 그보다 많으면 선택 메뉴가 붙습니다. 투표 버튼은 누르면 바로 답변으로 기록되고 다중 선택은 항목을 고른 뒤 **답변 제출** 버튼을 누릅니다. 선택 메뉴는 고르면 즉시 반영됩니다. 답을 기록한 메시지는 `✓ 선택 내용` 으로 바뀌고 입력 수단이 사라집니다. 마지막 질문까지 답하면 한 번에 OpenCode로 제출됩니다. 스레드에 `a`, `b`, 또는 답변을 그대로 보내도 됩니다. 선택지가 26개를 넘거나 5분 안에 답변이 없으면 요청이 취소되고 스레드에 알림이 옵니다. CLI에서 이미 답변한 요청은 `form.replied`로 감지되어 Discord의 대기 상태가 해제됩니다.

메뉴 선택은 채널의 `allowedUsers`에 있는 계정에 대해서만 반영됩니다. 다른 계정의 클릭은 임시 메시지로 거절됩니다.

## 실행 중 사용하는 파일

| 경로 | 용도 |
| --- | --- |
| `config.yaml` | 로컬 봇 설정과 Discord 토큰. git에서 무시합니다. |
| `.env` | 로컬 공유 서버 비밀번호와 선택적 실행 설정. git에서 무시하며 패키지에서 제외합니다. |
| `state.json` | 서버, 세션, 큐 상태를 저장합니다. git에서 무시합니다. |
| `.cache/` | 에이전트, 모델, 세션, MCP 상태 캐시. git에서 무시합니다. |
| `logs/` | LaunchAgent 표준 출력·표준 오류 로그. git에서 무시합니다. |
| `<project>/.opencode/attachments/` | 프롬프트의 파일 부분에 사용할 Discord 첨부파일을 내려받는 경로. |

## 개발

주요 스크립트:

| 명령 | 용도 |
| --- | --- |
| `pnpm dev` | `tsx`로 `src/cli.ts`를 실행하고 로컬 `.env`를 읽습니다. |
| `pnpm build` | `src/`와 `scripts/discord/`를 `dist/`로 컴파일합니다. |
| `pnpm start` | 컴파일된 `dist/src/cli.js`를 실행하고 로컬 `.env`를 읽습니다. |
| `pnpm test` | Vitest를 한 번 실행합니다. |
| `pnpm test:watch` | Vitest를 감시 모드로 실행합니다. |
| `pnpm typecheck` | 파일을 출력하지 않고 TypeScript를 검사합니다. |
| `pnpm service:setup` | macOS LaunchAgent를 설치·갱신하고 사용자 로그인 시 봇을 시작합니다. |
| `pnpm service:status` | `com.opencode.discord`의 LaunchAgent 상태를 출력합니다. |
| `pnpm service:stop` | 자동 시작 설정은 유지하고 LaunchAgent가 관리하는 실행 중 프로세스를 중지합니다. |
| `pnpm service:restart` | LaunchAgent가 관리하는 프로세스를 재시작합니다. |
| `pnpm service:unsetup` | macOS LaunchAgent를 중지하고 등록을 해제한 뒤 제거합니다. |

코드는 엄격한 TypeScript 설정, 이름 있는 내보내기, Zod 설정 검증, 구조화된 오류를 위한 `BotError`, 원자적 상태 저장을 사용합니다. 버그를 수정할 때마다 회귀 테스트를 추가하세요.

## 운영 참고 사항

공유 서버를 설정하지 않으면 봇이 `opencode serve` 프로세스를 직접 관리합니다. 필요할 때 서버를 시작하고 프로젝트 경로마다 서버 하나를 공유하며 상태를 감시합니다. 프로세스 정보는 `state.json`에 저장합니다. 자동 연결은 설정한 프로젝트에만 적용하며 자식 세션에는 별도 스레드를 만들지 않습니다. 설정한 Discord 채널이 삭제되면 설정 마법사를 다시 실행하거나 `config.yaml`을 수정하세요. 접근 제한 없는 대체 채널을 알리지 않고 만들지는 않습니다.

이력 조회 간격은 최근 활동에 따라 달라집니다. 활동 후 10초 미만은 1초, 30초 미만은 2초, 60초 미만은 5초, 120초 미만은 10초, 그 이후는 15초입니다. 새 메시지나 변경을 감지하면 다시 빠르게 조회합니다. 이 간격은 전체 조회를 마친 뒤의 대기 시간이며 실제 전달 시간에는 각 세션의 조회·전송 시간도 포함됩니다. `/sync now`는 대기 시간을 건너뛰되 이미 진행 중인 조회가 있으면 그 조회를 기다립니다.

공유 OpenCode 서비스를 설정했다면 모든 프로젝트의 SSE를 해당 서비스에서 받습니다. CLI v2의 `session.step.started` 이벤트도 사용자 메시지 즉시 동기화를 시작합니다. 봇은 최근 OpenCode 응답과 Discord 봇 메시지 시각을 비교해 2분 이상 뒤처지면 해당 스레드에 경고하고 로그를 남깁니다(스레드당 10분에 한 번). 전송 확인 조회는 이력 동기화를 막지 않으며 스레드당 최대 1분에 한 번 실행합니다. 경고만으로 놓친 메시지를 재전송하지는 않습니다. 다른 봇 메시지나 최근 25건 밖의 응답을 시각만으로 완전히 구별할 수는 없습니다. 정확한 복구에는 메시지별 전송 확인 기록이 필요합니다.

`allowedUsers`는 메시지와 승인 버튼을 제한할 뿐 읽기 권한까지 제한하지는 않습니다. 민감한 채널은 Discord에서도 접근을 제한하세요.

연결된 모든 세션에서 **새로 작성한 OpenCode 사용자 메시지**도 해당 Discord 스레드에 자동 전송합니다. 사용자 메시지는 응답과 별도의 저장된 확인 ID로 복구합니다. 기존 기록은 사용자 메시지에 대해 소급 전송하지 않습니다. Discord에서 봇에 보낸 프롬프트는 출처를 표시해 되울림을 방지합니다. 첨부파일을 보내는 구형 프롬프트 경로는 출처 표시가 없어 최근 100개 Discord 메시지의 본문과 60초 이내 시각을 비교합니다. 같은 본문을 터미널에서 반복하면 한 건이 누락될 수 있습니다. `/inspect`는 현재 스레드의 최근 100개 OpenCode 메시지에서 유형별 개수를 표시합니다. 유형을 여러 개 선택하면 최근 5건을 항목당 최대 1,500자로 비공개 조회합니다. 기본 선택은 사용자·응답·생각입니다. 코드 블록은 별도 메시지 유형이 아니라 응답에 포함됩니다. 시스템 메시지와 도구 원문은 자동 전송하지 않으며 `/inspect`에서도 서버 관리자만 볼 수 있습니다. 선택 조회는 자동 전송 설정을 변경하지 않습니다.

모델이 생성하는 reasoning의 언어는 봇이 강제할 수 없습니다. 일부 모델은 영어 reasoning summary를 보냅니다. 한국어 생성이 필수라면 해당 모델의 출력을 실환경에서 검증하기 전 공개 배포하지 마세요.

macOS 백그라운드 서비스는 `pnpm service:*` 스크립트로 관리합니다. 현재 macOS 사용자가 로그인하면 서비스를 시작합니다. `nvm`으로 `.nvmrc`에 지정된 Node.js 버전을 선택하고 이 저장소에서 `node dist/src/cli.js`를 실행합니다. 로그는 `logs/out.log`와 `logs/err.log`에 저장합니다.

서비스를 켜기 전에 `.nvmrc`에 지정된 Node.js 버전과 프로젝트 의존성을 직접 설치하세요.

 ```bash
 nvm install
 nvm use
  pnpm install
  pnpm build
 ```

서비스는 시작할 때 빌드하지 않습니다. Node.js나 `dist/src/cli.js`가 없으면 `logs/err.log`를 확인하고 직접 빌드한 뒤 `pnpm service:restart`를 실행하세요.

실제 운영 시:

1. `config.yaml`, `state.json`, `.cache/`, 로그를 git에 넣지 마세요.
2. 설정한 모든 프로젝트 경로에 안정적으로 접근할 수 있는 컴퓨터에서 봇을 실행하세요.
3. Discord 봇에서 서버 메시지와 메시지 내용을 읽는 데 필요한 인텐트를 켜세요.
4. `permissions: auto`는 설정한 프로젝트에 에이전트를 완전히 신뢰한다는 의미로 취급하세요.

## 패키지 게시

`npm pack --dry-run --json`으로 허용 목록에 포함된 패키지 내용을 확인합니다. npm 배포 구성에는 컴파일된 코드, 실행 스크립트, 예제 설정, 예제 환경 변수 파일, README, LICENSE가 포함됩니다. 로컬 `config.yaml`, `.env`, `state.json`, 백업, 로그를 게시하지 마세요. npm 패키지는 로컬에서 실행하며 호스팅형 Discord 서비스가 아닙니다. Discord 토큰은 git에서 무시하는 `config.yaml`에, 선택적인 공유 서버 비밀번호는 git에서 무시하는 `.env`에 남습니다. `.gitignore`는 이미 추적 중인 파일이나 이력을 지우지 않습니다. Windows에서 깨끗한 환경의 패키지 설치를 확인했지만 다른 컴퓨터에서 Discord와 OpenCode의 최초 설정 과정은 검증하지 않았습니다.

Dis-code는 [joaogsleite/opencode-discord](https://github.com/joaogsleite/opencode-discord)(ISC)를 바탕으로 만들었습니다. 로컬 설정과 개발 메모가 포함되지 않도록 이 저장소는 새 공개 이력으로 시작합니다.

<!-- HUMANIZE-SUMMARY -->
<!--
상태: 완료 / 경로: light / finalize: accept
원본 글자 수: 14337 / 최종 본문 글자 수: 14332
게이트 변경률: 0.02% / 등급: B / 자체검증: 6/6 통과
카테고리: C-11 연결어미 뒤 쉼표
하이라이트: 번역 초안에서 확인한 연결어미 뒤 쉼표 5개만 제거. 코드·설정·수치·URL·명령·경고·조건 보존.
잔존 finding: 확정 finding 0건. A-18 관형절 후보와 E-2 기술 안내 종결 반복은 의미 보존을 위해 유지.
경고: 게이트 경고 없음. 변경률은 영문 원문이 아닌 한국어 번역 초안 기준. npm 게시 및 실제 저장소 수정 없음.
-->
