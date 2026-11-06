import * as path from 'path'
import { setTimeout as sleep } from 'timers/promises'

import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda'
import type { Command } from 'commander'
import ora from 'ora'

import type {
  CommandRunQuery,
  CommandRunQueryVariables,
  StartCommandRunMutation,
  StartCommandRunMutationVariables,
} from '../generated/graphql'
import { formatApiError, graphqlRequest } from '../lib/client'
import { globalCwd } from '../lib/command-options'
import { printError } from '../lib/output'
import { loadProjectIdentity, resolveEnvironmentSlug } from '../lib/project-identity'

const START_COMMAND_RUN = /* GraphQL */ `
  mutation StartCommandRun(
    $projectId: String!
    $environmentSlug: String!
    $service: String!
    $command: [String!]!
    $variant: String
  ) {
    startCommandRun(
      projectId: $projectId
      environmentSlug: $environmentSlug
      service: $service
      command: $command
      variant: $variant
    ) {
      success
      message
      runId
      aws {
        region
        functionName
        qualifier
        payload
        credentials {
          accessKeyId
          secretAccessKey
          sessionToken
        }
      }
    }
  }
`

const COMMAND_RUN = /* GraphQL */ `
  query CommandRun(
    $projectId: String!
    $environmentSlug: String!
    $service: String!
    $runId: String!
    $outputCursor: String
  ) {
    commandRun(
      projectId: $projectId
      environmentSlug: $environmentSlug
      service: $service
      runId: $runId
      outputCursor: $outputCursor
    ) {
      state
      exitCode
      output
      outputCursor
      message
    }
  }
`

const POLL_INTERVAL_MS = 2_000
const POLL_FAILURE_LIMIT_MS = 2 * 60_000
// ECS can take a moment to show a task it has just started.
const NOT_VISIBLE_LIMIT_MS = 60_000
// CloudWatch can store a line a few seconds after the task wrote it.
const FINAL_OUTPUT_WAIT_MS = 5_000
// Lambda ends a function at 15 minutes, so this only fires on a dead connection.
const LAMBDA_CALL_TIMEOUT_MS = 16 * 60_000

const RUN_ERROR_MESSAGE = 'There was an error while running the command.'

type StartedRun = StartCommandRunMutation['startCommandRun']
type LambdaInvocation = NonNullable<StartedRun['aws']>

interface RunTarget {
  projectId: string
  environmentSlug: string
  service: string
}

interface RunOptions {
  env?: string
  variant?: string
  cwd?: string
}

function writeOutput(output: string): void {
  if (output) {
    process.stdout.write(output.endsWith('\n') ? output : `${output}\n`)
  }
}

async function followRun(target: RunTarget, runId: string): Promise<number> {
  const startedAt = Date.now()
  let lastReadAt = startedAt
  let outputCursor: string | null | undefined

  const read = async () => {
    const { commandRun } = await graphqlRequest<CommandRunQuery, CommandRunQueryVariables>(
      COMMAND_RUN,
      { ...target, runId, outputCursor }
    )
    writeOutput(commandRun.output)
    outputCursor = commandRun.outputCursor ?? outputCursor
    return commandRun
  }

  for (;;) {
    let run: Awaited<ReturnType<typeof read>>
    try {
      run = await read()
      lastReadAt = Date.now()
    } catch {
      // A failed read says nothing about the command, which keeps running.
      if (Date.now() - lastReadAt > POLL_FAILURE_LIMIT_MS) {
        printError(`${RUN_ERROR_MESSAGE} It may still be running (run ${runId}).`)
        return 1
      }
      await sleep(POLL_INTERVAL_MS)
      continue
    }

    if (run.state === 'finished') {
      await sleep(FINAL_OUTPUT_WAIT_MS)
      try {
        // Each read returns one page of logs. AWS marks the end by returning the cursor it was given.
        let previousCursor: typeof outputCursor
        do {
          previousCursor = outputCursor
          await read()
        } while (outputCursor !== previousCursor)
      } catch {
        // The result is already known, so a failed read must not change the exit code.
        printError('The command finished, but the rest of its output could not be read.')
      }
      if (run.message) printError(run.message)
      return run.exitCode ?? 1
    }

    if (run.state === 'not-found' && Date.now() - startedAt > NOT_VISIBLE_LIMIT_MS) {
      printError(`Command run ${runId} was not found.`)
      return 1
    }

    await sleep(POLL_INTERVAL_MS)
  }
}

/** The API hands over this call because only a connected caller gets Lambda's result back. */
async function invokeLambda(invocation: LambdaInvocation): Promise<number> {
  const client = new LambdaClient({
    region: invocation.region,
    credentials: invocation.credentials,
    // A retry would run the command a second time.
    maxAttempts: 1,
    requestHandler: { requestTimeout: LAMBDA_CALL_TIMEOUT_MS, throwOnRequestTimeout: true },
  })

  const response = await client.send(
    new InvokeCommand({
      FunctionName: invocation.functionName,
      Qualifier: invocation.qualifier,
      InvocationType: 'RequestResponse',
      Payload: new TextEncoder().encode(invocation.payload),
    })
  )

  const raw = response.Payload ? new TextDecoder().decode(response.Payload) : ''
  let parsed: { exitCode?: number; output?: string; errorMessage?: string } | undefined
  try {
    const json: unknown = JSON.parse(raw)
    parsed = typeof json === 'object' && json !== null ? json : undefined
  } catch {
    parsed = undefined
  }

  // The Bref console runtime throws on a non-zero exit, with the command's output as the message
  // and no exit code, so every failure here exits 1.
  if (response.FunctionError) {
    writeOutput(parsed?.errorMessage ?? raw)
    return 1
  }

  if (!parsed) {
    writeOutput(raw)
    return 0
  }

  writeOutput(parsed.output ?? '')
  return parsed.exitCode ?? 0
}

/** Runs one command in a service's live runtime and exits with its result. */
export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description("Run a one-off command in a service's live runtime")
    .usage('[options] <service> -- <command...>')
    .argument('<service>', 'Service name (e.g. "web")')
    .argument('[command...]', 'Command to run, after "--"')
    .option('--env <environment>', 'Environment name', 'dev')
    .option('--variant <variant>', "Function to target (default: the service's console function)")
    .option('--cwd <path>', 'Working directory containing gantry.yml')
    .addHelpText(
      'after',
      [
        '',
        'Options go before the service name. Anything after it is passed to the command.',
        '',
        'A container service runs the full command:',
        '  gantry run --env production web -- php artisan migrate --force',
        '',
        "A serverless service's console function adds its own entry point, so pass only the arguments:",
        '  gantry run --env production web -- migrate --force',
      ].join('\n')
    )
    .passThroughOptions()
    .action(async (service: string, command: string[], options: RunOptions, cmd: Command) => {
      // passThroughOptions can keep the `--` separator as the first operand.
      const remoteCommand = command[0] === '--' ? command.slice(1) : command

      if (remoteCommand.length === 0) {
        printError('No command provided. Usage: gantry run [options] <service> -- <command...>')
        process.exit(1)
      }

      // The global `-C, --cwd` comes before the subcommand, so check it as well.
      const cwd = globalCwd(cmd) ?? options.cwd
      const workingDir = cwd ? path.resolve(cwd) : process.cwd()
      const identity = loadProjectIdentity(workingDir)
      const target: RunTarget = {
        projectId: identity.id,
        environmentSlug: resolveEnvironmentSlug(identity, options.env ?? 'dev'),
        service,
      }

      const spinner = ora('Starting command...').start()

      let started: StartedRun
      try {
        const data = await graphqlRequest<
          StartCommandRunMutation,
          StartCommandRunMutationVariables
        >(
          START_COMMAND_RUN,
          { ...target, command: remoteCommand, variant: options.variant },
          // The response can hold short-lived credentials, which the API must not store for
          // replay, and a replay could start the command twice.
          { idempotent: false }
        )
        started = data.startCommandRun
        spinner.stop()
      } catch (error) {
        spinner.fail('Failed to start the command')
        printError(formatApiError(error))
        process.exit(1)
      }

      const { aws, runId } = started
      if (!started.success || (!aws && !runId)) {
        printError(started.message ?? RUN_ERROR_MESSAGE)
        process.exit(1)
      }

      let exitCode = 1
      try {
        if (aws) exitCode = await invokeLambda(aws)
        else if (runId) exitCode = await followRun(target, runId)
      } catch {
        printError(`${RUN_ERROR_MESSAGE} It may still be running.`)
        process.exit(1)
      }

      process.exit(exitCode)
    })
}
