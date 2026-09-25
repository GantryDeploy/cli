import { input, select } from '@inquirer/prompts'
import type { Command } from 'commander'

import type {
  CreateLoadBalancerMutation,
  CreateLoadBalancerMutationVariables,
  GetLoadBalancersQuery,
  GetLoadBalancersQueryVariables,
  GetLoadBalancerTypesQuery,
  GetLoadBalancerTypesQueryVariables,
  LoadBalancerTypeEnum,
} from '../generated/graphql'
import { formatApiError, graphqlRequest } from '../lib/client'
import { selectCloud, selectNetwork, selectRegion } from '../lib/interactive-prompts'
import { createTable, formatDate, printError, printSuccess, slugify } from '../lib/output'
import { sanitizeTerminal } from '../lib/sanitize'

const LOAD_BALANCER_TYPES = {
  APPLICATION: 'APPLICATION',
  GATEWAY_HTTP: 'GATEWAY_HTTP',
  GLOBAL: 'GLOBAL',
} as const satisfies Record<LoadBalancerTypeEnum, LoadBalancerTypeEnum>

function toLoadBalancerType(value: string): LoadBalancerTypeEnum {
  const match = Object.values(LOAD_BALANCER_TYPES).find((t) => t === value)
  if (!match) {
    throw new Error('Unknown load balancer type.')
  }
  return match
}

const LOAD_BALANCERS_QUERY = /* GraphQL */ `
  query GetLoadBalancers {
    loadBalancers {
      id
      name
      slug
      type
      status
      cloudAccountId
      createdAt
    }
  }
`

const LOAD_BALANCER_TYPES_QUERY = /* GraphQL */ `
  query GetLoadBalancerTypes($provider: String) {
    loadBalancerTypes(provider: $provider) {
      type
      displayName
      provider
      description
      guidance
      requiresNetwork
      requiresRegion
    }
  }
`

const CREATE_LOAD_BALANCER_MUTATION = /* GraphQL */ `
  mutation CreateLoadBalancer($input: CreateLoadBalancerInput!) {
    createLoadBalancer(input: $input) {
      success
      message
      loadBalancer {
        id
        name
        slug
        type
        status
      }
      deploymentId
    }
  }
`

export function registerLoadBalancersCommand(program: Command): void {
  const lbCmd = program.command('load-balancers').alias('lb').description('Manage load balancers')

  lbCmd
    .command('list')
    .description('List all load balancers')
    .action(async () => {
      try {
        const data = await graphqlRequest<GetLoadBalancersQuery, GetLoadBalancersQueryVariables>(
          LOAD_BALANCERS_QUERY
        )
        const { loadBalancers } = data

        if (loadBalancers.length === 0) {
          console.log('No load balancers found.')
          return
        }

        const table = createTable({
          head: ['ID', 'Name', 'Slug', 'Type', 'Status', 'Created'],
        })

        for (const lb of loadBalancers) {
          table.push([
            lb.id,
            lb.name,
            lb.slug,
            lb.type,
            lb.status.toUpperCase(),
            formatDate(lb.createdAt),
          ])
        }

        console.log(table.toString())
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })

  lbCmd
    .command('types')
    .description('List available load balancer types')
    .action(async () => {
      try {
        const data = await graphqlRequest<
          GetLoadBalancerTypesQuery,
          GetLoadBalancerTypesQueryVariables
        >(LOAD_BALANCER_TYPES_QUERY)

        const table = createTable({
          head: ['Type', 'Name', 'Provider', 'Description', 'Network', 'Region'],
        })

        for (const t of data.loadBalancerTypes) {
          table.push([
            t.type,
            t.displayName,
            t.provider.toUpperCase(),
            t.description,
            t.requiresNetwork ? 'Required' : '-',
            t.requiresRegion ? 'Required' : '-',
          ])
        }

        console.log(table.toString())
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })

  lbCmd
    .command('create')
    .description('Create a new load balancer')
    .option('--cloud <id>', 'Cloud account ID')
    .option('--name <name>', 'Load balancer name')
    .option('--slug <slug>', 'Load balancer slug (auto-generated from name if omitted)')
    .option('--type <type>', 'Load balancer type (see "gantry lb types")')
    .option('--network <id>', 'Network ID (required for ALB)')
    .option('--region <region>', 'AWS region (see "gantry regions")')
    .action(
      async (options: {
        cloud?: string
        name?: string
        slug?: string
        type?: string
        network?: string
        region?: string
      }) => {
        try {
          const cloudAccountId = options.cloud ?? (await selectCloud())

          const name =
            options.name ??
            (await input({
              message: 'Load balancer name:',
              validate: (v) => (v.trim().length > 0 ? true : 'Name is required'),
            }))

          let lbType: LoadBalancerTypeEnum
          let requiresNetwork = false
          let requiresRegion = false
          if (options.type) {
            lbType = toLoadBalancerType(options.type)
          } else {
            const typesData = await graphqlRequest<
              GetLoadBalancerTypesQuery,
              GetLoadBalancerTypesQueryVariables
            >(LOAD_BALANCER_TYPES_QUERY)

            lbType = await select({
              message: 'Load balancer type:',
              choices: typesData.loadBalancerTypes.map((t) => ({
                name: sanitizeTerminal(`${t.displayName} — ${t.description}`),
                value: t.type,
              })),
            })

            const selectedType = typesData.loadBalancerTypes.find((t) => t.type === lbType)
            requiresNetwork = selectedType?.requiresNetwork ?? false
            requiresRegion = selectedType?.requiresRegion ?? false
          }

          let networkId = options.network
          if (!networkId && requiresNetwork) {
            networkId = (await selectNetwork(cloudAccountId)) ?? undefined
          } else if (!networkId && !requiresNetwork) {
            networkId = (await selectNetwork(cloudAccountId, { allowNone: true })) ?? undefined
          }

          let region = options.region
          if (!region && requiresRegion) {
            region = await selectRegion()
          }

          // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty --slug string should fall back to the generated slug
          const slug = options.slug || slugify(name)
          const providerData: Record<string, unknown> = {}
          if (region) providerData.region = region

          const data = await graphqlRequest<
            CreateLoadBalancerMutation,
            CreateLoadBalancerMutationVariables
          >(CREATE_LOAD_BALANCER_MUTATION, {
            input: {
              cloudAccountId,
              name,
              slug,
              type: lbType,
              networkId,
              providerData: Object.keys(providerData).length > 0 ? providerData : undefined,
            },
          })

          const result = data.createLoadBalancer
          const loadBalancer = result.loadBalancer
          if (!result.success || !loadBalancer) {
            printError(result.message ?? 'Failed to create load balancer')
            process.exit(1)
          }

          printSuccess(`Load balancer created: ${loadBalancer.name} (${loadBalancer.slug})`)
          console.log(`  ID: ${sanitizeTerminal(loadBalancer.id)}`)
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
