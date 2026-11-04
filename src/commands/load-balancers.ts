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
import { foreignAwsFlagsMessage, unsupportedCloud } from '../lib/clouds'
import { awsOption } from '../lib/clouds/aws'
import { resolveCloud, selectNetwork, selectRegion } from '../lib/interactive-prompts'
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
      region
      endpoint
      status
      cloudAccountId
      createdAt
    }
  }
`

const LOAD_BALANCER_TYPES_QUERY = /* GraphQL */ `
  query GetLoadBalancerTypes($provider: CloudProviderEnum!) {
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
          head: ['ID', 'Name', 'Slug', 'Type', 'Region', 'Endpoint', 'Status', 'Created'],
        })

        for (const lb of loadBalancers) {
          table.push([
            lb.id,
            lb.name,
            lb.slug,
            lb.type,
            lb.region ?? '-',
            lb.endpoint ?? '-',
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
    .option('--cloud <id>', 'Cloud account ID')
    .action(async (options: { cloud?: string }) => {
      try {
        const { provider } = await resolveCloud(options.cloud)
        const data = await graphqlRequest<
          GetLoadBalancerTypesQuery,
          GetLoadBalancerTypesQueryVariables
        >(LOAD_BALANCER_TYPES_QUERY, { provider })
        if (data.loadBalancerTypes.length === 0) {
          console.log(unsupportedCloud('load balancers'))
          return
        }

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
    .option('--network <id>', 'Network ID (required for application load balancers)')
    .option('--region <region>', 'Region (see "gantry regions --cloud <id>")')
    .addOption(
      awsOption('--aws-certificate-arn <arn>', 'Default certificate for the HTTPS listener')
    )
    .action(
      async (options: {
        cloud?: string
        name?: string
        slug?: string
        type?: string
        network?: string
        region?: string
        awsCertificateArn?: string
      }) => {
        try {
          const requestedType = options.type ? toLoadBalancerType(options.type) : undefined
          const cloud = await resolveCloud(options.cloud)
          const foreign = foreignAwsFlagsMessage(cloud.provider, options)
          if (foreign) {
            printError(foreign)
            process.exit(1)
          }

          const { loadBalancerTypes } = await graphqlRequest<
            GetLoadBalancerTypesQuery,
            GetLoadBalancerTypesQueryVariables
          >(LOAD_BALANCER_TYPES_QUERY, { provider: cloud.provider })
          if (loadBalancerTypes.length === 0) {
            printError(unsupportedCloud('load balancers'))
            process.exit(1)
          }

          const name =
            options.name ??
            (await input({
              message: 'Load balancer name:',
              validate: (v) => (v.trim().length > 0 ? true : 'Name is required'),
            }))

          const lbType: LoadBalancerTypeEnum =
            requestedType ??
            (await select({
              message: 'Load balancer type:',
              choices: loadBalancerTypes.map((t) => ({
                name: sanitizeTerminal(`${t.displayName} — ${t.description}`),
                value: t.type,
              })),
            }))
          const selectedType = loadBalancerTypes.find((t) => t.type === lbType)
          if (!selectedType) {
            printError(
              'That load balancer type is not offered on this cloud. See "gantry lb types".'
            )
            process.exit(1)
          }

          const networkId =
            options.network ??
            (await selectNetwork(cloud.id, { allowNone: !selectedType.requiresNetwork }))

          const region =
            options.region ??
            (selectedType.requiresRegion && !networkId
              ? await selectRegion(cloud.provider)
              : undefined)

          // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty --slug string should fall back to the generated slug
          const slug = options.slug || slugify(name)

          const data = await graphqlRequest<
            CreateLoadBalancerMutation,
            CreateLoadBalancerMutationVariables
          >(CREATE_LOAD_BALANCER_MUTATION, {
            input: {
              cloudAccountId: cloud.id,
              name,
              slug,
              type: lbType,
              networkId,
              region,
              ...(options.awsCertificateArn
                ? { aws: { defaultSslCertificateArn: options.awsCertificateArn } }
                : {}),
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
