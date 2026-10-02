import { Resvg } from '@resvg/resvg-js';
import * as fs from 'node:fs';
import satori, { type Font } from 'satori';
import { BotError, ErrorCode } from './errors.js';

const backgroundColor = '#2b2d31';
const textColor = '#e0e0e0';
const gridColor = '#40444b';
const cellPaddingX = 16;
const cellPaddingY = 10;
const fontSize = 16;
const rowHeight = 44;
const minColumnWidth = 96;
const maxColumnWidth = 240;

interface TableData {
  headers: string[];
  rows: string[][];
}

interface SatoriElement {
  type: string;
  props: {
    style?: Record<string, string | number>;
    children?: string | SatoriElement | SatoriElement[];
  };
}

/**
 * Renders a markdown table to PNG image data.
 *
 * @param markdownTable - Markdown pipe table to render.
 * @returns PNG image data for the rendered table.
 */
export async function renderTableToPng(markdownTable: string): Promise<Buffer> {
  try {
    const table = parseMarkdownTable(markdownTable);
    const columnWidths = calculateColumnWidths(table);
    const width = columnWidths.reduce((sum, columnWidth) => sum + columnWidth, 0) + 2;
    const height = rowHeight * (table.rows.length + 1) + 2;
    const svg = await satori(buildTableElement(table, columnWidths), {
      width,
      height,
      fonts: [loadFont()],
    });
    const png = new Resvg(svg).render().asPng();

    return Buffer.from(png);
  } catch (error) {
    if (error instanceof BotError) {
      throw error;
    }

    throw new BotError(ErrorCode.TABLE_RENDER_FAILED, 'Failed to render markdown table', { cause: error });
  }
}

function parseMarkdownTable(markdownTable: string): TableData {
  const lines = markdownTable
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const headerLine = lines[0];
  const separatorLine = lines[1];

  if (headerLine === undefined || separatorLine === undefined || !isSeparatorRow(separatorLine)) {
    throw new BotError(ErrorCode.TABLE_RENDER_FAILED, 'Invalid markdown table');
  }

  const headers = splitMarkdownRow(headerLine);
  const rows = lines.slice(2).map((line) => normalizeRow(splitMarkdownRow(line), headers.length));

  return { headers, rows };
}

function isSeparatorRow(line: string): boolean {
  return splitMarkdownRow(line).every((cell) => /^:?-{3,}:?$/.test(cell));
}

function splitMarkdownRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let current = '';
  let escaping = false;

  for (const character of trimmed) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }

    if (character === '\\') {
      escaping = true;
      continue;
    }

    if (character === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }

    current += character;
  }

  if (escaping) {
    current += '\\';
  }

  cells.push(current.trim());
  return cells;
}

function normalizeRow(cells: string[], columnCount: number): string[] {
  return Array.from({ length: columnCount }, (_, index) => cells[index] ?? '');
}

function calculateColumnWidths(table: TableData): number[] {
  return table.headers.map((header, columnIndex) => {
    const values = [header, ...table.rows.map((row) => row[columnIndex] ?? '')];
    const longest = Math.max(...values.map((value) => value.length));

    return Math.min(maxColumnWidth, Math.max(minColumnWidth, longest * 9 + cellPaddingX * 2));
  });
}

function buildTableElement(table: TableData, columnWidths: number[]): SatoriElement {
  const rows = [table.headers, ...table.rows];

  return {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'column',
        backgroundColor,
        color: textColor,
        fontFamily: 'TableRendererSans',
        fontSize,
        borderTop: `1px solid ${gridColor}`,
        borderLeft: `1px solid ${gridColor}`,
      },
      children: rows.map((row, rowIndex) => ({
        type: 'div',
        props: {
          style: {
            display: 'flex',
            flexDirection: 'row',
            height: rowHeight,
          },
          children: row.map((cell, columnIndex) => buildCellElement(cell, columnWidths[columnIndex] ?? minColumnWidth, rowIndex === 0)),
        },
      })),
    },
  };
}

function buildCellElement(cell: string, width: number, isHeader: boolean): SatoriElement {
  return {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        alignItems: 'center',
        width,
        height: rowHeight,
        paddingLeft: cellPaddingX,
        paddingRight: cellPaddingX,
        paddingTop: cellPaddingY,
        paddingBottom: cellPaddingY,
        borderRight: `1px solid ${gridColor}`,
        borderBottom: `1px solid ${gridColor}`,
        backgroundColor,
        color: textColor,
        fontWeight: isHeader ? 700 : 400,
      },
      children: cell,
    },
  };
}

function loadFont(): Font {
  const fontPaths = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf',
    '/System/Library/Fonts/Geneva.ttf',
    'C:\\Windows\\Fonts\\arial.ttf',
  ];
  const fontPath = fontPaths.find((candidate) => fs.existsSync(candidate));

  if (fontPath === undefined) {
    throw new BotError(ErrorCode.TABLE_RENDER_FAILED, 'No supported system font found for table rendering');
  }

  return {
    name: 'TableRendererSans',
    data: fs.readFileSync(fontPath),
    weight: 400,
    style: 'normal',
  };
}
