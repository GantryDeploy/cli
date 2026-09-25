import * as fs from 'fs'
import * as path from 'path'

import type { Command } from 'commander'
import { stringify as stringifyYaml } from 'yaml'

import { globalCwd } from '../lib/command-options'
import { printError } from '../lib/output'
import { findConfigPath } from '../lib/project-identity'
import { formatProvenanceTable, parseCliVarFlags, resolveYaml } from '../lib/resolve-yaml'

interface ResolveOptions {
  cwd?: string
  file?: string
  output?: string
  var?: string[]
}

export function registerResolveCommand(program: Command): void {
  program
    .command('resolve <environment>')
    .description('Render the composed gantry.yml for an environment')
    .option('-C, --cwd <directory>', 'Change working directory')
    .option('-f, --file <path>', 'Path to gantry.yml (defaults to ./gantry.yml)')
    .option('-o, --output <path>', 'Write resolved YAML to a file instead of stdout')
    .option(
      '--var <key=value>',
      'Override a declared variable (repeatable). CLI wins over project + environment values.',
      (value: string, prev: string[] | undefined) => (prev ? [...prev, value] : [value]),
      []
    )
    .action(async (environment: string, options: ResolveOptions, command: Command) => {
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

      const result = await resolveYaml({ yamlPath, environment, cliVariables })

      if (!result.ok) {
        for (const err of result.errors) {
          const pathLabel = err.path ? ` (at ${err.path})` : ''
          process.stderr.write(`${err.message}${pathLabel}\n`)
          if (err.suggestion) {
            process.stderr.write(`  hint: ${err.suggestion}\n`)
          }
        }
        process.exit(1)
      }

      // Provenance goes to stderr so stdout stays pipeable.
      const blueprintVars: Record<string, (typeof result.variableProvenance)[string]> = {}
      const projectVars: Record<string, (typeof result.variableProvenance)[string]> = {}
      for (const [key, value] of Object.entries(result.variableProvenance)) {
        if (
          value.source === 'blueprint_default' ||
          value.source === 'profile' ||
          value.source === 'blueprint_variables'
        ) {
          blueprintVars[key] = value
        } else if (value.source === 'value' || value.source === 'env_override') {
          projectVars[key] = value
        } else {
          // A CLI-supplied value could belong to either group; most come from blueprint variables.
          blueprintVars[key] = value
        }
      }

      const header: string[] = []
      if (result.blueprintReference) {
        header.push(`✓ Blueprint ${result.blueprintReference} loaded`)
      }
      header.push(`✓ ${String(Object.keys(result.variableProvenance).length)} variables resolved`)
      process.stderr.write(`${header.join('\n')}\n\n`)

      if (Object.keys(blueprintVars).length > 0) {
        process.stderr.write(`${formatProvenanceTable(blueprintVars, 'blueprint')}\n\n`)
      }
      if (Object.keys(projectVars).length > 0) {
        process.stderr.write(`${formatProvenanceTable(projectVars, 'project')}\n\n`)
      }

      const yamlOut = stringifyYaml(result.config)
      if (options.output) {
        const outPath = path.resolve(workingDir, options.output)
        try {
          fs.writeFileSync(outPath, yamlOut, 'utf-8')
          process.stderr.write(`Wrote resolved YAML to ${outPath}\n`)
        } catch (error) {
          printError(
            `Failed to write resolved YAML: ${error instanceof Error ? error.message : 'Unknown error'}`
          )
          process.exit(1)
        }
      } else {
        process.stdout.write(yamlOut)
      }
    })
}
