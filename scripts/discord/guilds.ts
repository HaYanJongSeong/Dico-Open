import { createDiscordAdminRest, loadConfig, printJson, runCli } from './lib.js';

await runCli(async () => {
  const config = await loadConfig();
  const guilds = await createDiscordAdminRest(config.discordToken).listGuilds();
  printJson(guilds);
});
