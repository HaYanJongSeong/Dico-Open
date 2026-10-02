import { ensureChannel } from '../../src/discord/admin.js';
import { createDiscordAdminRest, loadConfig, parseArgs, printJson, requireFlag, runCli } from './lib.js';

await runCli(async () => {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadConfig();
  const result = await ensureChannel(createDiscordAdminRest(config.discordToken), {
    guild: requireFlag(args, 'guild'),
    name: requireFlag(args, 'name'),
    yes: args.yes,
  });
  printJson(result);
});
