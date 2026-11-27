import { confirm } from '@inquirer/prompts'
import type { Command } from 'commander'

import type {
  CleanUpMutation,
  CleanUpMutationVariables,
  GetCleanupItemsQuery,
  GetCleanupItemsQueryVariables,
} from '../generated/graphql'
import { formatApiError, graphqlRequest } from '../lib/client'
import { addExamples } from '../lib/examples'
import { createTable, printError, printSuccess } from '../lib/output'
import { sanitizeTerminal } from '../lib/sanitize'
import { isInteractive } from '../lib/terminal'

const CLEANUP_ITEMS_QUERY = /* GraphQL */ `
  query GetCleanupItems {
    cleanupItems {
      id
      kind
      description
      readyToRemove
      hostnames {
        hostname
        dnsMoved
        dnsTarget
      }
    }
  }
`

const CLEAN_UP_MUTATION = /* GraphQL */ `
  mutation CleanUp($ids: [ID!]!) {
    cleanUp(ids: $ids) {
      success
      message
      removed
    }
  }
`

export type CleanupItem = GetCleanupItemsQuery['cleanupItems'][number]

export async function fetchCleanupItems(): Promise<CleanupItem[]> {
  const data = await graphqlRequest<GetCleanupItemsQuery, GetCleanupItemsQueryVariables>(
    CLEANUP_ITEMS_QUERY
  )
  return data.cleanupItems
}

/** Hostnames whose public DNS still resolves to the item, with the target each must point at. */
function hostnamesStillServed(item: CleanupItem): string[] {
  return item.hostnames
    .filter((h) => !h.dnsMoved)
    .map((h) => (h.dnsTarget ? `${h.hostname} (point it at ${h.dnsTarget})` : h.hostname))
}

/** The note `gantry lift` prints when infrastructure is waiting to be cleaned up. */
export function cleanupHint(items: CleanupItem[]): string[] {
  if (items.length === 0) return []
  const noun = items.length === 1 ? 'item is' : 'items are'
  const lines = [
    `${String(items.length)} infrastructure ${noun} waiting to be cleaned up:`,
    ...items.map((item) => `  ${item.description}`),
  ]
  const pending = items.flatMap(hostnamesStillServed)
  if (pending.length > 0) {
    lines.push(`DNS still points at the previous routing for: ${pending.join(', ')}`)
  }
  lines.push('Run "gantry cleanup" once DNS has moved.')
  return lines.map(sanitizeTerminal)
}

function printItems(items: CleanupItem[]): void {
  const table = createTable({ head: ['Item', 'Hostname', 'DNS'] })
  for (const item of items) {
    for (const h of item.hostnames) {
      const dns = h.dnsMoved
        ? 'moved'
        : `not moved${h.dnsTarget ? `, point at ${h.dnsTarget}` : ''}`
      table.push([item.description, h.hostname, dns].map(sanitizeTerminal))
    }
  }
  console.log(table.toString())
}

async function confirmCleanup(items: CleanupItem[], yes: boolean): Promise<boolean> {
  const pending = items.flatMap(hostnamesStillServed)
  const warning =
    pending.length > 0
      ? `Traffic may still reach the previous routing for ${pending.join(', ')}. Removing it stops serving those hostnames there.`
      : undefined
  if (yes) return true
  if (!isInteractive()) {
    printError(`${warning ?? 'This removes the items above.'} Re-run with --yes to confirm.`)
    process.exit(1)
  }
  if (warning) console.log(sanitizeTerminal(warning))
  const noun = items.length === 1 ? 'this item' : `these ${String(items.length)} items`
  return confirm({ message: `Remove ${noun}?`, default: false })
}

export function registerCleanupCommand(program: Command): void {
  const cleanupCmd = program
    .command('cleanup')
    .description('Remove infrastructure no live version uses, such as previous routing')
    .option('-y, --yes', 'Skip the confirmation prompt')
    .action(async (options: { yes?: boolean }) => {
      try {
        const items = await fetchCleanupItems()
        if (items.length === 0) {
          console.log('Nothing to clean up.')
          return
        }

        printItems(items)
        if (!(await confirmCleanup(items, options.yes ?? false))) return

        const { cleanUp } = await graphqlRequest<CleanUpMutation, CleanUpMutationVariables>(
          CLEAN_UP_MUTATION,
          { ids: items.map((item) => item.id) }
        )
        if (!cleanUp.success) {
          printError(cleanUp.message ?? 'There was an error while deleting the routing.')
          process.exit(1)
        }
        const noun = cleanUp.removed.length === 1 ? 'item' : 'items'
        printSuccess(`Removing ${String(cleanUp.removed.length)} ${noun}.`)
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })

  addExamples(cleanupCmd, [
    {
      command: 'gantry cleanup',
      description: 'List unused infrastructure and confirm its removal',
    },
    { command: 'gantry cleanup --yes', description: 'Remove it without the prompt, such as in CI' },
  ])
}
