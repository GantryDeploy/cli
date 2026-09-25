import type { Command } from 'commander'

import type { GetCloudRegionsQuery, GetCloudRegionsQueryVariables } from '../generated/graphql'
import { formatApiError, graphqlRequest } from '../lib/client'
import { createTable, printError } from '../lib/output'

const CLOUD_REGIONS_QUERY = /* GraphQL */ `
  query GetCloudRegions($provider: String) {
    cloudRegions(provider: $provider) {
      code
      name
    }
  }
`

export function registerRegionsCommand(program: Command): void {
  program
    .command('regions')
    .description('List available cloud regions')
    .option('--provider <provider>', 'Cloud provider (defaults to aws)', 'aws')
    .action(async (options: { provider: string }) => {
      try {
        const data = await graphqlRequest<GetCloudRegionsQuery, GetCloudRegionsQueryVariables>(
          CLOUD_REGIONS_QUERY,
          { provider: options.provider }
        )

        if (data.cloudRegions.length === 0) {
          console.log('No regions found for this provider.')
          return
        }

        const table = createTable({
          head: ['Code', 'Name'],
        })

        for (const region of data.cloudRegions) {
          table.push([region.code, region.name])
        }

        console.log(table.toString())
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })
}
