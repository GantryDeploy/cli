import chalk from 'chalk'
import { InvalidArgumentError } from 'commander'
import type { Command } from 'commander'

import { formatApiError } from './client'
import { printError } from './output'
import { sanitizeTerminal } from './sanitize'

const REFRESH_INTERVAL_MS = 5000
const MAX_LIMIT = 1000

export interface LogPage {
  lines: { timestamp: string; message: string }[]
  cursor: string
}

export interface LogQueryOptions {
  since: string
  limit?: number
  grep?: string
  refresh?: boolean
}

function parseLimit(value: string): number {
  const limit = Number(value)
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new InvalidArgumentError(`Must be a whole number from 1 to ${String(MAX_LIMIT)}.`)
  }
  return limit
}

/** Adds the options every log command shares, read back as `LogQueryOptions`. */
export function withLogQueryOptions(command: Command): Command {
  return command
    .option(
      '--since <duration>',
      'How far back to read: minutes, hours or days (30m, 1h, 2d)',
      '1h'
    )
    .option(
      '--limit <lines>',
      `Most lines to print per page (1 to ${String(MAX_LIMIT)})`,
      parseLimit
    )
    .option('--grep <text>', 'Only lines containing this text, ignoring case')
    .option('--refresh', `Keep printing new lines every ${String(REFRESH_INTERVAL_MS / 1000)}s`)
}

function printLines(page: LogPage): void {
  for (const line of page.lines) {
    process.stdout.write(
      `${chalk.dim(line.timestamp)}  ${sanitizeTerminal(line.message.trimEnd())}\n`
    )
  }
}

/** Resolves after the refresh interval, or as soon as `signal` aborts. */
function waitForNextPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, REFRESH_INTERVAL_MS)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true }
    )
  })
}

/**
 * Prints the first page, then with `refresh` the lines after each page's cursor until Ctrl-C.
 * Exits the process: 0 when done or stopped, 1 when a request fails.
 */
export async function streamLogs(
  fetchPage: (cursor?: string) => Promise<LogPage>,
  refresh: boolean,
  emptyMessage: string
): Promise<never> {
  const fetchOrExit = async (cursor?: string): Promise<LogPage> => {
    try {
      return await fetchPage(cursor)
    } catch (error) {
      printError(formatApiError(error))
      process.exit(1)
    }
  }

  let page = await fetchOrExit()
  printLines(page)

  if (!refresh) {
    if (page.lines.length === 0) {
      process.stderr.write(chalk.dim(`${emptyMessage}\n`))
    }
    process.exit(0)
  }

  process.stderr.write(
    chalk.dim(
      `Showing new lines every ${String(REFRESH_INTERVAL_MS / 1000)}s. Press Ctrl-C to stop.\n`
    )
  )

  const stop = new AbortController()
  const onSigint = () => {
    stop.abort()
  }
  process.once('SIGINT', onSigint)
  try {
    for (;;) {
      await waitForNextPoll(stop.signal)
      if (stop.signal.aborted) break
      page = await fetchOrExit(page.cursor)
      printLines(page)
    }
  } finally {
    process.removeListener('SIGINT', onSigint)
  }
  process.exit(0)
}
