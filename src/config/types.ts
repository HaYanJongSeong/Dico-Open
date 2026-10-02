/** Configuration for a single Discord channel mapping. */
export interface ChannelConfig {
  channelId: string;
  projectPath: string;
  defaultAgent?: string;
  model?: string;
  allowAgentSwitch?: boolean;
  allowedAgents?: string[];
  allowedUsers?: string[];
  permissions?: 'auto' | 'interactive';
  questionTimeout?: number;
  connectHistoryLimit?: number;
  autoConnect?: boolean;
}

/** Configuration for a Discord server (guild). */
export interface ServerConfig {
  serverId: string;
  channels: ChannelConfig[];
}

/** Root bot configuration. */
export interface BotConfig {
  discordToken: string;
  servers: ServerConfig[];
}
