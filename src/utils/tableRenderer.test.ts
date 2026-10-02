import { afterEach, describe, expect, it, vi } from 'vitest';
import { BotError, ErrorCode } from './errors.js';
import { renderTableToPng } from './tableRenderer.js';
import satori from 'satori';

vi.mock('satori', async (importOriginal) => {
  const actual = await importOriginal<typeof import('satori')>();
  return {
    ...actual,
    default: vi.fn(actual.default),
  };
});

const pngMagicBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('renderTableToPng', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders a multi-column markdown table to PNG data', async () => {
    const table = `| Name | Status | Count |
| --- | --- | --- |
| Bot | Running | 3 |
| Worker | Idle | 12 |`;

    const result = await renderTableToPng(table);

    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.subarray(0, pngMagicBytes.length)).toEqual(pngMagicBytes);
  });

  it('renders table cells containing special characters to PNG data', async () => {
    const table = `| Input | Output |
| --- | --- |
| Tom & Jerry | <ok> "quoted" |
| Pipe text | A \\| B |`;

    const result = await renderTableToPng(table);

    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.subarray(0, pngMagicBytes.length)).toEqual(pngMagicBytes);
  });

  it('throws a structured error for invalid markdown tables', async () => {
    await expect(renderTableToPng('not a table')).rejects.toMatchObject({
      code: ErrorCode.TABLE_RENDER_FAILED,
    });
    await expect(renderTableToPng('not a table')).rejects.toBeInstanceOf(BotError);
  });

  it('wraps downstream renderer failures in a structured error', async () => {
    vi.mocked(satori).mockRejectedValueOnce(new Error('renderer failed'));

    await expect(renderTableToPng(`| Name | Status |
| --- | --- |
| Bot | Running |`)).rejects.toMatchObject({
      code: ErrorCode.TABLE_RENDER_FAILED,
    });
  });
});
