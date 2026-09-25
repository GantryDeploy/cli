import { readFileSync } from 'fs'

import { Command } from 'commander'

import { registerActivationCommands } from './commands/activation'
import { registerBastionsCommand } from './commands/bastions'
import { registerCachesCommand } from './commands/caches'
import { registerCloudsCommand } from './commands/clouds'
import { registerClustersCommand } from './commands/clusters'
import { registerConsoleCommand } from './commands/console'
import { registerDatabasesCommand } from './commands/databases'
import { registerDeploymentsCommand } from './commands/deployments'
import { registerDomainsCommand } from './commands/domains'
import { registerEnvironmentsCommand } from './commands/environments'
import { registerFilesystemsCommand } from './commands/filesystems'
import { registerLiftCommand } from './commands/lift'
import { registerLoadBalancersCommand } from './commands/load-balancers'
import { registerLoginCommand } from './commands/login'
import { registerNetworksCommand } from './commands/networks'
import { registerPreviewCommand } from './commands/preview'
import { registerProjectsCommand } from './commands/projects'
import { registerPromoteCommand } from './commands/promote'
import { registerRegionsCommand } from './commands/regions'
import { registerRerouteCommand } from './commands/reroute'
import { registerResolveCommand } from './commands/resolve'
import { registerSecretsCommand } from './commands/secrets'
import { registerTeardownCommand } from './commands/teardown'
import { registerValidateCommand } from './commands/validate'
import { registerVersionsCommand } from './commands/versions'
import { registerWhoamiCommand } from './commands/whoami'
import { setTeam } from './lib/config'
import { isRecord } from './lib/is-record'

// src/main.ts and the bundled dist/main-*.js both sit one level below package.json.
function packageVersion(): string {
  const manifest: unknown = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf-8')
  )
  if (!isRecord(manifest) || typeof manifest.version !== 'string') {
    throw new Error('package.json has no version.')
  }
  return manifest.version
}

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
  // `console` needs passThroughOptions() to forward a target command's own flags. Global
  // options always come before the subcommand, so other commands are unaffected.
  .enablePositionalOptions()

registerLoginCommand(program)
registerWhoamiCommand(program)
registerCloudsCommand(program)
registerProjectsCommand(program)
registerEnvironmentsCommand(program)
registerNetworksCommand(program)
registerBastionsCommand(program)
registerCachesCommand(program)
registerClustersCommand(program)
registerConsoleCommand(program)
registerDatabasesCommand(program)
registerFilesystemsCommand(program)
registerLiftCommand(program)
registerPreviewCommand(program)
registerResolveCommand(program)
registerValidateCommand(program)
registerPromoteCommand(program)
registerRegionsCommand(program)
registerRerouteCommand(program)
registerActivationCommands(program)
registerSecretsCommand(program)
registerVersionsCommand(program)
registerDeploymentsCommand(program)
registerDomainsCommand(program)
registerLoadBalancersCommand(program)
registerTeardownCommand(program)

// One place to record the global `--team`, rather than every command reading it
// off `optsWithGlobals()` and threading it down to its request.
program.hook('preAction', (thisCommand) => {
  setTeam(thisCommand.opts<{ team?: string }>().team)
})

program.parse(process.argv)
