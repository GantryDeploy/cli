import * as path from 'path'

import type { Command } from 'commander'

import { globalCwd } from '../lib/command-options'
import { printError, printSuccess } from '../lib/output'
import { exitWithResolutionErrors, findConfigPath } from '../lib/project-identity'
import { parseCliVarFlags, resolveAllEnvironments, resolveYaml } from '../lib/resolve-yaml'

interface ValidateOptions {
  cwd?: string
  file?: string
  environment?: string
  var?: string[]
}

export function registerValidateCommand(program: Command): void {
  program
    .command('validate')
    .description('Validate gantry.yml and exit non-zero if it is invalid')
    .option('-C, --cwd <directory>', 'Change working directory')
    .option('-f, --file <path>', 'Path to gantry.yml (defaults to ./gantry.yml)')
    .option('-e, --environment <environment>', 'Validate only this environment')
    .option(
      '--var <key=value>',
      'Override a declared variable (repeatable). CLI wins over project + environment values.',
      (value: string, prev: string[] | undefined) => (prev ? [...prev, value] : [value]),
      []
    )
    .action(async (options: ValidateOptions, command: Command) => {
      const cwd = globalCwd(command) ?? options.cwd
      const workingDir = cwd ? path.resolve(cwd) : process.cwd()
      const yamlPath = options.file
        ? path.resolve(workingDir, options.file)
        : findConfigPath(workingDir)

      if (!yamlPath) {
        printError(`No gantry.yml or gantry.yaml found in ${workingDir}`)
        process.exit(1)
      }

      let cliVariables: Record<string, string>
      try {
        cliVariables = parseCliVarFlags(options.var)
      } catch (error) {
        printError(error instanceof Error ? error.message : 'Failed to parse --var flags')
        process.exit(1)
      }

      const fileLabel = path.basename(yamlPath)

      if (options.environment) {
        const result = await resolveYaml({
          yamlPath,
          environment: options.environment,
          cliVariables,
        })
        if (!result.ok) {
          printError(`Environment "${options.environment}" is invalid:`)
          exitWithResolutionErrors(result.errors)
        }
        printSuccess(`${fileLabel} is valid (${options.environment})`)
        return
      }

      // The server resolves every environment in one call and reports all errors together.
      const result = await resolveAllEnvironments({ yamlPath, cliVariables })
      if (!result.ok) {
        exitWithResolutionErrors(result.errors)
      }

      if (result.environments.length === 0) {
        printError('gantry.yml declares no environments')
        process.exit(1)
      }

      const summary =
        result.environments.length === 1
          ? result.environments[0]
          : `${String(result.environments.length)} environments`
      printSuccess(`${fileLabel} is valid (${summary})`)
    })
}
