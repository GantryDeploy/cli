import type { Command } from 'commander'

import type { GetVersionsQuery, GetVersionsQueryVariables } from '../generated/graphql'
import { formatApiError, graphqlRequest } from '../lib/client'
import { selectEnvironment, selectProject } from '../lib/interactive-prompts'
import { createTable, formatDate, printError } from '../lib/output'

const VERSIONS_QUERY = /* GraphQL */ `
  query GetVersions($projectId: String!, $environmentId: String!) {
    versionsByProject(projectId: $projectId, environmentId: $environmentId) {
      id
      number
      gitRef
      createdAt
    }
  }
`

export function registerVersionsCommand(program: Command): void {
  const versionsCmd = program.command('versions').description('Manage versions')

  versionsCmd
    .command('list')
    .description('List versions for a project and environment')
    .option('--project <id>', 'Project ID')
    .option('--environment <id>', 'Environment ID')
    .action(async (options: { project?: string; environment?: string }) => {
      try {
        const projectId = options.project ?? (await selectProject())
        const environmentId = options.environment ?? (await selectEnvironment(projectId))

        const data = await graphqlRequest<GetVersionsQuery, GetVersionsQueryVariables>(
          VERSIONS_QUERY,
          {
            projectId,
            environmentId,
          }
        )
        const versions = data.versionsByProject

        if (versions.length === 0) {
          console.log('No versions found.')
          return
        }

        const table = createTable({
          head: ['ID', 'Version', 'Git Ref', 'Created'],
        })

        for (const version of versions) {
          table.push([
            version.id,
            String(version.number),
            version.gitRef ?? '-',
            formatDate(version.createdAt),
          ])
        }

        console.log(table.toString())
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })
}
