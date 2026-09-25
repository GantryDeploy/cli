import * as path from 'path'

import type { Command } from 'commander'

import { globalCwd } from '../lib/command-options'
import { createTable, printError, renderTree, styledCell } from '../lib/output'
import type { TreeNode } from '../lib/output'
import { exitWithResolutionErrors, findConfigPath } from '../lib/project-identity'
import { parseCliVarFlags, resolveYaml } from '../lib/resolve-yaml'
import { formatRouteChain } from '../types'

interface PreviewOptions {
  cwd?: string
  file?: string
  var?: string[]
}

export function registerPreviewCommand(program: Command): void {
  program
    .command('preview <environment>')
    .description('Show what deploying to an environment would produce')
    .option('-C, --cwd <directory>', 'Change working directory')
    .option('-f, --file <path>', 'Path to gantry.yml (defaults to ./gantry.yml)')
    .option(
      '--var <key=value>',
      'Override a declared variable (repeatable). CLI wins over project + environment values.',
      (value: string, prev: string[] | undefined) => (prev ? [...prev, value] : [value]),
      []
    )
    .action(async (environment: string, options: PreviewOptions, command: Command) => {
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
        exitWithResolutionErrors(result.errors)
      }

      const { plan } = result

      console.log()
      console.log(`\x1b[1mDeployment Preview\x1b[0m: ${environment}`)
      console.log()

      const serviceTable = createTable({
        head: ['Service', 'Type', 'Deployment', 'Source', 'Cluster'],
      })

      for (const svc of plan.services) {
        serviceTable.push([
          svc.name,
          svc.type,
          svc.deploymentType,
          svc.source,
          svc.cluster ?? styledCell('\x1b[2m—\x1b[0m'),
        ])
      }

      console.log(serviceTable.toString())

      if (plan.routing.length > 0) {
        console.log()
        console.log('\x1b[1mRouting\x1b[0m')
        console.log()

        const routingNodes: TreeNode[] = plan.routing.map((entry) => {
          const lbNote = entry.loadBalancer ? ` (lb: ${entry.loadBalancer})` : ''

          return {
            label: `\x1b[36m${entry.domain}\x1b[0m \x1b[2m[${entry.entryType}${lbNote}]\x1b[0m`,
            children: entry.paths.map((p) => ({
              label: `${p.path} → \x1b[33m${p.service}\x1b[0m \x1b[2m(${p.deploymentType})\x1b[0m`,
              children: [
                { label: `\x1b[2m${formatRouteChain(p.routeHops, entry.entryType)}\x1b[0m` },
              ],
            })),
          }
        })

        for (const line of renderTree(routingNodes)) {
          console.log(line)
        }
      } else {
        console.log()
        console.log('\x1b[2mNo routing configured for this environment.\x1b[0m')
      }

      console.log()
    })
}
