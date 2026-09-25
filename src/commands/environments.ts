import { input, select } from '@inquirer/prompts'
import type { Command } from 'commander'

import type {
  CreateEnvironmentMutation,
  CreateEnvironmentMutationVariables,
  GetEnvironmentProjectsQuery,
  GetEnvironmentProjectsQueryVariables,
  GetEnvironmentsQuery,
  GetEnvironmentsQueryVariables,
} from '../generated/graphql'
import { formatApiError, graphqlRequest } from '../lib/client'
import { selectCloud, selectNetwork, selectProject, selectRegion } from '../lib/interactive-prompts'
import {
  createTable,
  formatDate,
  printError,
  printSuccess,
  slugify,
  styledCell,
} from '../lib/output'
import { sanitizeTerminal } from '../lib/sanitize'

const ENVIRONMENTS_QUERY = /* GraphQL */ `
  query GetEnvironments($projectId: String) {
    environments(projectId: $projectId) {
      id
      projectId
      name
      color
      isProduction
      createdAt
    }
  }
`

const PROJECTS_QUERY = /* GraphQL */ `
  query GetEnvironmentProjects {
    projects {
      id
      name
    }
  }
`

const CREATE_ENVIRONMENT_MUTATION = /* GraphQL */ `
  mutation CreateEnvironment($input: CreateEnvironmentInput!) {
    createEnvironment(input: $input) {
      success
      message
      environment {
        id
        name
        createdAt
      }
    }
  }
`

export function registerEnvironmentsCommand(program: Command): void {
  const envsCmd = program.command('envs').alias('environments').description('Manage environments')

  envsCmd
    .command('list')
    .description('List all environments')
    .option('-p, --project <id>', 'Filter by project ID')
    .action(async (options: { project?: string }) => {
      try {
        const variables = options.project ? { projectId: options.project } : {}
        const [envsData, projectsData] = await Promise.all([
          graphqlRequest<GetEnvironmentsQuery, GetEnvironmentsQueryVariables>(
            ENVIRONMENTS_QUERY,
            variables
          ),
          graphqlRequest<GetEnvironmentProjectsQuery, GetEnvironmentProjectsQueryVariables>(
            PROJECTS_QUERY
          ),
        ])

        const { environments } = envsData
        const { projects } = projectsData

        if (environments.length === 0) {
          console.log('No environments found.')
          return
        }

        const projectMap = new Map(projects.map((p) => [p.id, p.name]))

        const table = createTable({
          head: ['ID', 'Name', 'Project', 'Production', 'Created'],
        })

        for (const env of environments) {
          const projectName = projectMap.get(env.projectId) ?? 'Unknown'
          table.push([
            env.id,
            env.name,
            `${projectName} (${env.projectId})`,
            styledCell(env.isProduction ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'),
            formatDate(env.createdAt),
          ])
        }

        console.log(table.toString())
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })

  envsCmd
    .command('create')
    .description('Create a new environment')
    .option('--project <id>', 'Project ID')
    .option('--cloud <id>', 'Cloud account ID')
    .option('--region <region>', 'AWS region (e.g., us-east-1)')
    .option('--name <name>', 'Environment name')
    .option('--slug <slug>', 'Environment slug (auto-generated from name if omitted)')
    .option('--network <id>', 'Network ID')
    .option('--color <color>', 'Environment color')
    .option('--production', 'Mark as production environment')
    .action(
      async (options: {
        project?: string
        cloud?: string
        region?: string
        name?: string
        slug?: string
        network?: string
        color?: string
        production?: boolean
      }) => {
        try {
          const projectId = options.project ?? (await selectProject())
          const cloudAccountId = options.cloud ?? (await selectCloud())
          const region = options.region ?? (await selectRegion())

          const name =
            options.name ??
            (await input({
              message: 'Environment name:',
              validate: (v) => (v.trim().length > 0 ? true : 'Name is required'),
            }))

          const networkId =
            options.network ?? (await selectNetwork(cloudAccountId, { allowNone: true }))

          const color =
            (options.color ??
              (await input({
                message: 'Environment color (optional, press Enter to skip):',
              }))) ||
            undefined

          const isProduction =
            options.production ??
            (await select({
              message: 'Is this a production environment?',
              choices: [
                { name: 'No', value: false },
                { name: 'Yes', value: true },
              ],
            }))

          // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty --slug string should fall back to the generated slug
          const slug = options.slug || slugify(name)
          const data = await graphqlRequest<
            CreateEnvironmentMutation,
            CreateEnvironmentMutationVariables
          >(CREATE_ENVIRONMENT_MUTATION, {
            input: {
              projectId,
              cloudAccountId,
              region,
              name,
              slug,
              networkId,
              color,
              isProduction,
            },
          })

          const result = data.createEnvironment
          const environment = result.environment
          if (!result.success || !environment) {
            printError(result.message ?? 'Failed to create environment')
            process.exit(1)
          }

          printSuccess(`Environment created: ${environment.name}`)
          console.log(`  ID: ${sanitizeTerminal(environment.id)}`)
        } catch (error) {
          printError(formatApiError(error))
          process.exit(1)
        }
      }
    )
}
