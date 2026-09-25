import { input } from '@inquirer/prompts'
import type { Command } from 'commander'

import type {
  CreateNetworkMutation,
  CreateNetworkMutationVariables,
  GetNetworksQuery,
  GetNetworksQueryVariables,
} from '../generated/graphql'
import { formatApiError, graphqlRequest } from '../lib/client'
import { selectCloud, selectRegion } from '../lib/interactive-prompts'
import { createTable, formatDate, printError, printSuccess, slugify } from '../lib/output'
import { sanitizeTerminal } from '../lib/sanitize'

const NETWORKS_QUERY = /* GraphQL */ `
  query GetNetworks {
    networks {
      id
      name
      slug
      region
      cloudAccountId
      stackStatus
      createdAt
    }
  }
`

const CREATE_NETWORK_MUTATION = /* GraphQL */ `
  mutation CreateNetwork($input: CreateNetworkInput!) {
    createNetwork(input: $input) {
      success
      message
      network {
        id
        name
        slug
        region
      }
      deploymentId
    }
  }
`

export function registerNetworksCommand(program: Command): void {
  const networksCmd = program.command('networks').description('Manage networks')

  networksCmd
    .command('list')
    .description('List all networks')
    .action(async () => {
      try {
        const data = await graphqlRequest<GetNetworksQuery, GetNetworksQueryVariables>(
          NETWORKS_QUERY
        )
        const { networks } = data

        if (networks.length === 0) {
          console.log('No networks found.')
          return
        }

        const table = createTable({
          head: ['ID', 'Name', 'Slug', 'Region', 'Status', 'Created'],
        })

        for (const network of networks) {
          table.push([
            network.id,
            network.name,
            network.slug,
            network.region,
            (network.stackStatus ?? 'unknown').toUpperCase(),
            formatDate(network.createdAt),
          ])
        }

        console.log(table.toString())
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })

  networksCmd
    .command('create')
    .description('Create a new network')
    .option('--cloud <id>', 'Cloud account ID')
    .option('--name <name>', 'Network name')
    .option('--slug <slug>', 'Network slug (auto-generated from name if omitted)')
    .option('--region <region>', 'AWS region (e.g., us-east-1)')
    .action(async (options: { cloud?: string; name?: string; slug?: string; region?: string }) => {
      try {
        const cloudAccountId = options.cloud ?? (await selectCloud())
        const region = options.region ?? (await selectRegion())

        const name =
          options.name ??
          (await input({
            message: 'Network name:',
            validate: (v) => (v.trim().length > 0 ? true : 'Name is required'),
          }))

        // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty --slug string should fall back to the generated slug
        const slug = options.slug || slugify(name)
        const data = await graphqlRequest<CreateNetworkMutation, CreateNetworkMutationVariables>(
          CREATE_NETWORK_MUTATION,
          {
            input: {
              cloudAccountId,
              name,
              slug,
              region,
            },
          }
        )

        const result = data.createNetwork
        const network = result.network
        if (!result.success || !network) {
          printError(result.message ?? 'Failed to create network')
          process.exit(1)
        }

        printSuccess(`Network created: ${network.name} (${network.slug})`)
        console.log(`  ID: ${sanitizeTerminal(network.id)}`)
        if (result.deploymentId) {
          console.log(`  Deployment: ${sanitizeTerminal(result.deploymentId)}`)
        }
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })
}
