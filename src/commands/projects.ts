import { input, select } from '@inquirer/prompts'
import type { Command } from 'commander'

import type {
  CreateProjectMutation,
  CreateProjectMutationVariables,
  GetProjectEnvironmentsQuery,
  GetProjectEnvironmentsQueryVariables,
  GetProjectQuery,
  GetProjectQueryVariables,
  GetProjectsQuery,
  GetProjectsQueryVariables,
} from '../generated/graphql'
import { formatApiError, graphqlRequest } from '../lib/client'
import { createTable, formatDate, printError, printSuccess, styledCell } from '../lib/output'
import { sanitizeTerminal } from '../lib/sanitize'

const PROJECTS_QUERY = /* GraphQL */ `
  query GetProjects {
    projects {
      id
      name
      slug
      tag
      cloudProvider
      createdAt
    }
  }
`

const PROJECT_QUERY = /* GraphQL */ `
  query GetProject($id: String, $slug: String) {
    project(id: $id, slug: $slug) {
      id
      name
      slug
      tag
      cloudProvider
      createdAt
    }
  }
`

const ENVIRONMENTS_QUERY = /* GraphQL */ `
  query GetProjectEnvironments($projectId: String) {
    environments(projectId: $projectId) {
      id
      name
      isProduction
      createdAt
    }
  }
`

const CREATE_PROJECT_MUTATION = /* GraphQL */ `
  mutation CreateProject($input: CreateProjectInput!) {
    createProject(input: $input) {
      success
      message
      project {
        id
        name
        slug
        tag
        cloudProvider
        createdAt
      }
    }
  }
`

async function findProject(idOrSlug: string): Promise<GetProjectQuery['project']> {
  const lookup = (variables: GetProjectQueryVariables) =>
    graphqlRequest<GetProjectQuery, GetProjectQueryVariables>(PROJECT_QUERY, variables)

  const byId = await lookup({ id: idOrSlug })
  if (byId.project) return byId.project
  return (await lookup({ slug: idOrSlug })).project
}

export function registerProjectsCommand(program: Command): void {
  const projectsCmd = program
    .command('projects [idOrSlug]')
    .description('List projects or show project details')
    .action(async (idOrSlug?: string) => {
      try {
        if (idOrSlug) {
          const project = await findProject(idOrSlug)

          if (!project) {
            printError(`Project not found: ${idOrSlug}`)
            process.exit(1)
          }

          console.log(`\nProject: ${sanitizeTerminal(project.name)}`)
          console.log(`  ID:             ${sanitizeTerminal(project.id)}`)
          console.log(`  Slug:           ${sanitizeTerminal(project.slug)}`)
          console.log(`  Cloud Provider: ${sanitizeTerminal(project.cloudProvider ?? '-')}`)
          console.log(`  Tag:            ${sanitizeTerminal(project.tag ?? '-')}`)
          console.log(`  Created:        ${formatDate(project.createdAt)}`)

          const envData = await graphqlRequest<
            GetProjectEnvironmentsQuery,
            GetProjectEnvironmentsQueryVariables
          >(ENVIRONMENTS_QUERY, { projectId: project.id })

          if (envData.environments.length > 0) {
            console.log(`\nEnvironments:`)
            const table = createTable({
              head: ['ID', 'Name', 'Production', 'Created'],
            })
            for (const env of envData.environments) {
              table.push([
                env.id,
                env.name,
                styledCell(env.isProduction ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'),
                formatDate(env.createdAt),
              ])
            }
            console.log(table.toString())
          } else {
            console.log('\nNo environments found.')
          }
        } else {
          const data = await graphqlRequest<GetProjectsQuery, GetProjectsQueryVariables>(
            PROJECTS_QUERY
          )
          const { projects } = data

          if (projects.length === 0) {
            console.log('No projects found.')
            return
          }

          const table = createTable({
            head: ['ID', 'Name', 'Slug', 'Tag', 'Created'],
          })

          for (const project of projects) {
            table.push([
              project.id,
              project.name,
              project.slug,
              project.tag ?? '-',
              formatDate(project.createdAt),
            ])
          }

          console.log(table.toString())
        }
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })

  projectsCmd
    .command('create')
    .description('Create a new project')
    .option('--name <name>', 'Project name')
    .option('--cloud-provider <provider>', 'Cloud provider (aws, gcp, cloudflare)')
    .option('--tag <tag>', 'Project tag')
    .action(async (options: { name?: string; cloudProvider?: string; tag?: string }) => {
      try {
        const name =
          options.name ??
          (await input({
            message: 'Project name:',
            validate: (v) => (v.trim().length > 0 ? true : 'Name is required'),
          }))

        const cloudProvider =
          options.cloudProvider ??
          (await select({
            message: 'Cloud provider:',
            choices: [
              { name: 'AWS', value: 'aws' },
              { name: 'GCP', value: 'gcp' },
              { name: 'Cloudflare', value: 'cloudflare' },
            ],
          }))

        const tag =
          (options.tag ??
            (await input({
              message: 'Project tag (optional, press Enter to skip):',
            }))) ||
          undefined

        const data = await graphqlRequest<CreateProjectMutation, CreateProjectMutationVariables>(
          CREATE_PROJECT_MUTATION,
          {
            input: {
              name,
              cloudProvider,
              tag,
            },
          }
        )

        const result = data.createProject
        const project = result.project
        if (!result.success || !project) {
          printError(result.message ?? 'Failed to create project')
          process.exit(1)
        }

        printSuccess(`Project created: ${project.name} (${project.slug})`)
        console.log(`  ID: ${sanitizeTerminal(project.id)}`)
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })
}
