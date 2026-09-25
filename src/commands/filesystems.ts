import { input, select } from '@inquirer/prompts'
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
import { selectCloud, selectNetwork } from '../lib/interactive-prompts'
import { createTable, formatDate, printError, printSuccess, slugify } from '../lib/output'
import { sanitizeTerminal } from '../lib/sanitize'

const FILESYSTEMS_QUERY = /* GraphQL */ `
  query GetFilesystems {
    filesystems {
      id
      name
      slug
      type
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
        type
        status
      }
    }
  }
`

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
          head: ['ID', 'Name', 'Slug', 'Type', 'Status', 'Created'],
        })

        for (const fs of filesystems) {
          table.push([
            fs.id,
            fs.name,
            fs.slug,
            fs.type.toUpperCase(),
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
    .action(async (options: { cloud?: string; network?: string; name?: string; slug?: string }) => {
      try {
        const cloudAccountId = options.cloud ?? (await selectCloud())
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

        const performanceMode = await select({
          message: 'Performance mode:',
          choices: [
            { name: 'General Purpose — Recommended for most workloads', value: 'generalPurpose' },
            { name: 'Max I/O — For highly parallelized applications', value: 'maxIO' },
          ],
        })

        const throughputMode = await select({
          message: 'Throughput mode:',
          choices: [
            { name: 'Elastic — Recommended, scales automatically', value: 'elastic' },
            { name: 'Bursting — Scales with storage size', value: 'bursting' },
            { name: 'Provisioned — Fixed throughput', value: 'provisioned' },
          ],
        })

        const encrypted = await select({
          message: 'Enable encryption at rest?',
          choices: [
            { name: 'Yes', value: true },
            { name: 'No', value: false },
          ],
        })

        const spinner = ora('Creating filesystem...').start()

        const data = await graphqlRequest<
          CreateFilesystemMutation,
          CreateFilesystemMutationVariables
        >(CREATE_FILESYSTEM_MUTATION, {
          input: {
            cloudAccountId,
            networkId,
            name,
            slug,
            type: 'EFS',
            providerData: {
              region: selectedNetwork.region,
              performanceMode,
              throughputMode,
              encrypted,
            },
          },
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
