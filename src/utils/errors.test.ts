import { describe, it, expect } from 'vitest';
import { BotError, ErrorCode } from './errors.js';

describe('BotError', () => {
  it('creates error with code and message', () => {
    const err = new BotError(ErrorCode.CONFIG_INVALID, 'bad config');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(BotError);
    expect(err.code).toBe(ErrorCode.CONFIG_INVALID);
    expect(err.message).toBe('bad config');
    expect(err.name).toBe('BotError');
  });

  it('accepts optional context record', () => {
    const err = new BotError(ErrorCode.PERMISSION_DENIED, 'no access', {
      userId: '123',
      channelId: '456',
    });
    expect(err.context).toEqual({ userId: '123', channelId: '456' });
  });

  it('has empty context by default', () => {
    const err = new BotError(ErrorCode.SERVER_START_FAILED, 'failed');
    expect(err.context).toEqual({});
  });

  it('is throwable and catchable', () => {
    expect(() => {
      throw new BotError(ErrorCode.SESSION_NOT_FOUND, 'missing');
    }).toThrow(BotError);
  });
});

describe('ErrorCode', () => {
  it('has all required error codes', () => {
    const requiredCodes = [
      'CONFIG_INVALID', 'CONFIG_CHANNEL_NOT_FOUND',
      'PERMISSION_DENIED',
      'AGENT_NOT_FOUND', 'AGENT_SWITCH_DISABLED', 'AGENT_NOT_ALLOWED',
      'MODEL_NOT_FOUND',
      'SERVER_START_FAILED', 'SERVER_UNHEALTHY',
      'SESSION_NOT_FOUND', 'SESSION_ALREADY_ATTACHED',
      'PATH_ESCAPE', 'FILE_NOT_FOUND',
      'GIT_DIRTY', 'GIT_CONFLICT',
      'DISCORD_API_ERROR',
      'MCP_NOT_FOUND', 'MCP_CONNECT_FAILED',
      'CONTEXT_BUFFER_FULL',
      'NO_MESSAGE_TO_RETRY', 'NO_MESSAGE_TO_REVERT',
      'FORK_FAILED',
      'QUESTION_INVALID_ANSWER', 'QUESTION_TIMEOUT',
      'PERMISSION_TIMEOUT',
      'TABLE_RENDER_FAILED',
    ];
    for (const code of requiredCodes) {
      expect(ErrorCode[code as keyof typeof ErrorCode]).toBe(code);
    }
  });
});
