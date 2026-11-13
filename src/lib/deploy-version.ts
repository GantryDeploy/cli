import type { ListrGetRendererClassFromValue, ListrTask } from 'listr2'

import type {
  StartVersionDeploymentMutation,
  StartVersionDeploymentMutationVariables,
} from '../generated/graphql'

import { graphqlRequest } from './client'
import { deployCommandSkips } from './deploy-command-options'
import type { DeployCommandOptions } from './deploy-command-options'
import { serviceDeploymentNames, serviceDeploymentSubtasks } from './deployment-poll'
import type { ServiceFailure } from './deployment-poll'
import type { CliRenderer } from './listr'
import { printError } from './output'
import { printRoutingSummary, waitForRouting } from './routing-wait'
import type { RoutingResult } from './routing-wait'
import { sanitizeTerminal } from './sanitize'

const START_DEPLOYMENT_MUTATION = /* GraphQL */ `
  mutation StartVersionDeployment(
    $environment: String!
    $config: JSON!
    $versionId: String
    $options: DeploymentOptionsInput
  ) {
    startDeployment(
      input: {
        environment: $environment
        config: $config
        versionId: $versionId
        options: $options
      }
    ) {
      success
      message
      deploymentIds
      versionId
    }
  }
`

/**
 * State for deploying a version that already exists. The command's first task fills
 * `newVersionId`, `yamlSnapshot` and `environmentSlug`; the tasks below fill the rest.
 */
export interface VersionDeployContext {
  newVersionId?: string
  yamlSnapshot?: string
  environmentSlug?: string
  versionId?: string
  deploymentIds?: string[]
  failedServices?: ServiceFailure[]
  routing?: RoutingResult
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Start the version's deployment, watch its services, then wait for routing. */
export function versionDeployTasks<Ctx extends VersionDeployContext>(params: {
  workingDir: string
  options: DeployCommandOptions
}): ListrTask<
  Ctx,
  ListrGetRendererClassFromValue<CliRenderer>,
  ListrGetRendererClassFromValue<'simple'>
>[] {
  const { workingDir, options } = params
  return [
    {
      title: 'Start deployment',
      skip: (ctx) => !ctx.newVersionId || !ctx.yamlSnapshot,
      task: async (ctx, task) => {
        const { environmentSlug, yamlSnapshot } = ctx
        if (!yamlSnapshot) {
          throw new Error('Version snapshot is missing')
        }
        if (!environmentSlug) {
          throw new Error('Target environment is missing')
        }
        const config: unknown = JSON.parse(yamlSnapshot)
        if (!isJsonObject(config)) {
          throw new Error('Version snapshot is invalid')
        }

        const { startDeployment } = await graphqlRequest<
          StartVersionDeploymentMutation,
          StartVersionDeploymentMutationVariables
        >(START_DEPLOYMENT_MUTATION, {
          environment: environmentSlug,
          config,
          versionId: ctx.newVersionId,
          options: deployCommandSkips(options),
        })

        if (!startDeployment.success || !startDeployment.deploymentIds?.length) {
          throw new Error(sanitizeTerminal(startDeployment.message ?? 'Failed to start deployment'))
        }

        ctx.deploymentIds = startDeployment.deploymentIds
        ctx.versionId = startDeployment.versionId ?? ctx.newVersionId
        task.title = `Start deployment (${String(startDeployment.deploymentIds.length)} service(s))`
      },
    },
    {
      title: 'Deploy services',
      skip: (ctx) => !ctx.deploymentIds?.length,
      task: async (ctx, task) => {
        const { versionId, deploymentIds } = ctx
        if (!versionId || !deploymentIds) {
          throw new Error('No deployments to monitor')
        }

        const subtasks = serviceDeploymentSubtasks<Ctx>({
          versionId,
          deploymentIds,
          names: await serviceDeploymentNames(versionId),
          taskContext: { cwd: workingDir },
          isCancelling: () => false,
          onFailure: (subCtx, failure) => {
            subCtx.failedServices = subCtx.failedServices ?? []
            subCtx.failedServices.push(failure)
          },
        })

        // exitOnError: false lets every service finish when a sibling fails.
        return task.newListr(subtasks, { concurrent: true, exitOnError: false })
      },
    },
    {
      title: 'Configure routing',
      // Keeps every post-deploy command line on screen beneath the task.
      rendererOptions: { outputBar: Infinity, persistentOutput: true },
      skip: (ctx) => {
        if (!ctx.versionId) return true
        const failed = ctx.failedServices?.length ?? 0
        return failed > 0
          ? `${String(failed)} service${failed === 1 ? '' : 's'} failed, routing not applied`
          : false
      },
      task: async (ctx, task) => {
        if (!ctx.versionId) throw new Error('Routing started without a version ID')
        ctx.routing = await waitForRouting({
          versionId: ctx.versionId,
          isCancelling: () => false,
          postDeployAsync: options.postDeployAsync === true,
          setTitle: (title) => {
            task.title = title
          },
          writeOutput: (line) => {
            task.output = line
          },
        })
      },
    },
  ]
}

/** Print the live routes, or each failed service and exit non-zero. */
export function reportVersionDeploy(ctx: VersionDeployContext): void {
  if (ctx.routing) printRoutingSummary(ctx.routing)

  if (ctx.failedServices?.length) {
    for (const failure of ctx.failedServices) {
      printError(failure.message)
    }
    process.exit(1)
  }
}
