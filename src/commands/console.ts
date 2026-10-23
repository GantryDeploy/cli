import * as path from 'path'

import type { Command } from 'commander'
import ora from 'ora'

import type {
  RunConsoleCommandMutation,
  RunConsoleCommandMutationVariables,
} from '../generated/graphql'
import { formatApiError, graphqlRequest } from '../lib/client'
import { globalCwd } from '../lib/command-options'
import { printError } from '../lib/output'
import { loadProjectIdentity, resolveEnvironmentSlug } from '../lib/project-identity'

const RUN_CONSOLE_COMMAND = /* GraphQL */ `
  mutation RunConsoleCommand(
    $projectId: String!
    $environmentSlug: String!
    $service: String!
    $command: [String!]!
    $variant: String
  ) {
    runConsoleCommand(
      projectId: $projectId
      environmentSlug: $environmentSlug
      service: $service
      command: $command
      variant: $variant
    ) {
      success
      exitCode
      output
      message
    }
  }
`

interface ConsoleCommandOptions {
  env?: string
  variant?: string
  cwd?: string
}

/** The API runs the command with its own cloud access, so the CLI needs no cloud credentials. */
export function registerConsoleCommand(program: Command): void {
  program
    .command('console')
    .description("Run a one-off command in a service's live runtime")
    .argument('<service>', 'Service name (e.g. "web")')
    .argument('[command...]', 'Command to run, after "--" (e.g. -- plugin list)')
    .option('--env <environment>', 'Environment name', 'dev')
    // The HTTP variant cannot handle console payloads.
    .option('--variant <variant>', 'Function variant to target', 'console')
    .option('--cwd <path>', 'Working directory containing gantry.yml')
    .passThroughOptions()
    .action(
      async (service: string, command: string[], options: ConsoleCommandOptions, cmd: Command) => {
        // passThroughOptions can keep the `--` separator as the first operand.
        const consoleCommand = command[0] === '--' ? command.slice(1) : command

        if (consoleCommand.length === 0) {
          printError('No command provided. Usage: gantry console <service> -- <command...>')
          process.exit(1)
        }

        // The global `-C, --cwd` comes before the subcommand, so check it as well.
        const cwd = globalCwd(cmd) ?? options.cwd
        const workingDir = cwd ? path.resolve(cwd) : process.cwd()
        const identity = loadProjectIdentity(workingDir)
        const envSlug = resolveEnvironmentSlug(identity, options.env ?? 'dev')

        const spinner = ora('Running console command...').start()

        let result: RunConsoleCommandMutation['runConsoleCommand']
        try {
          const data = await graphqlRequest<
            RunConsoleCommandMutation,
            RunConsoleCommandMutationVariables
          >(
            RUN_CONSOLE_COMMAND,
            {
              projectId: identity.id,
              environmentSlug: envSlug,
              service,
              command: consoleCommand,
              variant: options.variant ?? 'console',
            },
            // The API does not deduplicate console runs, so a replay would run the command twice.
            { idempotent: false }
          )
          result = data.runConsoleCommand
          spinner.stop()
        } catch (error) {
          spinner.fail('Failed to run console command')
          printError(formatApiError(error))
          process.exit(1)
        }

        if (!result.success) {
          printError(result.message ?? 'There was an error while running the console command.')
          process.exit(result.exitCode || 1)
        }

        if (result.output) {
          process.stdout.write(result.output.endsWith('\n') ? result.output : `${result.output}\n`)
        }
        process.exit(result.exitCode)
      }
    )
}
