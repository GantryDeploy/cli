import { Listr } from 'listr2'

import type { LiftBuildMutation, LiftBuildMutationVariables } from '../generated/graphql'

import { formatApiError, graphqlRequest } from './client'
import type { DeployCommandOptions } from './deploy-command-options'
import { reportVersionDeploy, versionDeployTasks } from './deploy-version'
import type { VersionDeployContext } from './deploy-version'
import { resolveRenderer, shouldUseFallbackRenderer, type CliRenderer } from './listr'
import { printError } from './output'
import { loadProjectIdentity } from './project-identity'
import { sanitizeTerminal } from './sanitize'
import { versionTag } from './version-tag'

const LIFT_BUILD_MUTATION = /* GraphQL */ `
  mutation LiftBuild($input: LiftBuildInput!) {
    liftBuild(input: $input) {
      success
      message
      versionId
      versionNumber
      yamlSnapshot
    }
  }
`

// GraphQL Int is 32-bit, so nine digits always fit.
const BUILD_NUMBER = /^v?([1-9]\d{0,8})$/

/** The build number in `12` or `v12`, or null when the value is neither. */
export function parseBuildNumber(value: string): number | null {
  const match = BUILD_NUMBER.exec(value.trim())
  return match ? Number(match[1]) : null
}

export type LiftSource = { from: string } | { buildNumber: number }

/**
 * Deploy a build that already exists to `environment`: another environment's live build, the
 * environment's own live build again, or a build by number. The version's own configuration is
 * deployed, so the local gantry.yml only names the project.
 */
export async function liftExistingBuild(params: {
  environment: string
  source: LiftSource
  workingDir: string
  options: DeployCommandOptions & { verbose?: boolean }
}): Promise<void> {
  const { environment, source, workingDir, options } = params
  const projectId = loadProjectIdentity(workingDir).id

  let finalCtx: VersionDeployContext
  try {
    const tasks = new Listr<VersionDeployContext, CliRenderer>(
      [
        {
          title: 'Lift build',
          task: async (ctx, task) => {
            const { liftBuild } = await graphqlRequest<
              LiftBuildMutation,
              LiftBuildMutationVariables
            >(LIFT_BUILD_MUTATION, { input: { projectId, environment, ...source } })

            if (!liftBuild.success || !liftBuild.versionId) {
              throw new Error(sanitizeTerminal(liftBuild.message ?? 'Failed to lift the build'))
            }

            ctx.newVersionId = liftBuild.versionId
            ctx.yamlSnapshot = liftBuild.yamlSnapshot ?? undefined
            ctx.environmentSlug = environment.toLowerCase()
            task.title = sanitizeTerminal(
              `Lift build (${versionTag(liftBuild.versionId, liftBuild.versionNumber)} → ${environment})`
            )
          },
        },
        ...versionDeployTasks<VersionDeployContext>({ workingDir, options }),
      ],
      {
        renderer: resolveRenderer(options.verbose ?? false),
        fallbackRenderer: 'simple',
        fallbackRendererCondition: shouldUseFallbackRenderer,
        rendererOptions: { collapseSubtasks: false },
      }
    )
    finalCtx = await tasks.run()
  } catch (error) {
    printError(formatApiError(error))
    process.exit(1)
  }

  reportVersionDeploy(finalCtx)
}
