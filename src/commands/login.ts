import { chmodSync, mkdirSync, writeFileSync } from 'fs'
import { dirname } from 'path'

import { password } from '@inquirer/prompts'
import type { Command } from 'commander'

import type { VerifyLoginQuery, VerifyLoginQueryVariables } from '../generated/graphql'
import { AuthenticationError, GantryApiError, graphqlRequest } from '../lib/client'
import { credentialsPath } from '../lib/config'
import { printError, printSuccess } from '../lib/output'
import { readStdin } from '../lib/stdin'

const WHOAMI_QUERY = /* GraphQL */ `
  query VerifyLogin {
    whoami {
      teamIds
      kind
      tokenName
      authenticated
    }
  }
`

interface LoginOptions {
  token?: string
  tokenStdin?: boolean
}

// A 401/403 with GraphQL errors in the body surfaces as a GantryApiError instead of an
// AuthenticationError.
function isRejectedToken(error: unknown): boolean {
  if (error instanceof AuthenticationError) return true
  return error instanceof GantryApiError && (error.statusCode === 401 || error.statusCode === 403)
}

async function readToken(options: LoginOptions): Promise<string> {
  if (options.tokenStdin) return readStdin()
  if (options.token !== undefined) return options.token
  return password({
    message: 'Paste a Gantry API token (gpat_… or gnat_…):',
    mask: true,
  })
}

export function registerLoginCommand(program: Command): void {
  program
    .command('login')
    .description('Save a Gantry API token for this machine')
    .option(
      '--token <token>',
      'Token to save; prompts when omitted. Lands in shell history, prefer --token-stdin'
    )
    .option('--token-stdin', 'Read the token from stdin')
    .action(async (options: LoginOptions) => {
      if (options.tokenStdin && options.token !== undefined) {
        printError('Pass either --token or --token-stdin, not both.')
        process.exit(1)
      }

      const token = (await readToken(options)).trim()

      if (!token) {
        printError('No token given.')
        process.exit(1)
      }

      // Verify with the API before saving so a bad paste fails now. The CLI never checks the
      // token format itself, so a new token kind keeps working.
      let identity: VerifyLoginQuery
      try {
        identity = await graphqlRequest<VerifyLoginQuery, VerifyLoginQueryVariables>(
          WHOAMI_QUERY,
          {},
          { token }
        )
      } catch (error) {
        printError(
          isRejectedToken(error)
            ? 'That token was not accepted.'
            : 'Could not reach the Gantry API to verify the token.'
        )
        process.exit(1)
      }

      const path = credentialsPath()
      try {
        const dir = dirname(path)
        mkdirSync(dir, { recursive: true, mode: 0o700 })
        chmodSync(dir, 0o700)
        writeFileSync(path, `${JSON.stringify({ token }, null, 2)}\n`, { mode: 0o600 })
        chmodSync(path, 0o600)
      } catch {
        printError('Could not write the credentials file.')
        process.exit(1)
      }

      const teamCount = identity.whoami.teamIds.length
      printSuccess(
        `Signed in as ${identity.whoami.tokenName} (${identity.whoami.kind} token, ${String(teamCount)} ${teamCount === 1 ? 'team' : 'teams'})`
      )
      if (teamCount > 1) {
        console.log(
          '\x1b[2mThis token covers several teams. Pass --team on commands that need one.\x1b[0m'
        )
      }
    })
}
