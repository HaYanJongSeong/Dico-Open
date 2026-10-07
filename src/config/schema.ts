import { z } from 'zod';

/** Zod schema for a single channel configuration. */
export const channelSchema = z.object({
  channelId: z.string().min(1),
  projectPath: z.string().min(1),
  defaultAgent: z.string().optional(),
  model: z.string().min(1).optional(),
  allowAgentSwitch: z.boolean().default(true),
  allowedAgents: z.array(z.string()).default([]),
  allowedUsers: z.array(z.string()).default([]),
  permissions: z.enum(['auto', 'interactive']).default('auto'),
  questionTimeout: z.number().int().positive().default(300),
  connectHistoryLimit: z.number().int().nonnegative().default(30),
  autoConnect: z.boolean().default(false),
  autoConnectSince: z.iso.datetime({ offset: true }).optional(),
});

/** Zod schema for a Discord server (guild). */
export const serverSchema = z.object({
  serverId: z.string().min(1),
  channels: z.array(channelSchema),
});

/** Root Zod schema for bot configuration. */
export const configSchema = z.object({
  discordToken: z.string().min(1),
  servers: z.array(serverSchema),
});

/** Bot configuration after Zod validation and default application. */
export type ValidatedConfig = z.infer<typeof configSchema>;
