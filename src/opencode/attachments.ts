import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FilePartInput } from '@opencode-ai/sdk/v2';
import { BotError, ErrorCode } from '../utils/errors.js';

/** Structural Discord attachment data needed for immediate download. */
export interface DiscordAttachmentLike {
  readonly id: string;
  readonly url: string;
  readonly name: string;
  readonly contentType?: string | null;
}

/** Metadata for an attachment saved to local OpenCode storage. */
export interface SavedAttachment {
  readonly path: string;
  readonly mime: string;
  readonly filename: string;
}

/** Optional identifiers and injectable dependencies for attachment downloads. */
export interface DownloadAttachmentOptions {
  readonly messageId?: string;
  readonly now?: () => number;
  readonly fetch?: typeof fetch;
}

/** Optional dependencies for attachment cleanup operations. */
export interface CleanupOptions {
  readonly now?: () => number;
}

function getAttachmentsDir(projectPath: string): string {
  return join(projectPath, '.opencode', 'attachments');
}

function sanitizeFilename(filename: string): string {
  return basename(filename).replaceAll('/', '_').replaceAll('\\', '_');
}

function assertContainedPath(parentPath: string, childPath: string, context: Record<string, unknown>): void {
  const relativePath = relative(resolve(parentPath), resolve(childPath));

  if (relativePath.startsWith('..') || relativePath === '' || resolve(relativePath) === relativePath) {
    throw new BotError(ErrorCode.PATH_ESCAPE, 'Attachment path escapes storage directory.', context);
  }
}

async function listAttachmentPaths(projectPath: string): Promise<string[]> {
  const attachmentsDir = getAttachmentsDir(projectPath);

  try {
    const entries = await readdir(attachmentsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => join(attachmentsDir, entry.name))
      .sort();
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return [];
    }

    throw new BotError(ErrorCode.FILE_NOT_FOUND, 'Failed to read attachment storage.', { projectPath });
  }
}

/**
 * Downloads a Discord attachment before its CDN URL expires and saves it under the project attachment directory.
 * @param attachment - Structural Discord attachment data.
 * @param projectPath - Project root path that owns the OpenCode session.
 * @param options - Optional message/thread identifiers and test hooks.
 * @returns Saved attachment metadata for building prompt file parts.
 */
export async function downloadAndSave(
  attachment: DiscordAttachmentLike,
  projectPath: string,
  options: DownloadAttachmentOptions = {},
): Promise<SavedAttachment> {
  const fetchAttachment = options.fetch ?? fetch;
  let response: Response;

  try {
    response = await fetchAttachment(attachment.url);
  } catch {
    throw new BotError(ErrorCode.DISCORD_API_ERROR, 'Failed to download Discord attachment.', {
      attachmentId: attachment.id,
      url: attachment.url,
    });
  }

  if (!response.ok) {
    throw new BotError(ErrorCode.DISCORD_API_ERROR, 'Failed to download Discord attachment.', {
      attachmentId: attachment.id,
      status: response.status,
      url: attachment.url,
    });
  }

  const filename = sanitizeFilename(attachment.name);
  const timestamp = (options.now ?? Date.now)();
  const messageId = sanitizeFilename(options.messageId ?? attachment.id);
  const attachmentsDir = getAttachmentsDir(projectPath);
  const savedPath = join(attachmentsDir, `${timestamp}-${messageId}-${filename}`);
  assertContainedPath(attachmentsDir, savedPath, { attachmentId: attachment.id, projectPath });
  let bytes: Buffer;

  try {
    bytes = Buffer.from(await response.arrayBuffer());
  } catch {
    throw new BotError(ErrorCode.DISCORD_API_ERROR, 'Failed to read Discord attachment body.', {
      attachmentId: attachment.id,
      url: attachment.url,
    });
  }

  try {
    await mkdir(attachmentsDir, { recursive: true });
    await writeFile(savedPath, bytes);
  } catch {
    throw new BotError(ErrorCode.FILE_NOT_FOUND, 'Failed to save Discord attachment.', {
      attachmentId: attachment.id,
      projectPath,
    });
  }

  return {
    path: savedPath,
    mime: attachment.contentType ?? response.headers.get('content-type') ?? 'application/octet-stream',
    filename,
  };
}

/**
 * Builds an OpenCode SDK file prompt part for a saved attachment path.
 * @param savedPath - Absolute path to the saved attachment.
 * @param mime - MIME type sent to OpenCode.
 * @param filename - Optional original filename.
 * @returns SDK-compatible file part input.
 */
export function buildFilePartInput(savedPath: string, mime = 'application/octet-stream', filename?: string): FilePartInput {
  return {
    type: 'file',
    mime,
    url: pathToFileURL(savedPath).href,
    filename,
  };
}

/**
 * Removes saved attachments older than the provided TTL.
 * @param projectPath - Project root path that owns the attachment directory.
 * @param maxAge - Maximum file age in milliseconds.
 * @param options - Optional clock override for tests.
 * @returns Paths that were removed.
 */
export async function cleanupOld(projectPath: string, maxAge: number, options: CleanupOptions = {}): Promise<string[]> {
  const now = (options.now ?? Date.now)();
  const removed: string[] = [];

  for (const filePath of await listAttachmentPaths(projectPath)) {
    const timestamp = Number.parseInt(basename(filePath).split('-', 1)[0] ?? '', 10);
    if (Number.isFinite(timestamp) && timestamp < now - maxAge) {
      await rm(filePath, { force: true });
      removed.push(filePath);
    }
  }

  return removed;
}

/**
 * Removes saved attachments associated with a Discord thread/session identifier.
 * @param projectPath - Project root path that owns the attachment directory.
 * @param threadId - Thread/session identifier encoded into saved attachment names.
 * @returns Paths that were removed.
 */
export async function cleanupSession(projectPath: string, threadId: string): Promise<string[]> {
  const removed: string[] = [];

  for (const filePath of await listAttachmentPaths(projectPath)) {
    if (basename(filePath).split('-', 3)[1] === threadId) {
      await rm(filePath, { force: true });
      removed.push(filePath);
    }
  }

  return removed;
}
