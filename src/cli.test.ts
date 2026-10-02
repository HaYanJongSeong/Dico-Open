import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('./index.js', () => ({ runCli: vi.fn(async () => undefined) }));

const previousDirectory = process.cwd();
const previousValue = process.env.TEST_BRIDGE_ENV_FILE;
afterEach(() => {
  process.chdir(previousDirectory);
  if (previousValue === undefined) delete process.env.TEST_BRIDGE_ENV_FILE;
  else process.env.TEST_BRIDGE_ENV_FILE = previousValue;
});

it('loads the local .env before importing the bot', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bridge-env-'));
  try {
    writeFileSync(join(directory, '.env'), 'TEST_BRIDGE_ENV_FILE=loaded\n');
    delete process.env.TEST_BRIDGE_ENV_FILE;
    process.chdir(directory);
    await import('./cli.js');
    expect(process.env.TEST_BRIDGE_ENV_FILE).toBe('loaded');
    const { runCli } = await import('./index.js');
    expect(runCli).toHaveBeenCalledOnce();
  } finally {
    process.chdir(previousDirectory);
    rmSync(directory, { recursive: true, force: true });
  }
});
