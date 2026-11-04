import { input } from '@inquirer/prompts'
import type { Command } from 'commander'
import ora from 'ora'

import type {
  CreateFilesystemMutation,
  CreateFilesystemMutationVariables,
  GetFilesystemNetworksQuery,
  GetFilesystemNetworksQueryVariables,
  GetFilesystemsQuery,
  GetFilesystemsQueryVariables,
} from '../generated/graphql'
import { formatApiError, graphqlRequest } from '../lib/client'
import { foreignAwsFlagsMessage, isAws, unsupportedCloud } from '../lib/clouds'
import { awsFilesystemSettings, awsOption, type AwsFilesystemFlags } from '../lib/clouds/aws'
import { resolveCloud, selectNetwork } from '../lib/interactive-prompts'
import { createTable, formatDate, printError, printSuccess, slugify } from '../lib/output'
import { sanitizeTerminal } from '../lib/sanitize'

const FILESYSTEMS_QUERY = /* GraphQL */ `
  query GetFilesystems {
    filesystems {
      id
      name
      slug
      provider
      region
      status
      cloudAccountId
      networkId
      createdAt
    }
  }
`

const NETWORKS_QUERY = /* GraphQL */ `
  query GetFilesystemNetworks {
    networks {
      id
      name
      region
      provider
      cloudAccountId
    }
  }
`

const CREATE_FILESYSTEM_MUTATION = /* GraphQL */ `
  mutation CreateFilesystem($input: CreateFilesystemInput!) {
    createFilesystem(input: $input) {
      success
      message
      filesystem {
        id
        name
        slug
        provider
        status
      }
    }
  }
`

interface FilesystemCreateFlags extends AwsFilesystemFlags {
  cloud?: string
  network?: string
  name?: string
  slug?: string
}

export function registerFilesystemsCommand(program: Command): void {
  const filesystemsCmd = program.command('filesystems').description('Manage persistent filesystems')

  filesystemsCmd
    .command('list')
    .description('List all filesystems')
    .action(async () => {
      try {
        const data = await graphqlRequest<GetFilesystemsQuery, GetFilesystemsQueryVariables>(
          FILESYSTEMS_QUERY
        )
        const { filesystems } = data

        if (filesystems.length === 0) {
          console.log('No filesystems found.')
          return
        }

        const table = createTable({
          head: ['ID', 'Name', 'Slug', 'Cloud', 'Region', 'Status', 'Created'],
        })

        for (const fs of filesystems) {
          table.push([
            fs.id,
            fs.name,
            fs.slug,
            fs.provider.toUpperCase(),
            fs.region,
            fs.status.toUpperCase(),
            formatDate(fs.createdAt),
          ])
        }

        console.log(table.toString())
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })

  filesystemsCmd
    .command('create')
    .description('Create a new filesystem')
    .option('--cloud <id>', 'Cloud account ID')
    .option('--network <id>', 'Network ID')
    .option('--name <name>', 'Filesystem name')
    .option('--slug <slug>', 'Filesystem slug (auto-generated from name if omitted)')
    .addOption(awsOption('--aws-performance-mode <mode>', 'general-purpose (default) or max-io'))
    .addOption(awsOption('--aws-throughput-mode <mode>', 'elastic, bursting or provisioned'))
    .addOption(
      awsOption('--aws-throughput-mibps <mibps>', 'Throughput for provisioned mode, 1 to 3414')
    )
    .addOption(awsOption('--aws-encrypted', 'Encrypt the filesystem at rest'))
    .action(async (options: FilesystemCreateFlags) => {
      try {
        const cloud = await resolveCloud(options.cloud)
        const foreign = foreignAwsFlagsMessage(cloud.provider, options)
        if (foreign) {
          printError(foreign)
          process.exit(1)
        }
        if (!isAws(cloud.provider)) {
          printError(unsupportedCloud('filesystems'))
          process.exit(1)
        }
        const cloudAccountId = cloud.id
        const networkId = options.network ?? (await selectNetwork(cloudAccountId))

        if (!networkId) {
          printError('A network is required to create a filesystem.')
          process.exit(1)
        }

        const networksData = await graphqlRequest<
          GetFilesystemNetworksQuery,
          GetFilesystemNetworksQueryVariables
        >(NETWORKS_QUERY)
        const selectedNetwork = networksData.networks.find((n) => n.id === networkId)
        if (!selectedNetwork) {
          printError('Selected network not found.')
          process.exit(1)
        }

        const name =
          options.name ??
          (await input({
            message: 'Filesystem name:',
            validate: (v) => (v.trim().length > 0 ? true : 'Name is required'),
          }))

        // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty --slug string should fall back to the generated slug
        const slug = options.slug || slugify(name)

        const settings = await awsFilesystemSettings(options)
        if (!settings.ok) {
          printError(settings.message)
          process.exit(1)
        }
        const aws = settings.value

        const spinner = ora('Creating filesystem...').start()

        const data = await graphqlRequest<
          CreateFilesystemMutation,
          CreateFilesystemMutationVariables
        >(CREATE_FILESYSTEM_MUTATION, {
          input: { cloudAccountId, networkId, name, slug, aws },
        }).finally(() => spinner.stop())

        const result = data.createFilesystem
        const filesystem = result.filesystem
        if (!result.success || !filesystem) {
          printError(result.message ?? 'There was an error while creating the filesystem.')
          process.exit(1)
        }

        printSuccess(`Filesystem created: ${filesystem.name} (${filesystem.slug})`)
        console.log(`  ID: ${sanitizeTerminal(filesystem.id)}`)
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })
}
