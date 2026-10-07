import { describe, expect, it, vi } from 'vitest';
import { createSyncCommandHandler } from './sync.js';
import { ErrorCode } from '../../utils/errors.js';

function interaction(subcommand: string): any {
  return {
    options: {
      getSubcommand: () => subcommand,
    },
    reply: vi.fn(async () => undefined),
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
  };
}

describe('/sync', () => {
  it('reports status, runs sync, and rejects removed subcommands', async () => {
    const runNow = vi.fn(async () => undefined);
    const controller = { getStatus: () => ({ intervalMinutes: 1, paused: false }), runNow, wake: vi.fn() };
    const status = interaction('status');
    await createSyncCommandHandler(controller)(status, {});
    expect(status.reply).toHaveBeenCalledWith(expect.stringContaining('1분'));
    await createSyncCommandHandler(controller)(interaction('now'), {});
    expect(runNow).toHaveBeenCalledOnce();
    await expect(createSyncCommandHandler(controller)(interaction('pause'), {})).rejects.toMatchObject({ code: ErrorCode.DISCORD_API_ERROR });
  });

  it('reports adaptive sub-minute intervals in seconds', async () => {
    const status = interaction('status');
    await createSyncCommandHandler({ getStatus: () => ({ intervalMinutes: 1 / 60, paused: false }), runNow: vi.fn(), wake: vi.fn() })(status, {});
    expect(status.reply).toHaveBeenCalledWith(expect.stringContaining('1초'));
  });
});
