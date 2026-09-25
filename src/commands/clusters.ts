import { input, select } from '@inquirer/prompts'
import type { Command } from 'commander'

import type {
  ClusterTypeEnum,
  CreateClusterMutation,
  CreateClusterMutationVariables,
  GetClustersQuery,
  GetClustersQueryVariables,
  GetClusterTypesQuery,
  GetClusterTypesQueryVariables,
} from '../generated/graphql'
import { formatApiError, graphqlRequest } from '../lib/client'
import { selectCloud, selectNetwork, selectRegion } from '../lib/interactive-prompts'
import { createTable, formatDate, printError, printSuccess, slugify } from '../lib/output'
import { sanitizeTerminal } from '../lib/sanitize'

const CLUSTER_TYPES = { ECS: 'ECS' } as const satisfies Record<ClusterTypeEnum, ClusterTypeEnum>

function toClusterType(value: string): ClusterTypeEnum {
  const match = Object.values(CLUSTER_TYPES).find((t) => t === value)
  if (!match) {
    throw new Error('Unknown cluster type.')
  }
  return match
}

const CLUSTERS_QUERY = /* GraphQL */ `
  query GetClusters {
    clusters {
      id
      name
      slug
      type
      status
      region
      cloudAccountId
      createdAt
    }
  }
`

const CLUSTER_TYPES_QUERY = /* GraphQL */ `
  query GetClusterTypes($provider: String) {
    clusterTypes(provider: $provider) {
      type
      displayName
      provider
      description
      guidance
    }
  }
`

const CREATE_CLUSTER_MUTATION = /* GraphQL */ `
  mutation CreateCluster($input: CreateClusterInput!) {
    createCluster(input: $input) {
      success
      message
      cluster {
        id
        name
        slug
        type
        status
        region
      }
      deploymentId
    }
  }
`

export function registerClustersCommand(program: Command): void {
  const clustersCmd = program.command('clusters').description('Manage clusters')

  clustersCmd
    .command('list')
    .description('List all clusters')
    .action(async () => {
      try {
        const data = await graphqlRequest<GetClustersQuery, GetClustersQueryVariables>(
          CLUSTERS_QUERY
        )
        const { clusters } = data

        if (clusters.length === 0) {
          console.log('No clusters found.')
          return
        }

        const table = createTable({
          head: ['ID', 'Name', 'Slug', 'Type', 'Region', 'Status', 'Created'],
        })

        for (const cluster of clusters) {
          table.push([
            cluster.id,
            cluster.name,
            cluster.slug,
            cluster.type,
            cluster.region,
            cluster.status.toUpperCase(),
            formatDate(cluster.createdAt),
          ])
        }

        console.log(table.toString())
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })

  clustersCmd
    .command('types')
    .description('List available cluster types')
    .action(async () => {
      try {
        const data = await graphqlRequest<GetClusterTypesQuery, GetClusterTypesQueryVariables>(
          CLUSTER_TYPES_QUERY
        )

        const table = createTable({
          head: ['Type', 'Name', 'Provider', 'Description'],
        })

        for (const t of data.clusterTypes) {
          table.push([t.type, t.displayName, t.provider.toUpperCase(), t.description])
        }

        console.log(table.toString())
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })

  clustersCmd
    .command('create')
    .description('Create a new cluster')
    .option('--cloud <id>', 'Cloud account ID')
    .option('--name <name>', 'Cluster name')
    .option('--slug <slug>', 'Cluster slug (auto-generated from name if omitted)')
    .option('--type <type>', 'Cluster type (see "gantry clusters types")')
    .option('--region <region>', 'AWS region (see "gantry regions")')
    .option('--network <id>', 'Network ID')
    .action(
      async (options: {
        cloud?: string
        name?: string
        slug?: string
        type?: string
        region?: string
        network?: string
      }) => {
        try {
          const cloudAccountId = options.cloud ?? (await selectCloud())

          const name =
            options.name ??
            (await input({
              message: 'Cluster name:',
              validate: (v) => (v.trim().length > 0 ? true : 'Name is required'),
            }))

          let clusterType: ClusterTypeEnum
          if (options.type) {
            clusterType = toClusterType(options.type)
          } else {
            const typesData = await graphqlRequest<
              GetClusterTypesQuery,
              GetClusterTypesQueryVariables
            >(CLUSTER_TYPES_QUERY)

            clusterType = await select({
              message: 'Cluster type:',
              choices: typesData.clusterTypes.map((t) => ({
                name: sanitizeTerminal(`${t.displayName} — ${t.description}`),
                value: t.type,
              })),
            })
          }

          const region = options.region ?? (await selectRegion())
          const networkId =
            options.network ?? (await selectNetwork(cloudAccountId, { allowNone: true }))

          // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty --slug string should fall back to the generated slug
          const slug = options.slug || slugify(name)
          const data = await graphqlRequest<CreateClusterMutation, CreateClusterMutationVariables>(
            CREATE_CLUSTER_MUTATION,
            {
              input: {
                cloudAccountId,
                name,
                slug,
                type: clusterType,
                region,
                networkId,
              },
            }
          )

          const result = data.createCluster
          const cluster = result.cluster
          if (!result.success || !cluster) {
            printError(result.message ?? 'Failed to create cluster')
            process.exit(1)
          }

          printSuccess(`Cluster created: ${cluster.name} (${cluster.slug})`)
          console.log(`  ID: ${sanitizeTerminal(cluster.id)}`)
          if (result.deploymentId) {
            console.log(`  Deployment: ${sanitizeTerminal(result.deploymentId)}`)
          }
        } catch (error) {
          printError(formatApiError(error))
          process.exit(1)
        }
      }
    )
}
