import { confirm, input } from '@inquirer/prompts'
import type { Command } from 'commander'

import type {
  CreateNetworkMutation,
  CreateNetworkMutationVariables,
  GetNetworksQuery,
  GetNetworksQueryVariables,
  UpdateNetworkInput,
  UpdateNetworkMutation,
  UpdateNetworkMutationVariables,
} from '../generated/graphql'
import { formatApiError, graphqlRequest } from '../lib/client'
import { foreignAwsFlagsMessage, isAws } from '../lib/clouds'
import {
  awsOption,
  buildAwsNetworkSettings,
  buildAwsNetworkUpdate,
  type AwsNetworkFlags,
  type AwsNetworkUpdateFlags,
} from '../lib/clouds/aws'
import { addExamples } from '../lib/examples'
import { resolveCloud, selectRegion } from '../lib/interactive-prompts'
import { buildNetworkSubnets } from '../lib/network-create'
import { createTable, formatDate, printError, printSuccess, slugify } from '../lib/output'
import { repairResource } from '../lib/repair'
import { sanitizeTerminal } from '../lib/sanitize'
import { isInteractive } from '../lib/terminal'

const NETWORKS_QUERY = /* GraphQL */ `
  query GetNetworks {
    networks {
      id
      name
      slug
      region
      provider
      cloudAccountId
      stackStatus
      createdAt
    }
  }
`

const UPDATE_NETWORK_MUTATION = /* GraphQL */ `
  mutation UpdateNetwork($id: String!, $input: UpdateNetworkInput!) {
    updateNetwork(id: $id, input: $input) {
      success
      message
      deploymentId
    }
  }
`

interface NetworkUpdateFlags extends AwsNetworkUpdateFlags {
  name?: string
  slug?: string
  yes?: boolean
}

type Network = GetNetworksQuery['networks'][number]

async function findNetwork(slugOrId: string): Promise<Network | undefined> {
  const { networks } = await graphqlRequest<GetNetworksQuery, GetNetworksQueryVariables>(
    NETWORKS_QUERY
  )
  return networks.find((n) => n.id === slugOrId) ?? networks.find((n) => n.slug === slugOrId)
}

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

interface NetworkCreateFlags extends AwsNetworkFlags {
  subnet: string[]
  cloud?: string
  name?: string
  slug?: string
  region?: string
  cidr?: string
  leastPrivilege?: boolean
}

export function registerNetworksCommand(program: Command): void {
  const networksCmd = program.command('networks').description('Manage networks')

  const listCmd = networksCmd
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

  const createCmd = networksCmd
    .command('create')
    .description('Create a new network')
    .option('--cloud <id>', 'Cloud account ID')
    .option('--name <name>', 'Network name')
    .option('--slug <slug>', 'Network slug (auto-generated from name if omitted)')
    .option('--region <region>', 'Region (see "gantry regions --cloud <id>")')
    .option('--cidr <cidr>', 'Address range (e.g., 10.0.0.0/16)')
    .option(
      '--subnet <type:cidr[:zone]>',
      'Add a subnet, e.g. private:10.0.16.0/20:<zone> (repeatable)',
      (value: string, previous: string[]) => [...previous, value],
      []
    )
    .option('--least-privilege', 'Give databases and caches no network-wide ingress')
    .addOption(awsOption('--aws-nat <option>', 'NAT gateways: none, single or per-az'))
    .addOption(awsOption('--aws-no-internet', 'No internet gateway'))
    .action(async (options: NetworkCreateFlags) => {
      try {
        const cloud = await resolveCloud(options.cloud)
        const foreign = foreignAwsFlagsMessage(cloud.provider, options)
        if (foreign) {
          printError(foreign)
          process.exit(1)
        }
        const aws = isAws(cloud.provider) ? buildAwsNetworkSettings(options) : undefined
        if (aws && !aws.ok) {
          printError(aws.message)
          process.exit(1)
        }
        const region = options.region ?? (await selectRegion(cloud.provider))

        const name =
          options.name ??
          (await input({
            message: 'Network name:',
            validate: (v) => (v.trim().length > 0 ? true : 'Name is required'),
          }))

        // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty --slug string should fall back to the generated slug
        const slug = options.slug || slugify(name)
        const cidr =
          options.cidr ?? (await input({ message: 'Address range:', default: '10.0.0.0/16' }))

        const settings = buildNetworkSubnets(slug, options.subnet)
        if (!settings.ok) {
          printError(settings.message)
          process.exit(1)
        }

        const data = await graphqlRequest<CreateNetworkMutation, CreateNetworkMutationVariables>(
          CREATE_NETWORK_MUTATION,
          {
            input: {
              cloudAccountId: cloud.id,
              name,
              slug,
              region,
              cidr,
              subnets: settings.subnets,
              ...(options.leastPrivilege ? { leastPrivilegeMode: true } : {}),
              ...(aws?.value ? { aws: aws.value } : {}),
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

  const updateCmd = networksCmd
    .command('update')
    .description("Change a network. The address range and subnets can't change.")
    .argument('<slug>', 'Network slug')
    .option('--name <name>', 'New display name')
    .option('--slug <slug>', 'New slug')
    .addOption(awsOption('--aws-nat <option>', 'NAT gateways: none, single or per-az'))
    .addOption(awsOption('--aws-internet', 'Give the network internet access'))
    .addOption(awsOption('--aws-no-internet', 'Remove internet access and its NAT gateways'))
    .option('-y, --yes', 'Skip the confirmation prompt')
    .action(async (slug: string, options: NetworkUpdateFlags) => {
      try {
        const network = await findNetwork(slug)
        if (!network) {
          printError('Network not found.')
          process.exit(1)
        }
        const foreign = foreignAwsFlagsMessage(network.provider, options)
        if (foreign) {
          printError(foreign)
          process.exit(1)
        }

        const input: UpdateNetworkInput = {}
        if (options.name !== undefined) input.name = options.name
        if (options.slug !== undefined) input.slug = options.slug
        const warnings: string[] = []
        if (isAws(network.provider)) {
          const aws = buildAwsNetworkUpdate(options)
          if (!aws.ok) {
            printError(aws.message)
            process.exit(1)
          }
          if (Object.keys(aws.value.aws).length > 0) input.aws = aws.value.aws
          warnings.push(...aws.value.warnings)
        }
        if (Object.keys(input).length === 0) {
          printError('Nothing to change. Pass at least one setting.')
          process.exit(1)
        }

        if (warnings.length > 0 && options.yes !== true) {
          const warning = warnings.join(' ')
          if (!isInteractive()) {
            printError(`${warning} Re-run with --yes to confirm.`)
            process.exit(1)
          }
          console.log(warning)
          if (!(await confirm({ message: `Update "${network.slug}"?`, default: false }))) {
            console.log('Update cancelled.')
            return
          }
        }

        const { updateNetwork: result } = await graphqlRequest<
          UpdateNetworkMutation,
          UpdateNetworkMutationVariables
        >(UPDATE_NETWORK_MUTATION, { id: network.id, input })
        if (!result.success) {
          printError(result.message ?? 'There was an error while updating the network.')
          process.exit(1)
        }
        printSuccess(result.message ?? 'Network updated.')
        if (result.deploymentId) {
          console.log(`  Deployment: ${sanitizeTerminal(result.deploymentId)}`)
        }
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })

  const repairCmd = networksCmd
    .command('repair')
    .description("Apply a network's saved configuration to its infrastructure again")
    .argument('<slug>', 'Network slug')
    .action(async (slug: string) => {
      try {
        const network = await findNetwork(slug)
        if (!network) {
          printError('Network not found.')
          process.exit(1)
        }
        await repairResource('NETWORK', network, 'gantry networks list')
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })

  addExamples(updateCmd, [
    {
      command: 'gantry networks update production-vpc --aws-nat per-az',
      description: 'On AWS, run a NAT gateway in every zone',
    },
    {
      command: 'gantry networks update staging-vpc --name "Staging network"',
      description: 'Rename a network',
    },
  ])
  addExamples(repairCmd, [
    {
      command: 'gantry networks repair production-vpc',
      description: 'Fix a network whose last deploy failed or whose infrastructure drifted',
    },
  ])
  addExamples(networksCmd, [
    { command: 'gantry networks list', description: "List the team's networks" },
    {
      command: 'gantry networks create',
      description: 'Create a network, prompting for each setting',
    },
  ])
  addExamples(listCmd, [
    { command: 'gantry networks list', description: "List the team's networks" },
  ])
  addExamples(createCmd, [
    {
      command: 'gantry networks create',
      description: 'Create a network, prompting for each setting',
    },
    {
      command:
        'gantry networks create --cloud c4xp9w --region us-east-1 --name Production --cidr 10.20.0.0/16 --subnet public:10.20.0.0/24:us-east-1a --subnet private:10.20.16.0/20:us-east-1a',
      description: 'Create a network with one public and one private subnet',
    },
    {
      command:
        'gantry networks create --cloud c4xp9w --region us-east-1 --name Staging --cidr 10.30.0.0/16 --aws-nat single',
      description: 'On AWS, share one NAT gateway across the zones',
    },
  ])
}
