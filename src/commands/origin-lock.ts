import { confirm } from '@inquirer/prompts'
import type { Command } from 'commander'

import type { GetOriginLockQuery, GetOriginLockQueryVariables } from '../generated/graphql'
import { formatApiError, graphqlRequest } from '../lib/client'
import { addExamples } from '../lib/examples'
import { printError } from '../lib/output'
import { sanitizeTerminal } from '../lib/sanitize'
import { isInteractive } from '../lib/terminal'

const ORIGIN_LOCK_QUERY = /* GraphQL */ `
  query GetOriginLock($hostname: String!) {
    originLock(hostname: $hostname) {
      hostname
      header
      value
    }
  }
`

async function shouldReveal(reveal: boolean): Promise<boolean> {
  if (reveal) return true
  if (!isInteractive()) return false
  return confirm({
    message: 'Print the header value? Anyone with it can skip Cloudflare.',
    default: false,
  })
}

export function registerOriginLockCommand(program: Command): void {
  const originLockCmd = program
    .command('origin-lock')
    .description('Show the request header a locked hostname needs from Cloudflare')

  const showCmd = originLockCmd
    .command('show')
    .argument('<hostname>', 'Hostname as written in gantry.yml')
    .description('Show the header and value Cloudflare must add to requests to a locked hostname')
    .option('--reveal', 'Print the header value without asking')
    .action(async (hostname: string, options: { reveal?: boolean }) => {
      try {
        const { originLock } = await graphqlRequest<
          GetOriginLockQuery,
          GetOriginLockQueryVariables
        >(ORIGIN_LOCK_QUERY, { hostname })
        if (!originLock) {
          console.log(`No live deploy locks ${sanitizeTerminal(hostname)}.`)
          return
        }

        const reveal = await shouldReveal(options.reveal ?? false)
        console.log(`\nOrigin lock: ${sanitizeTerminal(originLock.hostname)}`)
        console.log(`  Header: ${sanitizeTerminal(originLock.header)}`)
        console.log(
          reveal
            ? `  Value:  ${sanitizeTerminal(originLock.value)}`
            : '  Value:  hidden. Re-run with --reveal to print it.'
        )
        console.log(
          `\n  Add a Cloudflare Transform Rule that sets this request header on ${sanitizeTerminal(originLock.hostname)}, and proxy its DNS record.`
        )
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })

  addExamples(originLockCmd, [
    {
      command: 'gantry origin-lock show shop.example.com',
      description: 'Show the header Cloudflare adds to requests to a locked hostname',
    },
  ])
  addExamples(showCmd, [
    {
      command: 'gantry origin-lock show shop.example.com --reveal',
      description: 'Print the header and its value without the prompt',
    },
  ])
}
