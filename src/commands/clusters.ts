import { input, select } from '@inquirer/prompts'
import type { Command } from 'commander'

import type {
  CreateClusterMutation,
  CreateClusterMutationVariables,
  GetClustersQuery,
  GetClustersQueryVariables,
  GetClusterTypesQuery,
  GetClusterTypesQueryVariables,
} from '../generated/graphql'
import { formatApiError, graphqlRequest } from '../lib/client'
import { foreignAwsFlagsMessage, isAws, unsupportedCloud } from '../lib/clouds'
import { awsClusterSettings, awsOption } from '../lib/clouds/aws'
import { resolveCloud, selectNetwork, selectRegion } from '../lib/interactive-prompts'
import { createTable, formatDate, printError, printSuccess, slugify } from '../lib/output'
import { sanitizeTerminal } from '../lib/sanitize'

const CLUSTERS_QUERY = /* GraphQL */ `
  query GetClusters {
    clusters {
      id
      name
      slug
      provider
      status
      region
      cloudAccountId
      createdAt
    }
  }
`

const CLUSTER_TYPES_QUERY = /* GraphQL */ `
  query GetClusterTypes($provider: CloudProviderEnum!) {
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
        provider
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
          head: ['ID', 'Name', 'Slug', 'Cloud', 'Region', 'Status', 'Created'],
        })

        for (const cluster of clusters) {
          table.push([
            cluster.id,
            cluster.name,
            cluster.slug,
            cluster.provider,
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
    .option('--cloud <id>', 'Cloud account ID')
    .action(async (options: { cloud?: string }) => {
      try {
        const { provider } = await resolveCloud(options.cloud)
        const data = await graphqlRequest<GetClusterTypesQuery, GetClusterTypesQueryVariables>(
          CLUSTER_TYPES_QUERY,
          { provider }
        )
        if (data.clusterTypes.length === 0) {
          console.log(unsupportedCloud('clusters'))
          return
        }

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
    .option('--region <region>', 'Region (see "gantry regions --cloud <id>")')
    .option('--network <id>', 'Network ID')
    .addOption(
      awsOption(
        '--aws-capacity-provider <type>',
        'Where containers run: fargate, fargate-spot or managed-instances'
      )
    )
    .action(
      async (options: {
        cloud?: string
        name?: string
        slug?: string
        region?: string
        network?: string
        awsCapacityProvider?: string
      }) => {
        try {
          const cloud = await resolveCloud(options.cloud)
          const foreign = foreignAwsFlagsMessage(cloud.provider, options)
          if (foreign) {
            printError(foreign)
            process.exit(1)
          }

          const { clusterTypes } = await graphqlRequest<
            GetClusterTypesQuery,
            GetClusterTypesQueryVariables
          >(CLUSTER_TYPES_QUERY, { provider: cloud.provider })
          const onlyType = clusterTypes.at(0)
          if (!onlyType || !isAws(cloud.provider)) {
            printError(unsupportedCloud('clusters'))
            process.exit(1)
          }

          const name =
            options.name ??
            (await input({
              message: 'Cluster name:',
              validate: (v) => (v.trim().length > 0 ? true : 'Name is required'),
            }))

          const clusterType =
            clusterTypes.length === 1
              ? onlyType.type
              : await select({
                  message: 'Cluster type:',
                  choices: clusterTypes.map((t) => ({
                    name: sanitizeTerminal(`${t.displayName} — ${t.description}`),
                    value: t.type,
                  })),
                })

          const aws = await awsClusterSettings(clusterType, options.awsCapacityProvider)
          if (!aws.ok) {
            printError(aws.message)
            process.exit(1)
          }

          const region = options.region ?? (await selectRegion(cloud.provider))
          const networkId = options.network ?? (await selectNetwork(cloud.id, { allowNone: true }))

          // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty --slug string should fall back to the generated slug
          const slug = options.slug || slugify(name)
          const data = await graphqlRequest<CreateClusterMutation, CreateClusterMutationVariables>(
            CREATE_CLUSTER_MUTATION,
            {
              input: {
                cloudAccountId: cloud.id,
                name,
                slug,
                aws: aws.value,
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
