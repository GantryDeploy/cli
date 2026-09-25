import type { Command } from 'commander'

import type { WhoAmIQuery, WhoAmIQueryVariables } from '../generated/graphql'
import { formatApiError, graphqlRequest } from '../lib/client'
import { printError } from '../lib/output'
import { sanitizeTerminal } from '../lib/sanitize'

const WHOAMI_QUERY = /* GraphQL */ `
  query WhoAmI {
    whoami {
      teamId
      teamIds
      kind
      tokenName
      authenticated
      isAdmin
      access {
        resource
        level
      }
    }
  }
`

export function registerWhoamiCommand(program: Command): void {
  program
    .command('whoami')
    .description('Display information about the authenticated user/token')
    .action(async () => {
      try {
        const data = await graphqlRequest<WhoAmIQuery, WhoAmIQueryVariables>(WHOAMI_QUERY)
        const { whoami } = data

        console.log('  \x1b[1mAuthenticated\x1b[0m')
        console.log('')
        console.log(
          `  Token:           \x1b[36m${sanitizeTerminal(whoami.tokenName)}\x1b[0m (${whoami.kind === 'team' ? 'team token' : 'personal token'})`
        )
        console.log(`  Role:            \x1b[36m${whoami.isAdmin ? 'Admin' : 'Member'}\x1b[0m`)

        // Having no team selected is a normal answer; `whoami` itself needs none.
        console.log(
          `  Teams:           \x1b[36m${whoami.teamIds.length > 0 ? whoami.teamIds.join(', ') : 'none'}\x1b[0m`
        )
        const actingOn = whoami.teamId ?? 'not set (pass --team)'
        console.log(`  Acting on:       \x1b[36m${actingOn}\x1b[0m`)
        console.log('')
        console.log(`  \x1b[1mAccess\x1b[0m (${String(whoami.access.length)})`)
        for (const entry of [...whoami.access].sort((a, b) =>
          a.resource.localeCompare(b.resource)
        )) {
          console.log(
            `    \x1b[36m${sanitizeTerminal(entry.resource)}\x1b[0m: ${sanitizeTerminal(entry.level)}`
          )
        }
        console.log('')
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })
}
