import { ActionRowBuilder, MessageFlags, PermissionFlagsBits, StringSelectMenuBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { ChannelConfig } from '../../config/types.js';
import type { SessionState } from '../../state/types.js';
import { BotError, ErrorCode } from '../../utils/errors.js';

type Kind = 'user' | 'assistant' | 'reasoning' | 'tool' | 'system' | 'code';
type Entry = { kind: Kind; id: string; content: string };
const kinds: Array<{ value: Kind; label: string; auto: boolean }> = [
  { value: 'user', label: '내 말', auto: true },
  { value: 'assistant', label: '응답', auto: true },
  { value: 'reasoning', label: '생각', auto: true },
  { value: 'tool', label: '도구 원문', auto: false },
  { value: 'system', label: '시스템', auto: false },
  { value: 'code', label: '코드 블록', auto: false },
];

interface InspectDependencies {
  stateManager: { getSession(threadId: string): SessionState | undefined };
  serverManager: { getClient(projectPath: string): unknown };
}

/** Offer an ephemeral type picker, then show recent matching OpenCode entries only to the requester. */
export function createInspectCommandHandler(deps: InspectDependencies) {
  return async (interaction: ChatInputCommandInteraction, context: { channelConfig?: ChannelConfig }): Promise<void> => {
    const session = deps.stateManager.getSession(interaction.channelId);
    if (!session || session.status === 'ended' || !context.channelConfig) {
      throw new BotError(ErrorCode.SESSION_NOT_FOUND, '설정된 OpenCode 세션 스레드에서 사용하세요.');
    }
    const client = deps.serverManager.getClient(session.projectPath) as { session?: { messages(options: { sessionID: string; limit: number }): Promise<unknown> } } | undefined;
    if (!client?.session?.messages) throw new BotError(ErrorCode.SERVER_START_FAILED, 'OpenCode 서버가 실행 중이 아닙니다.');

    await interaction.deferReply({ ephemeral: true });
    const response = await client.session.messages({ sessionID: session.sessionId, limit: 100 });
    const data = response && typeof response === 'object' && 'data' in response ? response.data : response;
    const messages = Array.isArray(data) ? data : data && typeof data === 'object' && 'data' in data ? data.data : undefined;
    if (!Array.isArray(messages)) throw new BotError(ErrorCode.SERVER_START_FAILED, 'OpenCode 메시지 목록을 가져오지 못했습니다.');
    const entries = inspectEntries(messages);
    const picker = new StringSelectMenuBuilder()
      .setCustomId('inspect-types')
      .setPlaceholder('조회할 유형을 선택하세요')
      .setMinValues(1)
      .setMaxValues(kinds.length)
      .addOptions(kinds.map((kind) => ({
        label: `${kind.label} (${entries.filter((entry) => entry.kind === kind.value).length})`,
        value: kind.value,
        description: kind.value === 'code' ? '응답에 포함된 코드 블록, 별도 메시지 유형 아님' : kind.value === 'tool' ? '관리자 전용, 자동 전송은 요약만' : undefined,
        default: kind.auto,
      })));
    const message = await interaction.editReply({
      content: '최근 OpenCode 메시지 100개 기준입니다. 자동 전송: 내 말, 응답, 생각, 도구 요약. 시스템·도구 원문은 자동 전송하지 않습니다. 코드 블록은 응답에 포함됩니다. 유형을 선택하면 최근 5건을 비공개로 조회합니다.',
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(picker)],
    });
    let choice;
    try {
      choice = await message.awaitMessageComponent({
        time: 60_000,
        filter: (selected) => selected.customId === 'inspect-types' && selected.user.id === interaction.user.id,
      });
    } catch {
      await interaction.editReply({ content: '조회 시간이 만료됐습니다. `/inspect`를 다시 사용하세요.', components: [] });
      return;
    }
    if (!choice.isStringSelectMenu()) return;
    const selectedKinds = new Set(choice.values.filter((value): value is Kind => kinds.some((kind) => kind.value === value)));
    if ((selectedKinds.has('system') || selectedKinds.has('tool')) && !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await choice.update({ content: '시스템·도구 원문 조회는 서버 관리자만 사용할 수 있습니다.', components: [] });
      return;
    }
    const selectedEntries = entries.filter((entry) => selectedKinds.has(entry.kind)).slice(0, 5);
    await choice.update({ content: `조회 결과: ${selectedEntries.length}건 (최근 100개 중 최대 5건, 각 항목 1,500자). 코드 블록은 응답과 중복될 수 있습니다.`, components: [] });
    for (const entry of selectedEntries) {
      const label = kinds.find((kind) => kind.value === entry.kind)?.label ?? entry.kind;
      await choice.followUp({
        content: `**${label}** \`${entry.id}\`\n${entry.content.slice(0, 1500) || '(내용 없음)'}`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
    }
  };
}

function inspectEntries(messages: unknown[]): Entry[] {
  const result: Entry[] = [];
  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') continue;
    const message = raw as { id?: string; type?: string; text?: string; content?: Array<{ type?: string; text?: string; synthetic?: boolean; name?: string; state?: { output?: string } }> };
    const id = message.id;
    if (!id) continue;
    if (message.type === 'user' || message.type === 'system') {
      if (message.text) result.push({ kind: message.type, id, content: message.text });
      continue;
    }
    if (message.type !== 'assistant') continue;
    for (const part of message.content ?? []) {
      if (part.synthetic === true) continue;
      if (part.type === 'text' && part.text) {
        result.push({ kind: 'assistant', id, content: part.text });
        for (const block of part.text.match(/```[\s\S]*?```/g) ?? []) result.push({ kind: 'code', id, content: block });
      } else if (part.type === 'reasoning' && part.text) {
        result.push({ kind: 'reasoning', id, content: part.text });
      } else if (part.type === 'tool') {
        result.push({ kind: 'tool', id, content: `${part.name ?? '도구'}: ${part.state?.output ?? '(결과 없음)'}` });
      }
    }
  }
  return result;
}
