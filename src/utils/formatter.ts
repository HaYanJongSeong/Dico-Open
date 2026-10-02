const MAX_CHUNK_SIZE = 1800;
const SPOILER_CHUNK_OVERHEAD = 4;
const MAX_CODE_FENCE_LANGUAGE_LENGTH = 64;
const MAX_INLINE_CODE_OUTPUT_LENGTH = 10_000;
const DISCORD_MESSAGE_LIMIT = 2000;
const ZERO_WIDTH_SPACE = '\u200b';

/**
 * Split a message into Discord-safe chunks.
 * @param text - Full message text.
 * @returns Array of message chunks.
 */
export function splitMessage(text: string): string[] {
  const safeText = escapeInlineCodeFenceMarkers(normalizeIndentedCodeFenceLines(text));
  const maxChunkSize = safeText.length > 1200 ? MAX_CHUNK_SIZE - SPOILER_CHUNK_OVERHEAD : MAX_CHUNK_SIZE;
  if (safeText.length <= maxChunkSize) {
    return [safeText];
  }

  const chunks: string[] = [];
  let remaining = safeText;

  while (remaining.length > 0) {
    if (remaining.length <= maxChunkSize) {
      chunks.push(remaining);
      break;
    }

    const splitAt = findSplitPoint(remaining, maxChunkSize);
    let chunk = remaining.slice(0, splitAt);
    const blockState = getCodeBlockState(chunk);

    if (blockState.unclosed) {
      chunk += `\n${blockState.fence}`;
    }

    chunks.push(chunk);
    remaining = remaining.slice(splitAt).trimStart();

    if (blockState.unclosed && remaining.length > 0) {
      remaining = `${blockState.fence}${formatCodeFenceLanguage(blockState.language)}\n${remaining}`;
    }
  }

  return chunks.filter((chunk) => chunk.length > 0);
}

/**
 * Format text as one or more Discord-safe fenced code block messages.
 * @param text - Full code block body.
 * @param language - Markdown code fence language.
 * @param firstPrefix - Optional text to prepend before the first code block.
 * @returns Message chunks containing closed code fences.
 */
export function splitCodeBlockMessages(text: string, language: string, firstPrefix = ''): string[] {
  const truncated = text.length > MAX_INLINE_CODE_OUTPUT_LENGTH
    ? `${text.slice(0, MAX_INLINE_CODE_OUTPUT_LENGTH)}\n... 생략됨`
    : text;
  const safeText = escapeCodeBlockBodyFenceMarkers(truncated);
  const safeLanguage = formatCodeFenceLanguage(language);
  const chunks: string[] = [];
  let remaining = safeText;
  let prefix = firstPrefix;

  do {
    const overhead = prefix.length + 8 + safeLanguage.length;
    const maxBodyLength = Math.max(DISCORD_MESSAGE_LIMIT - overhead, 1);
    const splitAt = remaining.length > maxBodyLength ? findSplitPoint(remaining, maxBodyLength) : remaining.length;
    const body = remaining.slice(0, splitAt);
    chunks.push(`${prefix}\`\`\`${safeLanguage}\n${body}\n\`\`\``);
    remaining = remaining.slice(splitAt).trimStart();
    prefix = '';
  } while (remaining.length > 0);

  return chunks;
}

/**
 * Format text as a single Discord-safe fenced code block message.
 * @param text - Code block body.
 * @param language - Markdown code fence language.
 * @returns Message containing a closed code fence.
 */
export function formatCodeBlockMessage(text: string, language: string): string {
  const safeLanguage = formatCodeFenceLanguage(language);
  return `\`\`\`${safeLanguage}\n${escapeCodeBlockBodyFenceMarkers(text)}\n\`\`\``;
}

function findSplitPoint(text: string, maxLength: number): number {
  const paragraphBreak = text.lastIndexOf('\n\n', maxLength);
  if (paragraphBreak > maxLength * 0.5) {
    return paragraphBreak;
  }

  const newline = text.lastIndexOf('\n', maxLength);
  if (newline > maxLength * 0.5) {
    return newline;
  }

  const space = text.lastIndexOf(' ', maxLength);
  if (space > maxLength * 0.5) {
    return space;
  }

  return maxLength;
}

function getCodeBlockState(text: string): { unclosed: boolean; language: string | null; fence: string } {
  const fences = [...text.matchAll(/^(`{3,})([^`]*)$/gm)];
  if (fences.length % 2 === 0) {
    return { unclosed: false, language: null, fence: '```' };
  }

  const lastFence = fences.at(-1);
  const fence = lastFence?.[1] ?? '```';
  const language = lastFence?.[2]?.trim().split(/\s+/)[0] ?? null;
  return { unclosed: true, language, fence };
}

function formatCodeFenceLanguage(language: string | null): string {
  if (language && language.length <= MAX_CODE_FENCE_LANGUAGE_LENGTH) {
    return language;
  }

  return '';
}

/**
 * Detect if text contains a markdown table.
 * @param text - Text to check.
 * @returns True when a markdown table structure is detected.
 */
export function detectTable(text: string): boolean {
  const lines = text.split('\n');
  if (lines.length < 3) {
    return false;
  }

  for (let index = 0; index < lines.length - 2; index++) {
    const header = lines[index];
    const separator = lines[index + 1];

    if (header?.trim().startsWith('|') && separator?.match(/^\|[\s\-:|]+\|/)) {
      return true;
    }
  }

  return false;
}

/**
 * Format a history message for Discord replay.
 * @param role - Message role.
 * @param content - Message text content.
 * @returns Formatted Discord message string.
 */
export function formatHistoryMessage(role: string, content: string): string {
  if (role === 'user') {
    const quoted = content
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n');
    return `**나:**\n${quoted}`;
  }

  return escapeInlineCodeFenceMarkers(content);
}

function escapeInlineCodeFenceMarkers(text: string): string {
  return text
    .split('\n')
    .map((line) => isCodeFenceLine(line) ? line : line.replaceAll('```', `\`${ZERO_WIDTH_SPACE}\`\``))
    .join('\n');
}

function normalizeIndentedCodeFenceLines(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s+(`{3,}[^`]*)$/, '$1'))
    .join('\n');
}

function escapeCodeBlockBodyFenceMarkers(text: string): string {
  return text.replaceAll('```', `\`${ZERO_WIDTH_SPACE}\`\``);
}

function isCodeFenceLine(line: string): boolean {
  return /^`{3,}[^`]*$/.test(line);
}
