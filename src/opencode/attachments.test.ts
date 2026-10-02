import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../utils/errors.js';
import { buildFilePartInput, cleanupOld, cleanupSession, downloadAndSave } from './attachments.js';

function createProjectPath(): string {
  return mkdtempSync(join(tmpdir(), 'opencode-attachments-test-'));
}

describe('attachments', () => {
  const projectPaths: string[] = [];

  afterEach(() => {
    for (const projectPath of projectPaths) {
      rmSync(projectPath, { recursive: true, force: true });
    }
    projectPaths.length = 0;
  });

  it('downloads a Discord attachment immediately and saves it with timestamp, message id, and filename identifiers', async () => {
    const projectPath = createProjectPath();
    projectPaths.push(projectPath);
    const fetchAttachment = vi.fn(async () => new Response(new Uint8Array([104, 101, 108, 108, 111]), {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    }));
    const options = { messageId: 'message-1', threadId: 'thread-1', now: () => 1_700_000_000_000, fetch: fetchAttachment };

    const saved = await downloadAndSave(
      { id: 'attachment-1', url: 'https://cdn.discordapp.com/file.txt', name: 'note.txt', contentType: 'text/plain' },
      projectPath,
      options,
    );

    expect(fetchAttachment).toHaveBeenCalledWith('https://cdn.discordapp.com/file.txt');
    expect(saved.path).toBe(join(projectPath, '.opencode', 'attachments', '1700000000000-message-1-note.txt'));
    expect(saved.mime).toBe('text/plain');
    expect(saved.filename).toBe('note.txt');
    expect(readFileSync(saved.path, 'utf8')).toBe('hello');
  });

  it('throws a BotError when an attachment download fails', async () => {
    const projectPath = createProjectPath();
    projectPaths.push(projectPath);

    await expect(downloadAndSave(
      { id: 'attachment-1', url: 'https://cdn.discordapp.com/file.txt', name: 'note.txt' },
      projectPath,
      { messageId: 'message-1', now: () => 1, fetch: async () => new Response('missing', { status: 404 }) },
    )).rejects.toMatchObject({ code: ErrorCode.DISCORD_API_ERROR });
  });

  it('sanitizes path segments and keeps saved files inside the attachment directory', async () => {
    const projectPath = createProjectPath();
    projectPaths.push(projectPath);

    const saved = await downloadAndSave(
      { id: 'a/../../escaped-id.txt', url: 'https://cdn.discordapp.com/file.txt', name: '../escaped-name.txt' },
      projectPath,
      { now: () => 1_700_000_000_000, fetch: async () => new Response('safe', { status: 200 }) },
    );

    expect(saved.path).toBe(join(projectPath, '.opencode', 'attachments', '1700000000000-escaped-id.txt-escaped-name.txt'));
    expect(existsSync(saved.path)).toBe(true);
    expect(existsSync(join(projectPath, 'escaped-name.txt'))).toBe(false);
  });

  it('wraps attachment body read failures in a BotError', async () => {
    const projectPath = createProjectPath();
    projectPaths.push(projectPath);
    const failingResponse = new Response('ignored', { status: 200 });
    vi.spyOn(failingResponse, 'arrayBuffer').mockRejectedValue(new Error('stream failed'));

    await expect(downloadAndSave(
      { id: 'attachment-1', url: 'https://cdn.discordapp.com/file.txt', name: 'note.txt' },
      projectPath,
      { messageId: 'message-1', now: () => 1, fetch: async () => failingResponse },
    )).rejects.toMatchObject({ code: ErrorCode.DISCORD_API_ERROR });
  });

  it('builds a FilePartInput from a saved path using a file URL', () => {
    const savedPath = join(tmpdir(), 'opencode attachment.txt');

    expect(buildFilePartInput(savedPath, 'text/plain', 'opencode attachment.txt')).toEqual({
      type: 'file',
      mime: 'text/plain',
      url: pathToFileURL(savedPath).href,
      filename: 'opencode attachment.txt',
    });
  });

  it('removes attachments older than the TTL and keeps newer files', async () => {
    const projectPath = createProjectPath();
    projectPaths.push(projectPath);
    const attachmentsDir = join(projectPath, '.opencode', 'attachments');
    const oldPath = join(attachmentsDir, '1000-thread-1-message-1-old.txt');
    const newPath = join(attachmentsDir, '2000-thread-1-message-2-new.txt');
    mkdirSync(attachmentsDir, { recursive: true });
    writeFileSync(oldPath, 'old', { flush: true });
    writeFileSync(newPath, 'new', { flush: true });
    utimesSync(oldPath, new Date(1_000), new Date(1_000));
    utimesSync(newPath, new Date(2_000), new Date(2_000));

    const removed = await cleanupOld(projectPath, 1_500, { now: () => 3_000 });

    expect(removed.map((filePath) => basename(filePath))).toEqual(['1000-thread-1-message-1-old.txt']);
    expect(existsSync(oldPath)).toBe(false);
    expect(existsSync(newPath)).toBe(true);
    expect(statSync(newPath).isFile()).toBe(true);
  });

  it('removes session-specific attachments whose message id segment matches the thread id', async () => {
    const projectPath = createProjectPath();
    projectPaths.push(projectPath);
    const attachmentsDir = join(projectPath, '.opencode', 'attachments');
    const sessionPath = join(attachmentsDir, '1000-thread1-note.txt');
    const otherPath = join(attachmentsDir, '1000-thread2-note.txt');
    const nameOnlyPath = join(attachmentsDir, '1000-other-thread1-note.txt');
    mkdirSync(attachmentsDir, { recursive: true });
    writeFileSync(sessionPath, 'session', { flush: true });
    writeFileSync(otherPath, 'other', { flush: true });
    writeFileSync(nameOnlyPath, 'name-only', { flush: true });

    const removed = await cleanupSession(projectPath, 'thread1');

    expect(removed.map((filePath) => basename(filePath))).toEqual(['1000-thread1-note.txt']);
    expect(existsSync(sessionPath)).toBe(false);
    expect(existsSync(otherPath)).toBe(true);
    expect(existsSync(nameOnlyPath)).toBe(true);
  });
});
