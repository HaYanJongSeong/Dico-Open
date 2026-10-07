import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('Windows PowerShell launcher', () => {
  it('prefers Windows Terminal, chooses PowerShell, and includes a standalone fallback', () => {
    const launcher = readFileSync(new URL('../scripts/start-visible.cmd', import.meta.url), 'utf8');
    expect(launcher).toContain('set "DICO_SHELL=powershell.exe"');
    expect(launcher).toContain('set "DICO_SHELL=pwsh.exe"');
    expect(launcher).toContain('wt.exe -w 0 new-tab --title "Dico-Open"');
    expect(launcher).toContain('if errorlevel 1 goto powershell');
    expect(launcher).toContain('start "Dico-Open" %DICO_SHELL%');
    expect(launcher).toContain('-NoProfile -NoExit -ExecutionPolicy Bypass -File "%~dp0start-visible.ps1"');
  });

  it.skipIf(process.platform !== 'win32')('runs the CLI from its root when paths contain spaces and Korean', () => {
    const root = mkdtempSync(join(tmpdir(), 'dico launcher 한글 '));
    try {
      mkdirSync(join(root, 'scripts'));
      mkdirSync(join(root, 'dist', 'src'), { recursive: true });
      copyFileSync(new URL('../scripts/start-visible.ps1', import.meta.url), join(root, 'scripts', 'start-visible.ps1'));
      writeFileSync(join(root, 'dist', 'src', 'cli.js'), "require('node:fs').writeFileSync('started.json', JSON.stringify({cwd: process.cwd()}));\n");
      const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts', 'start-visible.ps1')], {
        cwd: tmpdir(), encoding: 'utf8', timeout: 15_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(readFileSync(join(root, 'started.json'), 'utf8')).cwd).toBe(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'win32')('retries a failed process and stops after a successful run', () => {
    const root = mkdtempSync(join(tmpdir(), 'dico retry '));
    try {
      mkdirSync(join(root, 'scripts'));
      mkdirSync(join(root, 'dist', 'src'), { recursive: true });
      copyFileSync(new URL('../scripts/start-visible.ps1', import.meta.url), join(root, 'scripts', 'start-visible.ps1'));
      writeFileSync(join(root, 'dist', 'src', 'cli.js'), "const fs = require('node:fs'); const count = fs.existsSync('attempts.txt') ? Number(fs.readFileSync('attempts.txt')) : 0; fs.writeFileSync('attempts.txt', String(count + 1)); if (count === 0) process.stderr.write('simulated startup failure\\n'); process.exit(count === 0 ? 1 : 0);\n");
      const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'scripts', 'start-visible.ps1')], {
        cwd: tmpdir(), encoding: 'utf8', timeout: 15_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(join(root, 'attempts.txt'), 'utf8')).toBe('2');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
