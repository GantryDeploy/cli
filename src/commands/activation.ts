import * as path from 'path'

import type { Command } from 'commander'
import { Listr } from 'listr2'

import type {
  AbortCanaryMutation,
  AbortCanaryMutationVariables,
  GetActivationDeploymentQuery,
  GetActivationDeploymentQueryVariables,
  PromoteBlueGreenMutation,
  PromoteBlueGreenMutationVariables,
  PromoteCanaryMutation,
  PromoteCanaryMutationVariables,
  RollbackDeploymentMutation,
  RollbackDeploymentMutationVariables,
  SetCanaryMutation,
  SetCanaryMutationVariables,
} from '../generated/graphql'
import { formatApiError, graphqlRequest } from '../lib/client'
import { globalCwd } from '../lib/command-options'
import { isTerminalStatus } from '../lib/deployment-status'
import { resolveRenderer, shouldUseFallbackRenderer, type CliRenderer } from '../lib/listr'
import { printError } from '../lib/output'
import { loadProjectIdentity } from '../lib/project-identity'
import { sanitizeTerminal } from '../lib/sanitize'

// Rollback, canary, promote and abort each start a deployment that the CLI polls, like `reroute`.

const POLL_INTERVAL_MS = 2000
const ACTIVATION_TIMEOUT_MS = 5 * 60 * 1000

type ActivationOutcome = RollbackDeploymentMutation['rollbackDeployment']

interface ActivationInput {
  projectId: string
  environment: string
  versionId?: string
  weight?: number
}

interface CommonOptions {
  cwd?: string
  verbose?: boolean
}

function loadProjectId(cwd: string | undefined): string {
  return loadProjectIdentity(cwd ? path.resolve(cwd) : process.cwd()).id
}

const DEPLOYMENT_QUERY = /* GraphQL */ `
  query GetActivationDeployment($id: String!) {
    deployment(id: $id) {
      id
      status
      lastMessage
    }
  }
`

type ActivationField =
  'abortCanary' | 'promoteBlueGreen' | 'promoteCanary' | 'rollbackDeployment' | 'setCanary'

const ACTIVATIONS: Record<
  ActivationField,
  (variables: RollbackDeploymentMutationVariables) => Promise<ActivationOutcome>
> = {
  abortCanary: async (variables) => {
    const data = await graphqlRequest<AbortCanaryMutation, AbortCanaryMutationVariables>(
      /* GraphQL */ `
        mutation AbortCanary($input: ActivationInput!) {
          abortCanary(input: $input) {
            success
            message
            deploymentId
          }
        }
      `,
      variables
    )
    return data.abortCanary
  },
  promoteBlueGreen: async (variables) => {
    const data = await graphqlRequest<PromoteBlueGreenMutation, PromoteBlueGreenMutationVariables>(
      /* GraphQL */ `
        mutation PromoteBlueGreen($input: ActivationInput!) {
          promoteBlueGreen(input: $input) {
            success
            message
            deploymentId
          }
        }
      `,
      variables
    )
    return data.promoteBlueGreen
  },
  promoteCanary: async (variables) => {
    const data = await graphqlRequest<PromoteCanaryMutation, PromoteCanaryMutationVariables>(
      /* GraphQL */ `
        mutation PromoteCanary($input: ActivationInput!) {
          promoteCanary(input: $input) {
            success
            message
            deploymentId
          }
        }
      `,
      variables
    )
    return data.promoteCanary
  },
  rollbackDeployment: async (variables) => {
    const data = await graphqlRequest<
      RollbackDeploymentMutation,
      RollbackDeploymentMutationVariables
    >(
      /* GraphQL */ `
        mutation RollbackDeployment($input: ActivationInput!) {
          rollbackDeployment(input: $input) {
            success
            message
            deploymentId
          }
        }
      `,
      variables
    )
    return data.rollbackDeployment
  },
  setCanary: async (variables) => {
    const data = await graphqlRequest<SetCanaryMutation, SetCanaryMutationVariables>(
      /* GraphQL */ `
        mutation SetCanary($input: ActivationInput!) {
          setCanary(input: $input) {
            success
            message
            deploymentId
          }
        }
      `,
      variables
    )
    return data.setCanary
  },
}

async function pollActivation(deploymentId: string, task: { title: string }): Promise<void> {
  const startTime = Date.now()
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- intentional polling loop; exits via return/throw
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    if (Date.now() - startTime > ACTIVATION_TIMEOUT_MS) {
      throw new Error('Activation timed out after 5 minutes')
    }
    try {
      const { deployment } = await graphqlRequest<
        GetActivationDeploymentQuery,
        GetActivationDeploymentQueryVariables
      >(DEPLOYMENT_QUERY, { id: deploymentId })
      if (!deployment) {
        task.title = 'Apply activation: Not found'
        return
      }
      const message = deployment.lastMessage ? ` - ${sanitizeTerminal(deployment.lastMessage)}` : ''
      task.title = sanitizeTerminal(
        `Apply activation: ${deployment.status.toUpperCase()}${message}`
      )
      const { status } = deployment
      if (isTerminalStatus(status)) {
        if (status === 'COMPLETE') {
          task.title = `Activation complete${message}`
          return
        }
        if (status === 'FAILED') throw new Error(`Activation failed${message}`)
        task.title = sanitizeTerminal(`Apply activation: ${deployment.status.toUpperCase()}`)
        return
      }
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes('Activation failed') ||
          error.message.includes('Activation timed out') ||
          error.message.includes('not found'))
      ) {
        throw error
      }
      // Network errors are transient while polling; keep trying.
    }
  }
}

async function runActivation(params: {
  label: string
  mutationField: ActivationField
  input: Omit<ActivationInput, 'projectId'>
  cwd?: string
  verbose: boolean
}): Promise<void> {
  const projectId = loadProjectId(params.cwd)
  const activate = ACTIVATIONS[params.mutationField]

  try {
    const tasks = new Listr<{ deploymentId?: string }, CliRenderer>(
      [
        {
          title: params.label,
          task: async (ctx) => {
            const outcome = await activate({ input: { projectId, ...params.input } })
            if (!outcome.success || !outcome.deploymentId) {
              throw new Error(
                sanitizeTerminal(outcome.message ?? `Failed to ${params.label.toLowerCase()}`)
              )
            }
            ctx.deploymentId = outcome.deploymentId
          },
        },
        {
          title: 'Apply activation',
          skip: (ctx) => !ctx.deploymentId,
          task: async (ctx, task) => {
            if (ctx.deploymentId) await pollActivation(ctx.deploymentId, task)
          },
        },
      ],
      {
        renderer: resolveRenderer(params.verbose),
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

function commonOpts(options: CommonOptions, command: Command): { cwd?: string; verbose: boolean } {
  return {
    cwd: globalCwd(command) ?? options.cwd,
    verbose: options.verbose ?? false,
  }
}

export function registerActivationCommands(program: Command): void {
  program
    .command('rollback <environment>')
    .description('Roll the environment back to a target version')
    .requiredOption('--version <versionId>', 'ID of the version to roll back to')
    .option('-C, --cwd <directory>', 'Change working directory')
    .option('-v, --verbose', 'Emit a log line per state change')
    .action(
      async (
        environment: string,
        options: CommonOptions & { version: string },
        command: Command
      ) => {
        await runActivation({
          label: `Roll back ${environment}`,
          mutationField: 'rollbackDeployment',
          input: { environment, versionId: options.version },
          ...commonOpts(options, command),
        })
      }
    )

  program
    .command('canary <environment>')
    .description('Start or adjust a canary at a traffic weight')
    .requiredOption('--version <versionId>', 'ID of the canary version')
    .requiredOption('--weight <percent>', 'Canary traffic weight (0–100)')
    .option('-C, --cwd <directory>', 'Change working directory')
    .option('-v, --verbose', 'Emit a log line per state change')
    .action(
      async (
        environment: string,
        options: CommonOptions & { version: string; weight: string },
        command: Command
      ) => {
        const weight = options.weight.trim() === '' ? Number.NaN : Number(options.weight)
        if (!Number.isFinite(weight) || weight < 0 || weight > 100) {
          printError('--weight must be a number between 0 and 100.')
          process.exit(1)
        }
        await runActivation({
          label: `Canary ${environment} @ ${String(weight)}%`,
          mutationField: 'setCanary',
          input: { environment, versionId: options.version, weight },
          ...commonOpts(options, command),
        })
      }
    )

  program
    .command('canary:promote <environment>')
    .description('Promote the current canary to stable (100%)')
    .option('-C, --cwd <directory>', 'Change working directory')
    .option('-v, --verbose', 'Emit a log line per state change')
    .action(async (environment: string, options: CommonOptions, command: Command) => {
      await runActivation({
        label: `Promote canary in ${environment}`,
        mutationField: 'promoteCanary',
        input: { environment },
        ...commonOpts(options, command),
      })
    })

  program
    .command('canary:abort <environment>')
    .description('Abort the current canary (revert to stable)')
    .option('-C, --cwd <directory>', 'Change working directory')
    .option('-v, --verbose', 'Emit a log line per state change')
    .action(async (environment: string, options: CommonOptions, command: Command) => {
      await runActivation({
        label: `Abort canary in ${environment}`,
        mutationField: 'abortCanary',
        input: { environment },
        ...commonOpts(options, command),
      })
    })

  program
    .command('cutover <environment>')
    .description('Blue-green cutover: flip a staged (green) version to live')
    .requiredOption('--version <versionId>', 'ID of the version to make live')
    .option('-C, --cwd <directory>', 'Change working directory')
    .option('-v, --verbose', 'Emit a log line per state change')
    .action(
      async (
        environment: string,
        options: CommonOptions & { version: string },
        command: Command
      ) => {
        await runActivation({
          label: `Cut over ${environment}`,
          mutationField: 'promoteBlueGreen',
          input: { environment, versionId: options.version },
          ...commonOpts(options, command),
        })
      }
    )
}
