import Table from 'cli-table3'

import { sanitizeTerminal } from './sanitize'

export interface TableOptions {
  head: string[]
}

type TableRow = Table.Table[number]

/**
 * A cell the CLI styled itself, so its escape codes survive the sanitising
 * that every plain string cell goes through.
 */
export function styledCell(content: string): Table.CellOptions {
  return { content }
}

function sanitizeRow(row: TableRow): TableRow {
  if (!Array.isArray(row)) return row
  return row.map((cell) => (typeof cell === 'string' ? sanitizeTerminal(cell) : cell))
}

/**
 * Create a formatted table for CLI output. String cells are stripped of
 * terminal control sequences; wrap CLI-coloured text in `styledCell`.
 */
export function createTable(options: TableOptions): Table.Table {
  const table = new Table({
    head: options.head,
    style: {
      head: ['cyan'],
      border: ['gray'],
    },
    chars: {
      top: '─',
      'top-mid': '┬',
      'top-left': '┌',
      'top-right': '┐',
      bottom: '─',
      'bottom-mid': '┴',
      'bottom-left': '└',
      'bottom-right': '┘',
      left: '│',
      'left-mid': '├',
      mid: '─',
      'mid-mid': '┼',
      right: '│',
      'right-mid': '┤',
      middle: '│',
    },
  })
  const push = table.push.bind(table)
  table.push = (...rows: TableRow[]) => push(...rows.map(sanitizeRow))
  return table
}

export function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

export function printError(message: string): void {
  console.error(`\x1b[31mError:\x1b[0m ${sanitizeTerminal(message)}`)
}

export function printSuccess(message: string): void {
  console.log(`\x1b[32m✓\x1b[0m ${sanitizeTerminal(message)}`)
}

/** Underlined rather than ticked, so summary blocks don't read as deploy steps (which use ✔). */
export function printHeading(message: string): void {
  console.log(`\n\x1b[1m\x1b[4m${sanitizeTerminal(message)}\x1b[0m`)
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export interface TreeNode {
  label: string
  children?: TreeNode[]
}

export function renderTree(nodes: TreeNode[], prefix = ''): string[] {
  const lines: string[] = []

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    const isLast = i === nodes.length - 1
    const connector = isLast ? '└── ' : '├── '
    const childPrefix = isLast ? '    ' : '│   '

    lines.push(`${prefix}${connector}${node.label}`)

    if (node.children?.length) {
      lines.push(...renderTree(node.children, `${prefix}${childPrefix}`))
    }
  }

  return lines
}
