import { MessageFlags } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { suppressLinkPreviews } from './messageOptions.js';

describe('suppressLinkPreviews', () => {
  it('converts string content into message options with embeds suppressed', () => {
    expect(suppressLinkPreviews('https://example.com')).toEqual({
      content: 'https://example.com',
      flags: MessageFlags.SuppressEmbeds,
    });
  });

  it('leaves string content without links unchanged', () => {
    expect(suppressLinkPreviews('No links here.')).toBe('No links here.');
  });

  it('adds suppress embeds to existing flags', () => {
    expect(suppressLinkPreviews({ content: 'secret https://example.com', flags: MessageFlags.Ephemeral })).toEqual({
      content: 'secret https://example.com',
      flags: MessageFlags.Ephemeral | MessageFlags.SuppressEmbeds,
    });
  });

  it('leaves option payloads without links unchanged', () => {
    const payload = { content: '대기열을 비웠습니다.', flags: MessageFlags.Ephemeral };

    expect(suppressLinkPreviews(payload)).toEqual(payload);
  });

  it('preserves other message option fields', () => {
    const attachment = { name: 'file.txt' };
    const embed = { title: 'Status' };

    expect(suppressLinkPreviews({ content: 'File https://example.com', files: [attachment], embeds: [embed], fetchReply: true })).toEqual({
      content: 'File https://example.com',
      files: [attachment],
      embeds: [embed],
      fetchReply: true,
      flags: MessageFlags.SuppressEmbeds,
    });
  });
});
