import {
  SlashCommandBuilder,
  type SlashCommandOptionsOnlyBuilder,
  type SlashCommandSubcommandsOnlyBuilder,
} from 'discord.js';

type CommandDefinition = SlashCommandBuilder | SlashCommandOptionsOnlyBuilder | SlashCommandSubcommandsOnlyBuilder;

const commandRegistry = new Map<string, CommandDefinition>([
  [
    'new',
    new SlashCommandBuilder()
      .setName('new')
      .setDescription('새 OpenCode 세션을 만듭니다')
      .addStringOption((option) =>
        option.setName('prompt').setDescription('첫 프롬프트'),
      )
      .addStringOption((option) =>
        option.setName('agent').setDescription('사용할 에이전트').setAutocomplete(true),
      )
      .addStringOption((option) => option.setName('title').setDescription('스레드 제목')),
  ],
  [
    'connect',
    new SlashCommandBuilder()
      .setName('connect')
      .setDescription('기존 OpenCode 세션에 연결합니다')
      .addStringOption((option) =>
        option.setName('session').setDescription('연결할 세션').setRequired(true).setAutocomplete(true),
      )
      .addStringOption((option) => option.setName('title').setDescription('스레드 제목')),
  ],
  [
    'agent',
    new SlashCommandBuilder()
      .setName('agent')
      .setDescription('활성 에이전트를 관리합니다')
      .addSubcommand((subcommand) =>
        subcommand
          .setName('set')
          .setDescription('활성 에이전트를 설정합니다')
          .addStringOption((option) =>
            option.setName('agent').setDescription('사용할 에이전트').setRequired(true).setAutocomplete(true),
          ),
      )
      .addSubcommand((subcommand) => subcommand.setName('list').setDescription('사용 가능한 에이전트를 표시합니다')),
  ],
  [
    'model',
    new SlashCommandBuilder()
      .setName('model')
      .setDescription('활성 모델을 관리합니다')
      .addSubcommand((subcommand) =>
        subcommand
          .setName('set')
          .setDescription('활성 모델을 설정합니다')
          .addStringOption((option) =>
            option.setName('model').setDescription('사용할 모델').setRequired(true).setAutocomplete(true),
          ),
      )
      .addSubcommand((subcommand) => subcommand.setName('list').setDescription('사용 가능한 모델을 표시합니다')),
  ],
  ['interrupt', new SlashCommandBuilder().setName('interrupt').setDescription('활성 세션을 중단합니다')],
  ['info', new SlashCommandBuilder().setName('info').setDescription('세션 정보를 표시합니다')],
  ['inspect', new SlashCommandBuilder().setName('inspect').setDescription('세션 메시지를 유형별로 비공개 조회합니다')],
  ['status', new SlashCommandBuilder().setName('status').setDescription('봇 상태를 표시합니다')],
  [
    'sync',
    new SlashCommandBuilder()
      .setName('sync')
      .setDescription('세션 동기화를 관리합니다')
      .addSubcommand((subcommand) => subcommand.setName('status').setDescription('동기화 상태를 표시합니다'))
      .addSubcommand((subcommand) => subcommand.setName('now').setDescription('지금 동기화합니다')),
  ],
  ['help', new SlashCommandBuilder().setName('help').setDescription('명령 도움말을 표시합니다')],
  ['restart', new SlashCommandBuilder().setName('restart').setDescription('OpenCode 서버를 재시작합니다')],
  ['diff', new SlashCommandBuilder().setName('diff').setDescription('세션 변경 사항을 표시합니다')],
]);

/**
 * Gets all slash command definitions in registration order.
 *
 * @returns Slash command builders for Discord registration.
 */
export function getCommandDefinitions(): SlashCommandBuilder[] {
  return [...commandRegistry.values()] as SlashCommandBuilder[];
}
