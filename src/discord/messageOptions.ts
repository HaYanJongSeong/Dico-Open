import { MessageFlags } from 'discord.js';

type OutgoingMessageOptions = Record<string, unknown> & { flags?: number };
const LINK_PATTERN = /https?:\/\/\S+/i;

/**
 * Add Discord's SuppressEmbeds flag to an outgoing bot message payload.
 * @param payload - String content or Discord message options.
 * @returns Message options with link previews suppressed.
 */
export function suppressLinkPreviews(payload: string): string | { content: string; flags: MessageFlags.SuppressEmbeds };
export function suppressLinkPreviews<T extends OutgoingMessageOptions>(payload: T): Omit<T, 'flags'> & { flags?: number };
export function suppressLinkPreviews(payload: string | OutgoingMessageOptions): string | { content: string; flags: MessageFlags.SuppressEmbeds } | OutgoingMessageOptions | (Omit<OutgoingMessageOptions, 'flags'> & { flags: number }) {
  if (typeof payload === 'string') {
    if (!LINK_PATTERN.test(payload)) {
      return payload;
    }

    return { content: payload, flags: MessageFlags.SuppressEmbeds };
  }

  if (typeof payload.content !== 'string' || !LINK_PATTERN.test(payload.content)) {
    return payload as Omit<OutgoingMessageOptions, 'flags'> & { flags?: number };
  }

  return {
    ...payload,
    flags: (payload.flags ?? 0) | MessageFlags.SuppressEmbeds,
  };
}
