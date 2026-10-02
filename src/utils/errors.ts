/** All structured error codes used by the bot. */
export const ErrorCode = {
  CONFIG_INVALID: 'CONFIG_INVALID',
  CONFIG_CHANNEL_NOT_FOUND: 'CONFIG_CHANNEL_NOT_FOUND',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  AGENT_NOT_FOUND: 'AGENT_NOT_FOUND',
  AGENT_SWITCH_DISABLED: 'AGENT_SWITCH_DISABLED',
  AGENT_NOT_ALLOWED: 'AGENT_NOT_ALLOWED',
  MODEL_NOT_FOUND: 'MODEL_NOT_FOUND',
  SERVER_START_FAILED: 'SERVER_START_FAILED',
  SERVER_UNHEALTHY: 'SERVER_UNHEALTHY',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  SESSION_ALREADY_ATTACHED: 'SESSION_ALREADY_ATTACHED',
  PATH_ESCAPE: 'PATH_ESCAPE',
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  GIT_DIRTY: 'GIT_DIRTY',
  GIT_CONFLICT: 'GIT_CONFLICT',
  DISCORD_API_ERROR: 'DISCORD_API_ERROR',
  MCP_NOT_FOUND: 'MCP_NOT_FOUND',
  MCP_CONNECT_FAILED: 'MCP_CONNECT_FAILED',
  CONTEXT_BUFFER_FULL: 'CONTEXT_BUFFER_FULL',
  NO_MESSAGE_TO_RETRY: 'NO_MESSAGE_TO_RETRY',
  NO_MESSAGE_TO_REVERT: 'NO_MESSAGE_TO_REVERT',
  FORK_FAILED: 'FORK_FAILED',
  QUESTION_INVALID_ANSWER: 'QUESTION_INVALID_ANSWER',
  QUESTION_TIMEOUT: 'QUESTION_TIMEOUT',
  PERMISSION_TIMEOUT: 'PERMISSION_TIMEOUT',
  TABLE_RENDER_FAILED: 'TABLE_RENDER_FAILED',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * Structured error class for all bot-thrown errors.
 * @param code - Error code from ErrorCode.
 * @param message - Human-readable error description.
 * @param context - Optional key-value metadata for logging/debugging.
 */
export class BotError extends Error {
  public readonly code: ErrorCode;
  public readonly context: Record<string, unknown>;

  public constructor(code: ErrorCode, message: string, context: Record<string, unknown> = {}) {
    super(message);
    this.name = 'BotError';
    this.code = code;
    this.context = context;
  }
}
