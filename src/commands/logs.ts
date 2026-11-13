import * as path from 'path'

import type { Command } from 'commander'

import type { ServiceLogsQuery, ServiceLogsQueryVariables } from '../generated/graphql'
import { graphqlRequest } from '../lib/client'
import { globalCwd } from '../lib/command-options'
import { streamLogs, withLogQueryOptions } from '../lib/log-stream'
import type { LogQueryOptions } from '../lib/log-stream'
import { loadProjectIdentity, resolveEnvironmentSlug } from '../lib/project-identity'

const SERVICE_LOGS = /* GraphQL */ `
  query ServiceLogs(
    $projectId: String!
    $environmentSlug: String!
    $service: String!
    $function: String
    $since: String
    $limit: Int
    $grep: String
    $cursor: String
  ) {
    serviceLogs(
      projectId: $projectId
      environmentSlug: $environmentSlug
      service: $service
      function: $function
      since: $since
      limit: $limit
      grep: $grep
      cursor: $cursor
    ) {
      lines {
        timestamp
        message
      }
      cursor
    }
  }
`

interface LogsOptions extends LogQueryOptions {
  env?: string
  function?: string
  cwd?: string
}

/** The API reads the logs with its own cloud access, so the CLI needs no cloud credentials. */
export function registerLogsCommand(program: Command): void {
  withLogQueryOptions(
    program
      .command('logs')
      .description("Show a service's runtime logs")
      .argument('<service>', 'Service name (e.g. "web")')
      .option('--env <environment>', 'Environment name', 'dev')
      .option('--function <name>', 'Function of a service with a functions: map (e.g. "worker")')
      .option('--cwd <path>', 'Working directory containing gantry.yml')
  ).action(async (service: string, options: LogsOptions, cmd: Command) => {
    // The global `-C, --cwd` comes before the subcommand, so check it as well.
    const cwd = globalCwd(cmd) ?? options.cwd
    const identity = loadProjectIdentity(cwd ? path.resolve(cwd) : process.cwd())
    const environmentSlug = resolveEnvironmentSlug(identity, options.env ?? 'dev')

    await streamLogs(
      async (cursor) =>
        (
          await graphqlRequest<ServiceLogsQuery, ServiceLogsQueryVariables>(SERVICE_LOGS, {
            projectId: identity.id,
            environmentSlug,
            service,
            function: options.function,
            since: options.since,
            limit: options.limit,
            grep: options.grep,
            cursor,
          })
        ).serviceLogs,
      options.refresh === true,
      `No log lines for ${service} in ${environmentSlug} in the last ${options.since}.`
    )
  })
}
