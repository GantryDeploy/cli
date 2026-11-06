import { spawn } from 'child_process'
import { existsSync } from 'fs'
import * as path from 'path'

import type { Command } from 'commander'
import ora from 'ora'

import type {
  StartShellSessionMutation,
  StartShellSessionMutationVariables,
} from '../generated/graphql'
import { formatApiError, graphqlRequest } from '../lib/client'
import { globalCwd } from '../lib/command-options'
import { printError } from '../lib/output'
import { loadProjectIdentity, resolveEnvironmentSlug } from '../lib/project-identity'

const START_SHELL_SESSION = /* GraphQL */ `
  mutation StartShellSession(
    $projectId: String!
    $environmentSlug: String!
    $service: String!
    $instance: String
    $command: String
  ) {
    startShellSession(
      projectId: $projectId
      environmentSlug: $environmentSlug
      service: $service
      instance: $instance
      command: $command
    ) {
      success
      message
      instanceId
      aws {
        region
        sessionId
        streamUrl
        tokenValue
        target
      }
    }
  }
`

export const SESSION_PLUGIN = 'session-manager-plugin'
const PLUGIN_INSTALL_URL =
  'https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html'
const SESSION_ERROR_MESSAGE = 'There was an error while opening the session.'

type AwsShellSession = NonNullable<StartShellSessionMutation['startShellSession']['aws']>

interface ShellOptions {
  env?: string
  instance?: string
  cwd?: string
}

export function sessionPluginInstalled(
  searchPath = process.env.PATH,
  platform = process.platform
): boolean {
  const extensions = platform === 'win32' ? ['.exe', ''] : ['']
  return (searchPath ?? '')
    .split(path.delimiter)
    .filter(Boolean)
    .some((dir) => extensions.some((ext) => existsSync(path.join(dir, SESSION_PLUGIN + ext))))
}

/** The arguments the AWS CLI passes the plugin for `aws ecs execute-command`. */
export function sessionPluginArgs(session: AwsShellSession): string[] {
  return [
    JSON.stringify({
      sessionId: session.sessionId,
      streamUrl: session.streamUrl,
      tokenValue: session.tokenValue,
    }),
    session.region,
    'StartSession',
    '',
    JSON.stringify({ Target: session.target }),
    `https://ssm.${session.region}.${session.region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com'}`,
  ]
}

/** ECS takes the command as one string, so an argument holding spaces or quotes is quoted. */
export function joinCommand(args: string[]): string {
  return args
    .map((arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`))
    .join(' ')
}

/** Hands the terminal to the plugin and resolves with its exit code, or null when it isn't installed. */
function attach(session: AwsShellSession): Promise<number | null> {
  return new Promise((resolve) => {
    // Ctrl-C belongs to the remote shell, which receives it through the plugin.
    const ignoreInterrupt = () => undefined
    process.on('SIGINT', ignoreInterrupt)
    const done = (code: number | null) => {
      process.off('SIGINT', ignoreInterrupt)
      resolve(code)
    }

    const plugin = spawn(SESSION_PLUGIN, sessionPluginArgs(session), { stdio: 'inherit' })
    plugin.on('error', (error: NodeJS.ErrnoException) => {
      done(error.code === 'ENOENT' ? null : 1)
    })
    plugin.on('exit', (code) => {
      done(code ?? 1)
    })
  })
}

/** Opens an interactive session on a running instance of a service's live version. */
export function registerShellCommand(program: Command): void {
  program
    .command('shell')
    .description("Open an interactive shell on a running instance of a service's live version")
    .usage('[options] <service> [-- <command...>]')
    .argument('<service>', 'Service name (e.g. "web")')
    .argument('[command...]', 'Interactive command to run instead of /bin/sh, after "--"')
    .option('--env <environment>', 'Environment name', 'dev')
    .option(
      '--instance <id>',
      'Instance to attach to (default: the first one that accepts sessions)'
    )
    .option('--cwd <path>', 'Working directory containing gantry.yml')
    .addHelpText(
      'after',
      [
        '',
        'Options go before the service name.',
        '',
        '  gantry shell --env production web',
        '  gantry shell --env production web -- bash',
        '',
        'Container services only. A session runs as root and closes after 20 idle minutes.',
        `It needs AWS's ${SESSION_PLUGIN} installed: ${PLUGIN_INSTALL_URL}`,
      ].join('\n')
    )
    .passThroughOptions()
    .action(async (service: string, command: string[], options: ShellOptions, cmd: Command) => {
      const remoteCommand = command[0] === '--' ? command.slice(1) : command

      // Checked first, so a missing plugin doesn't open a session nobody can attach to.
      if (!sessionPluginInstalled()) {
        printError(`${SESSION_PLUGIN} was not found. Install it from ${PLUGIN_INSTALL_URL}`)
        process.exit(1)
      }

      const cwd = globalCwd(cmd) ?? options.cwd
      const identity = loadProjectIdentity(cwd ? path.resolve(cwd) : process.cwd())

      const spinner = ora('Opening session...').start()
      let started: StartShellSessionMutation['startShellSession']
      try {
        const data = await graphqlRequest<
          StartShellSessionMutation,
          StartShellSessionMutationVariables
        >(
          START_SHELL_SESSION,
          {
            projectId: identity.id,
            environmentSlug: resolveEnvironmentSlug(identity, options.env ?? 'dev'),
            service,
            instance: options.instance,
            command: remoteCommand.length > 0 ? joinCommand(remoteCommand) : undefined,
          },
          // The response holds a session token, which the API must not store for replay.
          { idempotent: false }
        )
        started = data.startShellSession
        spinner.stop()
      } catch (error) {
        spinner.fail('Failed to open the session')
        printError(formatApiError(error))
        process.exit(1)
      }

      if (!started.success || !started.aws) {
        printError(started.message ?? SESSION_ERROR_MESSAGE)
        process.exit(1)
      }

      if (started.instanceId) {
        process.stderr.write(`Connected to instance ${started.instanceId}.\n`)
      }
      const exitCode = await attach(started.aws)
      if (exitCode === null) {
        printError(`${SESSION_PLUGIN} was not found. Install it from ${PLUGIN_INSTALL_URL}`)
        process.exit(1)
      }
      process.exit(exitCode)
    })
}
