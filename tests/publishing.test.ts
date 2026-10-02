import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('publishing', () => {
  it('ships built entrypoints and excludes local secrets and handoff notes', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      name: string; private?: boolean; repository?: string; main: string; types: string; bin?: Record<string, string>; files?: string[]; scripts: Record<string, string>;
    };
    const ignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');
    expect(pkg.main).toBe('dist/src/index.js');
    expect(pkg.types).toBe('dist/src/index.d.ts');
    expect(pkg.name).toBe('open_cord');
    expect(pkg.repository).toBe('https://github.com/HaYanJongSeong/opencord');
    expect(pkg.private).toBe(true); // Do not publish until release approval.
    expect(pkg.bin?.opencord).toBe('dist/src/cli.js');
    expect(Object.keys(pkg.bin ?? {})).toEqual(['opencord']); // npx open_cord selects the single executable.
    expect(pkg.scripts.build).toBeTruthy();
    expect(pkg.files).toContain('dist/src/');
    expect(pkg.files).toContain('dist/scripts/discord/');
    expect(pkg.files).toContain('opencord.cmd');
    expect(pkg.files).not.toContain('scripts/');
    expect(pkg.scripts['discord:guilds']).toBe('node dist/scripts/discord/guilds.js');
    expect(pkg.files).not.toContain('HANDOFF.md');
    expect(pkg.files).not.toContain('config.yaml');
    expect(ignore).toContain('config.yaml.backup*');
    expect(ignore).toContain('.env*');
    for (const localOnly of ['HANDOFF.md', 'opencode.json', 'opencode.json.backup*', '.opencode/', 'archive/', 'docs/']) {
      expect(ignore).toContain(localOnly);
    }
  });

  it('starts the existing visible Windows launcher from the repository root', () => {
    const launcher = readFileSync(new URL('../opencord.cmd', import.meta.url), 'utf8');
    expect(launcher).toContain('call "%~dp0scripts\\start-visible.cmd"');
  });

  it('does not prefill a maintainer-specific project path in the public setup wizard', () => {
    const setup = readFileSync(new URL('../src/setup.ts', import.meta.url), 'utf8');
    expect(setup).not.toContain(String.raw`C:\\Project\\Default`);
  });
});
