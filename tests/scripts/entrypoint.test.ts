import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ENTRYPOINT_PATH = resolve(process.cwd(), 'scripts/entrypoint.sh');

describe('LaunchAgent entrypoint', () => {
  it('waits for Discord connectivity before starting the bot', async () => {
    const script = await readFile(ENTRYPOINT_PATH, 'utf8');

    const waitIndex = script.indexOf('/usr/bin/nc -z discord.com 443');
    const execIndex = script.indexOf('exec "${LOGIN_SHELL}" -lc');

    expect(waitIndex).toBeGreaterThan(-1);
    expect(execIndex).toBeGreaterThan(-1);
    expect(waitIndex).toBeLessThan(execIndex);
  });
});
