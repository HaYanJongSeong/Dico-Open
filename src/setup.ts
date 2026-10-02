import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { Client, GatewayIntentBits, ChannelType } from 'discord.js';
import { parse, stringify } from 'yaml';

type SetupConfig = {
  discordToken: string;
  servers: Array<{ serverId: string; channels: Array<Record<string, unknown>> }>;
};

const configPath = resolve('config.yaml');

async function ask(question: string, fallback?: string): Promise<string> {
  const line = createInterface({ input: stdin, output: stdout });
  const suffix = fallback === undefined ? '' : ` [${fallback}]`;
  const value = (await line.question(`${question}${suffix}: `)).trim();
  line.close();
  return value || fallback || '';
}

async function askSecret(question: string, fallback?: string): Promise<string> {
  if (!stdin.isTTY || !stdin.setRawMode) return await ask(question, fallback);
  stdout.write(`${question}: `);
  stdin.setRawMode(true);
  stdin.resume();
  return await new Promise((resolveSecret) => {
    let value = '';
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n') {
          stdin.setRawMode?.(false);
          stdin.pause();
          stdin.off('data', onData);
          stdout.write('\n');
          resolveSecret(value || fallback || '');
        } else if (char === '\u0003') {
          process.exit(130);
        } else if (char === '\u007f') {
          value = value.slice(0, -1);
        } else {
          value += char;
        }
      }
    };
    stdin.on('data', onData);
  });
}

function readExisting(): SetupConfig | undefined {
  if (!existsSync(configPath)) return undefined;
  try {
    const config = parse(readFileSync(configPath, 'utf8')) as SetupConfig;
    return config?.discordToken ? config : undefined;
  } catch {
    return undefined;
  }
}

async function ensureProjectChannel(client: Client, guildId: string, projectPath: string): Promise<string> {
  const guild = await client.guilds.fetch(guildId);
  const name = basename(projectPath).normalize('NFC').toLowerCase().replace(/\s+/gu, '-').slice(0, 100) || 'project';
  const channels = await guild.channels.fetch();
  const existing = channels.find((channel) => channel?.type === ChannelType.GuildText && channel.name === name);
  if (existing) return existing.id;
  const created = await guild.channels.create({ name, type: ChannelType.GuildText, reason: 'OpenCode Discord 초기 설정' });
  return created.id;
}

async function main(): Promise<void> {
  process.stdout.setDefaultEncoding('utf8');
  console.log('\nOpenCode Discord 초기 설정\n');
  console.log('Discord 봇 토큰과 서버 ID를 입력하면 프로젝트 채널을 자동으로 만듭니다.');
  console.log('토큰은 화면에 표시하지 않습니다.\n');

  const existing = readExisting();
  const token = await askSecret('Discord 봇 토큰', existing?.discordToken);
  if (!token) throw new Error('봇 토큰이 필요합니다.');
  const defaultGuild = existing?.servers[0]?.serverId;
  const guildId = await ask('Discord 서버 ID', defaultGuild);
  if (!guildId) throw new Error('서버 ID가 필요합니다.');

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  console.log('\nDiscord 연결 확인 중...');
  await client.login(token);
  const projects: Array<Record<string, unknown>> = [];
  try {
    do {
      const inputPath = await ask('OpenCode 프로젝트 경로');
      if (!inputPath) throw new Error('OpenCode 프로젝트 경로가 필요합니다.');
      const projectPath = resolve(inputPath);
      const channelId = await ensureProjectChannel(client, guildId, projectPath);
      projects.push({ channelId, projectPath, defaultAgent: 'build', permissions: 'auto', autoConnect: true, connectHistoryLimit: 30 });
      console.log(`채널 연결 완료: ${basename(projectPath)} (${channelId})`);
    } while ((await ask('다른 프로젝트도 추가할까요? (y/N)', 'N')).toLowerCase() === 'y');
  } finally {
    client.destroy();
  }

  if (existsSync(configPath)) copyFileSync(configPath, `${configPath}.backup`);
  writeFileSync(configPath, stringify({ discordToken: token, servers: [{ serverId: guildId, channels: projects }] }), 'utf8');
  console.log('\n설정 저장 완료: config.yaml');
  console.log('실행: pnpm start');
}

main().catch((error: unknown) => {
  console.error(`\n설정 실패: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
