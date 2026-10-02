import { EmbedBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { ChannelConfig } from '../../config/types.js';
import type { CacheManager } from '../../opencode/cache.js';
import type { QueueEntry, SessionState } from '../../state/types.js';
import { BotError, ErrorCode } from '../../utils/errors.js';
import { suppressLinkPreviews } from '../messageOptions.js';

interface InteractionContext {
  correlationId: string;
  channelConfig?: ChannelConfig;
}

type CommandHandler = (interaction: ChatInputCommandInteraction, context: InteractionContext) => Promise<void>;
const EMBED_FIELD_VALUE_LIMIT = 1024;

interface InfoStateManager {
  getSession(threadId: string): SessionState | undefined;
  getQueue(threadId: string): QueueEntry[];
}

interface StreamStatusProvider {
  getStatus(threadId: string): {
    state: string;
    failures: number;
    lastEventAt?: number;
    lastErrorAt?: number;
    lastDisconnectAt?: number;
  } | undefined;
}

/** Dependencies for the /info command handler. */
export interface InfoCommandDependencies {
  stateManager: InfoStateManager;
  serverManager: { getClient(projectPath: string): unknown };
  cacheManager: Pick<CacheManager, 'getMcpStatus'>;
  streamStatusProvider?: StreamStatusProvider;
  now?: () => number;
}

/**
 * Create a handler for showing session details.
 * @param deps - State, server, and cache dependencies.
 * @returns Discord command handler.
 */
export function createInfoCommandHandler(deps: InfoCommandDependencies): CommandHandler {
  return async (interaction: ChatInputCommandInteraction): Promise<void> => {
    const threadId = requireThreadId(interaction);
    const session = requireSession(deps.stateManager.getSession(threadId), threadId);
    const queueLength = deps.stateManager.getQueue(threadId).length;
    await interaction.deferReply();
    const mcpStatus = deps.cacheManager.getMcpStatus(session.projectPath);
    const usage = await getUsage(deps.serverManager.getClient(session.projectPath), session.sessionId);
    const now = (deps.now ?? Date.now)();
    const embed = new EmbedBuilder()
      .setTitle('세션 정보')
      .setColor(0x5865f2)
      .addFields(
        { name: '세션', value: truncateFieldValue(session.sessionId), inline: true },
        { name: '에이전트', value: truncateFieldValue(session.agent), inline: true },
        { name: '모델', value: truncateFieldValue(session.model ?? '기본값'), inline: true },
        { name: '프로젝트', value: truncateFieldValue(`\`${session.projectPath}\``), inline: false },
        { name: '상태', value: truncateFieldValue(session.status), inline: true },
        { name: '실행 시간', value: truncateFieldValue(formatDuration(now - session.createdAt)), inline: true },
        { name: '대기열', value: String(queueLength), inline: true },
        { name: '스트림', value: truncateFieldValue(formatStreamStatus(deps.streamStatusProvider?.getStatus(threadId), now)), inline: false },
        { name: 'MCP', value: truncateFieldValue(formatMcp(mcpStatus)), inline: false },
        { name: '사용량', value: truncateFieldValue(usage), inline: false },
      );

    await interaction.editReply(suppressLinkPreviews({ embeds: [embed] }));
  };
}

function requireThreadId(interaction: ChatInputCommandInteraction): string {
  if (!(interaction.channel as { parentId?: string | null } | null)?.parentId) {
    throw new BotError(ErrorCode.SESSION_NOT_FOUND, 'This command can only be used in an OpenCode session thread.');
  }

  return interaction.channelId;
}

function requireSession(session: SessionState | undefined, threadId: string): SessionState {
  if (!session || session.status === 'ended') {
    throw new BotError(ErrorCode.SESSION_NOT_FOUND, 'No active OpenCode session is attached to this thread.', { threadId });
  }

  return session;
}

function formatMcp(status: Record<string, unknown>): string {
  const entries = Object.entries(status);
  return entries.length > 0 ? entries.map(([name, value]) => `${name}: ${getStatus(value)}`).join('\n') : '사용 불가';
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}시간 ${minutes}분 ${seconds}초`;
}

function formatStreamStatus(status: ReturnType<StreamStatusProvider['getStatus']>, now: number): string {
  if (!status) {
    return '구독 안 됨';
  }

  const lines = [`상태: ${status.state}`, `실패: ${status.failures}`];
  if (status.lastEventAt !== undefined) {
    lines.push(`마지막 이벤트: ${formatDuration(now - status.lastEventAt)} 전`);
  }
  if (status.lastErrorAt !== undefined) {
    lines.push(`마지막 오류: ${formatDuration(now - status.lastErrorAt)} 전`);
  }
  if (status.lastDisconnectAt !== undefined) {
    lines.push(`마지막 연결 해제: ${formatDuration(now - status.lastDisconnectAt)} 전`);
  }
  return lines.join('\n');
}

function getStatus(value: unknown): string {
  const status = value && typeof value === 'object' ? (value as Record<string, unknown>).status : undefined;
  if (typeof status === 'string') {
    return status;
  }

  return '알 수 없음';
}

function truncateFieldValue(value: string): string {
  const marker = '... 생략됨';
  return value.length <= EMBED_FIELD_VALUE_LIMIT ? value : `${value.slice(0, EMBED_FIELD_VALUE_LIMIT - marker.length)}${marker}`;
}

async function getUsage(client: unknown, sessionId: string): Promise<string> {
  try {
    const messages = await (client as { session?: { messages(options: { sessionID: string }): Promise<unknown> } }).session?.messages({ sessionID: sessionId });
    const unwrapped = unwrapArray(messages);
    const cost = unwrapped.reduce<number>((total, message) => total + getNumber(message, 'cost'), 0);
    const tokens = unwrapped.reduce<number>((total, message) => total + getTokens(message), 0);
    return `토큰: ${tokens}\n비용: $${cost.toFixed(4)}`;
  } catch {
    return '토큰: 사용 불가\n비용: 사용 불가';
  }
}

function unwrapArray(value: unknown): unknown[] {
  const outer = value && typeof value === 'object' && 'data' in value ? value.data : value;
  const data = outer && typeof outer === 'object' && 'data' in outer ? outer.data : outer;
  if (!Array.isArray(data)) throw new Error('OpenCode messages unavailable');
  return data;
}

function getNumber(value: unknown, key: string): number {
  const numberValue = value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
  return typeof numberValue === 'number' ? numberValue : 0;
}

function getTokens(value: unknown): number {
  if (!value || typeof value !== 'object') {
    return 0;
  }

  const tokens = (value as Record<string, unknown>).tokens;
  if (typeof tokens === 'number') {
    return tokens;
  }

  if (tokens && typeof tokens === 'object') {
    return Object.values(tokens).reduce((total, token) => total + (typeof token === 'number' ? token : 0), 0);
  }

  return 0;
}
