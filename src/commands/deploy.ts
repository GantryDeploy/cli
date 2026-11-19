import * as path from 'path'

import type { Command } from 'commander'
import { Listr } from 'listr2'

import type {
  AbortReleaseMutation,
  AbortReleaseMutationVariables,
  CompleteReleaseMutation,
  CompleteReleaseMutationVariables,
  CutoverMutation,
  CutoverMutationVariables,
  ReapplyRoutingMutation,
  ReapplyRoutingMutationVariables,
  ReleaseState,
  ReleaseStatusQuery,
  ReleaseStatusQueryVariables,
  RollbackMutation,
  RollbackMutationVariables,
  ShiftTrafficMutation,
  ShiftTrafficMutationVariables,
} from '../generated/graphql'
import { formatApiError, graphqlRequest } from '../lib/client'
import { globalCwd } from '../lib/command-options'
import { resolveRenderer, shouldUseFallbackRenderer, type CliRenderer } from '../lib/listr'
import { printError } from '../lib/output'
import { loadProjectIdentity } from '../lib/project-identity'
import { waitForRelease } from '../lib/release-poll'
import { sanitizeTerminal } from '../lib/sanitize'

const RELEASE_STATUS_QUERY = /* GraphQL */ `
  query ReleaseStatus($projectId: String!, $environment: String!) {
    releaseStatus(projectId: $projectId, environment: $environment) {
      strategy
      state
      since
      holdExpiresAt
      versions {
        versionId
        number
        role
        weight
        createdAt
      }
    }
  }
`

const CUTOVER_MUTATION = /* GraphQL */ `
  mutation Cutover($input: CutoverInput!) {
    cutover(input: $input) {
      success
      message
      deploymentId
    }
  }
`

const SHIFT_TRAFFIC_MUTATION = /* GraphQL */ `
  mutation ShiftTraffic($input: ShiftTrafficInput!) {
    shiftTraffic(input: $input) {
      success
      message
      deploymentId
    }
  }
`

const ABORT_RELEASE_MUTATION = /* GraphQL */ `
  mutation AbortRelease($input: ReleaseEnvironmentInput!) {
    abortRelease(input: $input) {
      success
      message
      deploymentId
    }
  }
`

const COMPLETE_RELEASE_MUTATION = /* GraphQL */ `
  mutation CompleteRelease($input: ReleaseEnvironmentInput!) {
    completeRelease(input: $input) {
      success
      message
      deploymentId
    }
  }
`

const ROLLBACK_MUTATION = /* GraphQL */ `
  mutation Rollback($input: RollbackInput!) {
    rollback(input: $input) {
      success
      message
      deploymentId
    }
  }
`

const REAPPLY_ROUTING_MUTATION = /* GraphQL */ `
  mutation ReapplyRouting($input: ReleaseEnvironmentInput!) {
    reapplyRouting(input: $input) {
      success
      message
      deploymentId
    }
  }
`

type OperationResult = CutoverMutation['cutover']
type ReleaseStatusResult = NonNullable<ReleaseStatusQuery['releaseStatus']>

interface ReleaseOptions {
  cwd?: string
  verbose?: boolean
}

interface EnvironmentInput {
  projectId: string
  environment: string
}

const PERCENT = /^(100|[1-9]?\d)$/

function projectId(options: ReleaseOptions, command: Command): string {
  const cwd = globalCwd(command) ?? options.cwd
  return loadProjectIdentity(cwd ? path.resolve(cwd) : process.cwd()).id
}

/** Submit a release operation, then follow the deployment it starts until it settles. */
async function runOperation(params: {
  title: string
  options: ReleaseOptions
  submit: () => Promise<OperationResult>
}): Promise<void> {
  try {
    const tasks = new Listr<{ deploymentId?: string }, CliRenderer>(
      [
        {
          title: params.title,
          task: async (ctx, task) => {
            const outcome = await params.submit()
            if (!outcome.success || !outcome.deploymentId) {
              throw new Error(sanitizeTerminal(outcome.message ?? `${params.title} failed`))
            }
            ctx.deploymentId = outcome.deploymentId
            if (outcome.message) task.title = sanitizeTerminal(outcome.message)
          },
        },
        {
          title: 'Apply',
          // Keeps every post-deploy command line on screen beneath the task.
          rendererOptions: { outputBar: Infinity, persistentOutput: true },
          task: async (ctx, task) => {
            if (!ctx.deploymentId) throw new Error('The operation started no deployment')
            await waitForRelease(
              ctx.deploymentId,
              (title) => {
                task.title = title
              },
              (line) => {
                task.output = line
              }
            )
          },
        },
      ],
      {
        renderer: resolveRenderer(params.options.verbose ?? false),
        fallbackRenderer: 'simple',
        fallbackRendererCondition: shouldUseFallbackRenderer,
      }
    )
    await tasks.run()
  } catch (error) {
    printError(formatApiError(error))
    process.exit(1)
  }
}

function formatTime(timestamp: string): string {
  return `${new Date(timestamp).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

const NEXT_STEP: Record<
  Exclude<ReleaseState, 'NONE'>,
  (env: string, strategy: string) => string
> = {
  STAGED: (env, strategy) =>
    strategy === 'canary'
      ? `gantry deploy shift ${env} --percent <percent>`
      : `gantry deploy cutover ${env}`,
  SPLIT: (env) => `gantry deploy shift ${env} --percent <percent>`,
  CUT_OVER: (env) => `gantry deploy complete ${env}`,
}

/** The lines `gantry deploy status` prints for an environment's release. */
export function statusLines(environment: string, status: ReleaseStatusResult): string[] {
  const lines = [`${environment}  (${sanitizeTerminal(status.strategy)})`]
  for (const version of status.versions) {
    const role = version.role.toLowerCase()
    const when =
      version.role === 'LIVE'
        ? `since ${formatTime(status.since)}`
        : `lifted ${formatTime(version.createdAt)}`
    lines.push(
      `  ${role.padEnd(9)} ${`v${String(version.number)}`.padEnd(6)} ${`${String(version.weight)}%`.padStart(4)}   ${when}`
    )
  }
  if (status.holdExpiresAt) {
    const outcome = status.state === 'STAGED' ? 'rolls back' : 'completes'
    lines.push(`  ${'hold:'.padEnd(9)} ${outcome} at ${formatTime(status.holdExpiresAt)}`)
  }
  if (status.state !== 'NONE') {
    lines.push(`  ${'next:'.padEnd(9)} ${NEXT_STEP[status.state](environment, status.strategy)}`)
  }
  return lines
}

async function cutover(input: EnvironmentInput & { complete?: boolean }): Promise<OperationResult> {
  const data = await graphqlRequest<CutoverMutation, CutoverMutationVariables>(CUTOVER_MUTATION, {
    input,
  })
  return data.cutover
}

export function registerRollbackCommand(program: Command): void {
  program
    .command('rollback <environment>')
    .description('Make an earlier version of the environment live')
    .option(
      '--version <versionId>',
      'ID of the version to make live (defaults to the latest earlier version with an older build)'
    )
    .option('-C, --cwd <directory>', 'Change working directory')
    .option('-v, --verbose', 'Emit a log line per state change')
    .action(
      async (
        environment: string,
        options: ReleaseOptions & { version?: string },
        command: Command
      ) => {
        const input = {
          projectId: projectId(options, command),
          environment,
          versionId: options.version,
        }
        await runOperation({
          title: `Roll back ${environment}`,
          options,
          submit: async () =>
            (
              await graphqlRequest<RollbackMutation, RollbackMutationVariables>(ROLLBACK_MUTATION, {
                input,
              })
            ).rollback,
        })
      }
    )
}

export function registerDeployCommand(program: Command): void {
  const deploy = program
    .command('deploy')
    .description('Move traffic during a blue-green or canary release')

  deploy
    .command('status <environment>')
    .description('Show the live versions and the release in progress')
    .option('-C, --cwd <directory>', 'Change working directory')
    .action(async (environment: string, options: ReleaseOptions, command: Command) => {
      try {
        const { releaseStatus } = await graphqlRequest<
          ReleaseStatusQuery,
          ReleaseStatusQueryVariables
        >(RELEASE_STATUS_QUERY, { projectId: projectId(options, command), environment })
        if (!releaseStatus) {
          console.log(`Nothing is live in ${environment} yet.`)
          return
        }
        for (const line of statusLines(environment, releaseStatus)) console.log(line)
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })

  deploy
    .command('cutover <environment>')
    .description('Send all traffic to the new version of the release in progress')
    .option('--complete', 'Also complete the release, dropping the previous version')
    .option('-C, --cwd <directory>', 'Change working directory')
    .option('-v, --verbose', 'Emit a log line per state change')
    .action(
      async (
        environment: string,
        options: ReleaseOptions & { complete?: boolean },
        command: Command
      ) => {
        const input = {
          projectId: projectId(options, command),
          environment,
          complete: options.complete,
        }
        await runOperation({
          title: `Cut over ${environment}`,
          options,
          submit: () => cutover(input),
        })
      }
    )

  deploy
    .command('shift <environment>')
    .description('Send a share of traffic to the new version of a canary release')
    .requiredOption('--percent <percent>', 'Share of traffic, 0 to 100, the new version takes')
    .option('--complete', 'Also complete the release, dropping the previous version (only at 100)')
    .option('-C, --cwd <directory>', 'Change working directory')
    .option('-v, --verbose', 'Emit a log line per state change')
    .action(
      async (
        environment: string,
        options: ReleaseOptions & { percent: string; complete?: boolean },
        command: Command
      ) => {
        if (!PERCENT.test(options.percent.trim())) {
          printError('--percent must be a whole number from 0 to 100.')
          process.exit(1)
        }
        const percent = Number(options.percent.trim())
        if (options.complete && percent !== 100) {
          printError('--complete is only valid with --percent 100.')
          process.exit(1)
        }
        const input = {
          projectId: projectId(options, command),
          environment,
          percent,
          complete: options.complete,
        }
        await runOperation({
          title: `Shift ${String(percent)}% of ${environment}`,
          options,
          submit: async () =>
            (
              await graphqlRequest<ShiftTrafficMutation, ShiftTrafficMutationVariables>(
                SHIFT_TRAFFIC_MUTATION,
                { input }
              )
            ).shiftTraffic,
        })
      }
    )

  deploy
    .command('abort <environment>')
    .description('Send all traffic back to the version live before the release')
    .option('-C, --cwd <directory>', 'Change working directory')
    .option('-v, --verbose', 'Emit a log line per state change')
    .action(async (environment: string, options: ReleaseOptions, command: Command) => {
      const input = { projectId: projectId(options, command), environment }
      await runOperation({
        title: `Abort the release in ${environment}`,
        options,
        submit: async () =>
          (
            await graphqlRequest<AbortReleaseMutation, AbortReleaseMutationVariables>(
              ABORT_RELEASE_MUTATION,
              { input }
            )
          ).abortRelease,
      })
    })

  deploy
    .command('complete <environment>')
    .description('Drop the previous version of a release that has been cut over')
    .option('-C, --cwd <directory>', 'Change working directory')
    .option('-v, --verbose', 'Emit a log line per state change')
    .action(async (environment: string, options: ReleaseOptions, command: Command) => {
      const input = { projectId: projectId(options, command), environment }
      await runOperation({
        title: `Complete the release in ${environment}`,
        options,
        submit: async () =>
          (
            await graphqlRequest<CompleteReleaseMutation, CompleteReleaseMutationVariables>(
              COMPLETE_RELEASE_MUTATION,
              { input }
            )
          ).completeRelease,
      })
    })

  deploy
    .command('reapply <environment>', { hidden: true })
    .description("Apply the routing of the environment's live versions again")
    .option('-C, --cwd <directory>', 'Change working directory')
    .option('-v, --verbose', 'Emit a log line per state change')
    .action(async (environment: string, options: ReleaseOptions, command: Command) => {
      const input = { projectId: projectId(options, command), environment }
      await runOperation({
        title: `Reapply the routing in ${environment}`,
        options,
        submit: async () =>
          (
            await graphqlRequest<ReapplyRoutingMutation, ReapplyRoutingMutationVariables>(
              REAPPLY_ROUTING_MUTATION,
              { input }
            )
          ).reapplyRouting,
      })
    })
}
