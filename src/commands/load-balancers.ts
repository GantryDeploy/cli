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
  SetLoadBalancerFirewallMutation,
  SetLoadBalancerFirewallMutationVariables,
} from '../generated/graphql'
import { formatApiError, graphqlRequest } from '../lib/client'
import { foreignAwsFlagsMessage, invalidConfiguration, noTypesForCloud } from '../lib/clouds'
import { awsOption } from '../lib/clouds/aws'
import { addExamples } from '../lib/examples'
import { resolveCloud, selectNetwork, selectRegion } from '../lib/interactive-prompts'
import { createTable, formatDate, printError, printSuccess, slugify } from '../lib/output'
import { sanitizeTerminal } from '../lib/sanitize'

const LOAD_BALANCER_TYPES = {
  APPLICATION: 'APPLICATION',
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
      visibility
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

const SET_LOAD_BALANCER_FIREWALL_MUTATION = /* GraphQL */ `
  mutation SetLoadBalancerFirewall($input: SetLoadBalancerFirewallInput!) {
    setLoadBalancerFirewall(input: $input) {
      success
      message
      deploymentId
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
        visibility
        status
      }
      deploymentId
    }
  }
`

export function registerLoadBalancersCommand(program: Command): void {
  const lbCmd = program.command('load-balancers').alias('lb').description('Manage load balancers')

  const listCmd = lbCmd
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
          head: [
            'ID',
            'Name',
            'Slug',
            'Type',
            'Visibility',
            'Region',
            'Endpoint',
            'Status',
            'Created',
          ],
        })

        for (const lb of loadBalancers) {
          table.push([
            lb.id,
            lb.name,
            lb.slug,
            lb.type,
            lb.visibility.toLowerCase(),
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

  const typesCmd = lbCmd
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
          console.log(noTypesForCloud('load balancer'))
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

  const createCmd = lbCmd
    .command('create')
    .description('Create a new load balancer')
    .option('--cloud <id>', 'Cloud account ID')
    .option('--name <name>', 'Load balancer name')
    .option('--slug <slug>', 'Load balancer slug (auto-generated from name if omitted)')
    .option('--type <type>', 'Load balancer type (see "gantry lb types")')
    .option('--network <id>', 'Network ID (required for application load balancers)')
    .option('--region <region>', 'Region (see "gantry regions --cloud <id>")')
    .option(
      '--internal',
      "Take traffic only from inside the network. It can't change to public later, and a CDN can't sit in front of it."
    )
    .addOption(
      awsOption('--aws-certificate-arn <arn>', 'Default certificate for the HTTPS listener')
    )
    .option(
      '--allowed-cidr <cidr>',
      'Address range (CIDR) that may reach the load balancer (repeatable; default: anywhere, or its network when internal)',
      (cidr: string, previous: string[] | undefined) => [...(previous ?? []), cidr]
    )
    .addOption(
      awsOption(
        '--aws-cdn-only',
        'Accept requests from CloudFront. With no --allowed-cidr, nothing else can reach it.'
      )
    )
    .action(
      async (options: {
        cloud?: string
        name?: string
        slug?: string
        type?: string
        network?: string
        region?: string
        internal?: boolean
        awsCertificateArn?: string
        allowedCidr?: string[]
        awsCdnOnly?: boolean
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
            printError(invalidConfiguration('load balancer'))
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
              visibility: options.internal ? 'INTERNAL' : 'PUBLIC',
              networkId,
              region,
              ...(options.allowedCidr ? { allowedCidrs: options.allowedCidr } : {}),
              ...(options.awsCertificateArn || options.awsCdnOnly
                ? {
                    aws: {
                      ...(options.awsCertificateArn
                        ? { defaultSslCertificateArn: options.awsCertificateArn }
                        : {}),
                      ...(options.awsCdnOnly ? { cdnOnly: true } : {}),
                    },
                  }
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
          console.log(`  Visibility: ${loadBalancer.visibility.toLowerCase()}`)
          if (result.deploymentId) {
            console.log(`  Deployment: ${sanitizeTerminal(result.deploymentId)}`)
          }
        } catch (error) {
          printError(formatApiError(error))
          process.exit(1)
        }
      }
    )

  const firewallCmd = lbCmd
    .command('firewall')
    .argument('<load-balancer>', 'Load balancer ID')
    .argument('[firewall]', 'Firewall ID to attach (see "gantry firewalls list")')
    .option('--none', 'Detach the current firewall')
    .description('Attach a firewall to a load balancer, or detach it')
    .action(
      async (
        loadBalancerId: string,
        firewallId: string | undefined,
        options: { none?: boolean }
      ) => {
        try {
          if (Boolean(firewallId) === Boolean(options.none)) {
            printError('Give a firewall ID to attach, or --none to detach.')
            process.exit(1)
          }
          const data = await graphqlRequest<
            SetLoadBalancerFirewallMutation,
            SetLoadBalancerFirewallMutationVariables
          >(SET_LOAD_BALANCER_FIREWALL_MUTATION, {
            input: { id: loadBalancerId, firewallId: firewallId ?? null },
          })
          const result = data.setLoadBalancerFirewall
          if (!result.success) {
            printError(result.message ?? invalidConfiguration('firewall'))
            process.exit(1)
          }
          printSuccess(
            firewallId
              ? 'Firewall attached. It takes effect once it is deployed in the load balancer region.'
              : 'Firewall detached.'
          )
          if (result.deploymentId) {
            console.log(`  Deployment: ${sanitizeTerminal(result.deploymentId)}`)
          }
        } catch (error) {
          printError(formatApiError(error))
          process.exit(1)
        }
      }
    )

  addExamples(lbCmd, [
    { command: 'gantry lb list', description: "List the team's load balancers" },
    {
      command: 'gantry lb types --cloud c4xp9w',
      description: 'List the load balancer types a cloud offers',
    },
  ])
  addExamples(listCmd, [
    { command: 'gantry lb list', description: "List the team's load balancers" },
  ])
  addExamples(typesCmd, [
    {
      command: 'gantry lb types --cloud c4xp9w',
      description: 'List the load balancer types a cloud offers',
    },
  ])
  addExamples(firewallCmd, [
    {
      command: 'gantry lb firewall lb7k2m fw3q9x',
      description: 'Attach a firewall to a load balancer',
    },
    { command: 'gantry lb firewall lb7k2m --none', description: 'Detach its firewall' },
  ])
  addExamples(createCmd, [
    {
      command: 'gantry lb create',
      description: 'Create a load balancer, prompting for each setting',
    },
    {
      command:
        'gantry lb create --cloud c4xp9w --type APPLICATION --network n8kd2q --region us-east-1 --name "Public web"',
      description: 'Create an application load balancer on a network',
    },
    {
      command:
        'gantry lb create --cloud c4xp9w --type APPLICATION --network n8kd2q --name "Internal API" --internal',
      description: 'Create one that takes traffic only from inside the network',
    },
    {
      command:
        'gantry lb create --cloud c4xp9w --type APPLICATION --network n8kd2q --name "Staging" --allowed-cidr 203.0.113.0/24',
      description: 'Create one that only an office range can reach',
    },
  ])
}
