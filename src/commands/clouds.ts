import type { Command } from 'commander'

import type { GetCloudsQuery, GetCloudsQueryVariables } from '../generated/graphql'
import { formatApiError, graphqlRequest } from '../lib/client'
import { createTable, formatDate, printError } from '../lib/output'

const CLOUDS_QUERY = /* GraphQL */ `
  query GetClouds {
    clouds {
      id
      name
      provider
      createdAt
    }
  }
`

export function registerCloudsCommand(program: Command): void {
  program
    .command('clouds')
    .description('List all cloud accounts')
    .action(async () => {
      try {
        const data = await graphqlRequest<GetCloudsQuery, GetCloudsQueryVariables>(CLOUDS_QUERY)
        const { clouds } = data

        if (clouds.length === 0) {
          console.log('No cloud accounts found.')
          return
        }

        const table = createTable({
          head: ['ID', 'Name', 'Provider', 'Created'],
        })

        for (const cloud of clouds) {
          table.push([
            cloud.id,
            cloud.name,
            cloud.provider.toUpperCase(),
            formatDate(cloud.createdAt),
          ])
        }

        console.log(table.toString())
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })
}
