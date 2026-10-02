import { resolveGuild } from '../../src/discord/admin.js';
import { createDiscordAdminRest, loadConfig, parseArgs, printJson, requireFlag, runCli } from './lib.js';

await runCli(async () => {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadConfig();
  const rest = createDiscordAdminRest(config.discordToken);
  const guild = await resolveGuild(rest, requireFlag(args, 'guild'));
  const channels = await rest.listChannels(guild.id);
  printJson(channels.map((channel) => ({ id: channel.id, guildId: channel.guildId, name: channel.name, type: channel.type })));
});
