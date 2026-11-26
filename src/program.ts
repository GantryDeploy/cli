import { readFileSync } from 'fs'

import { Command } from 'commander'

import { registerBastionsCommand } from './commands/bastions'
import { registerCachesCommand } from './commands/caches'
import { registerCleanupCommand } from './commands/cleanup'
import { registerCloudsCommand } from './commands/clouds'
import { registerClustersCommand } from './commands/clusters'
import { registerDatabasesCommand } from './commands/databases'
import { registerDeployCommand, registerRollbackCommand } from './commands/deploy'
import { registerDeploymentsCommand } from './commands/deployments'
import { registerDomainsCommand } from './commands/domains'
import { registerEnvCommand } from './commands/env'
import { registerEnvironmentsCommand } from './commands/environments'
import { registerFilesystemsCommand } from './commands/filesystems'
import { registerFirewallsCommand } from './commands/firewalls'
import { registerLiftCommand } from './commands/lift'
import { registerLoadBalancersCommand } from './commands/load-balancers'
import { registerLoginCommand } from './commands/login'
import { registerLogsCommand } from './commands/logs'
import { registerNetworksCommand } from './commands/networks'
import { registerPreviewCommand } from './commands/preview'
import { registerProjectsCommand } from './commands/projects'
import { registerRegionsCommand } from './commands/regions'
import { registerResolveCommand } from './commands/resolve'
import { registerRunCommand } from './commands/run'
import { registerSecretsCommand } from './commands/secrets'
import { registerShellCommand } from './commands/shell'
import { registerTeardownCommand } from './commands/teardown'
import { registerValidateCommand } from './commands/validate'
import { registerVersionsCommand } from './commands/versions'
import { registerWhoamiCommand } from './commands/whoami'
import { setTeam } from './lib/config'
import { isRecord } from './lib/is-record'

// src/program.ts and the bundled dist/*.js all sit one level below package.json.
function packageVersion(): string {
  const manifest: unknown = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf-8')
  )
  if (!isRecord(manifest) || typeof manifest.version !== 'string') {
    throw new Error('package.json has no version.')
  }
  return manifest.version
}

export function buildProgram(): Command {
  const program = new Command()

  program
    .name('gantry')
    .description('Gantry CLI - Command line interface for Gantry')
    .version(packageVersion())
    .option('-C, --cwd <directory>', 'Change working directory')
    .option(
      '-T, --team <teamId>',
      'Team to act on, using a team ID from `gantry whoami`, for a personal token that covers more than one (also GANTRY_TEAM)'
    )
    // `run` needs passThroughOptions() to forward a target command's own flags. Global
    // options always come before the subcommand, so other commands are unaffected.
    .enablePositionalOptions()

  registerLoginCommand(program)
  registerWhoamiCommand(program)
  registerCloudsCommand(program)
  registerProjectsCommand(program)
  registerEnvironmentsCommand(program)
  registerEnvCommand(program)
  registerNetworksCommand(program)
  registerBastionsCommand(program)
  registerCachesCommand(program)
  registerClustersCommand(program)
  registerRunCommand(program)
  registerShellCommand(program)
  registerLogsCommand(program)
  registerDatabasesCommand(program)
  registerFilesystemsCommand(program)
  registerLiftCommand(program)
  registerRollbackCommand(program)
  registerDeployCommand(program)
  registerCleanupCommand(program)
  registerPreviewCommand(program)
  registerResolveCommand(program)
  registerValidateCommand(program)
  registerRegionsCommand(program)
  registerSecretsCommand(program)
  registerVersionsCommand(program)
  registerDeploymentsCommand(program)
  registerDomainsCommand(program)
  registerLoadBalancersCommand(program)
  registerFirewallsCommand(program)
  registerTeardownCommand(program)

  // One place to record the global `--team`, rather than every command reading it
  // off `optsWithGlobals()` and threading it down to its request.
  program.hook('preAction', (thisCommand) => {
    setTeam(thisCommand.opts<{ team?: string }>().team)
  })

  return program
}

export { commandExamples } from './lib/examples'
export type { CommandExample } from './lib/examples'
