import { select } from '@inquirer/prompts'
import type { Command } from 'commander'

import type {
  CancelDeploymentMutation,
  CancelDeploymentMutationVariables,
  GetDeploymentQuery,
  GetDeploymentQueryVariables,
  GetDeploymentsByVersionQuery,
  GetDeploymentsByVersionQueryVariables,
  GetDeploymentVersionsQuery,
  GetDeploymentVersionsQueryVariables,
} from '../generated/graphql'
import { formatApiError, graphqlRequest } from '../lib/client'
import { selectEnvironment, selectProject } from '../lib/interactive-prompts'
import { createTable, formatDate, printError, printSuccess } from '../lib/output'
import { sanitizeTerminal } from '../lib/sanitize'

const DEPLOYMENT_QUERY = /* GraphQL */ `
  query GetDeployment($id: String!) {
    deployment(id: $id) {
      id
      status
      lastMessage
      environmentId
      environmentName
      projectName
      deploymentType
      startedAt
      completedAt
    }
  }
`

const DEPLOYMENTS_BY_VERSION_QUERY = /* GraphQL */ `
  query GetDeploymentsByVersion($versionId: String!) {
    deploymentsByVersion(versionId: $versionId) {
      id
      status
      lastMessage
      environmentName
      deploymentType
      startedAt
      completedAt
    }
  }
`

const VERSIONS_QUERY = /* GraphQL */ `
  query GetDeploymentVersions($projectId: String!, $environmentId: String!) {
    versionsByProject(projectId: $projectId, environmentId: $environmentId) {
      id
      number
      gitRef
      createdAt
    }
  }
`

const CANCEL_DEPLOYMENT_MUTATION = /* GraphQL */ `
  mutation CancelDeployment($id: String!) {
    cancelDeployment(id: $id) {
      success
      message
    }
  }
`

export function registerDeploymentsCommand(program: Command): void {
  const deploymentsCmd = program.command('deployments').description('Manage deployments')

  deploymentsCmd
    .command('show <id>')
    .description('Show deployment details')
    .action(async (id: string) => {
      try {
        const data = await graphqlRequest<GetDeploymentQuery, GetDeploymentQueryVariables>(
          DEPLOYMENT_QUERY,
          { id }
        )

        if (!data.deployment) {
          printError(`Deployment not found: ${id}`)
          process.exit(1)
        }

        const d = data.deployment
        console.log(`\nDeployment: ${sanitizeTerminal(d.id)}`)
        console.log(`  Status:      ${sanitizeTerminal(d.status.toUpperCase())}`)
        console.log(`  Type:        ${sanitizeTerminal(d.deploymentType ?? '-')}`)
        console.log(`  Project:     ${sanitizeTerminal(d.projectName ?? '-')}`)
        console.log(`  Environment: ${sanitizeTerminal(d.environmentName ?? '-')}`)
        console.log(`  Message:     ${sanitizeTerminal(d.lastMessage ?? '-')}`)
        console.log(`  Started:     ${formatDate(d.startedAt)}`)
        console.log(`  Completed:   ${d.completedAt ? formatDate(d.completedAt) : '-'}`)
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })

  deploymentsCmd
    .command('list')
    .description('List deployments for a version')
    .option('--version <id>', 'Version ID')
    .option('--project <id>', 'Project ID (used to find version interactively)')
    .option('--environment <id>', 'Environment ID (used to find version interactively)')
    .action(async (options: { version?: string; project?: string; environment?: string }) => {
      try {
        let versionId = options.version
        if (!versionId) {
          const projectId = options.project ?? (await selectProject())
          const environmentId = options.environment ?? (await selectEnvironment(projectId))

          const versionsData = await graphqlRequest<
            GetDeploymentVersionsQuery,
            GetDeploymentVersionsQueryVariables
          >(VERSIONS_QUERY, { projectId, environmentId })

          if (versionsData.versionsByProject.length === 0) {
            console.log('No versions found.')
            return
          }

          versionId = await select({
            message: 'Select a version:',
            choices: versionsData.versionsByProject.map((v) => ({
              name: `v${String(v.number)}${v.gitRef ? ` (${v.gitRef})` : ''}`,
              value: v.id,
            })),
          })
        }

        const data = await graphqlRequest<
          GetDeploymentsByVersionQuery,
          GetDeploymentsByVersionQueryVariables
        >(DEPLOYMENTS_BY_VERSION_QUERY, { versionId })
        const deployments = data.deploymentsByVersion

        if (deployments.length === 0) {
          console.log('No deployments found.')
          return
        }

        const table = createTable({
          head: ['ID', 'Status', 'Type', 'Environment', 'Started', 'Completed'],
        })

        for (const d of deployments) {
          table.push([
            d.id,
            d.status.toUpperCase(),
            d.deploymentType ?? '-',
            d.environmentName ?? '-',
            formatDate(d.startedAt),
            d.completedAt ? formatDate(d.completedAt) : '-',
          ])
        }

        console.log(table.toString())
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })

  deploymentsCmd
    .command('cancel <id>')
    .description('Cancel a deployment')
    .action(async (id: string) => {
      try {
        const data = await graphqlRequest<
          CancelDeploymentMutation,
          CancelDeploymentMutationVariables
        >(CANCEL_DEPLOYMENT_MUTATION, { id })

        const result = data.cancelDeployment
        if (!result.success) {
          printError(result.message ?? 'Failed to cancel deployment')
          process.exit(1)
        }

        printSuccess('Deployment cancelled successfully')
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })
}
