import type { Command } from 'commander'

import { formatApiError } from '../lib/client'
import { toCloudProvider } from '../lib/clouds'
import { fetchRegions, resolveCloud } from '../lib/interactive-prompts'
import { createTable, printError } from '../lib/output'
import { isInteractive } from '../lib/terminal'

export function registerRegionsCommand(program: Command): void {
  program
    .command('regions')
    .description('List the regions a cloud offers')
    .option('--cloud <id>', 'Cloud account ID')
    .option('--provider <provider>', 'Cloud provider, e.g. aws or gcp')
    .action(async (options: { cloud?: string; provider?: string }) => {
      try {
        if (options.cloud && options.provider) {
          printError('Pass either --cloud or --provider, not both.')
          process.exit(1)
        }
        if (!options.cloud && !options.provider && !isInteractive()) {
          printError('Pass --cloud <id> or --provider <provider>.')
          process.exit(1)
        }
        const provider = options.provider
          ? toCloudProvider(options.provider)
          : (await resolveCloud(options.cloud)).provider

        const regions = await fetchRegions(provider)
        if (regions.length === 0) {
          console.log('No regions found for this cloud.')
          return
        }

        const table = createTable({
          head: ['Code', 'Name'],
        })

        for (const region of regions) {
          table.push([region.code, region.name])
        }

        console.log(table.toString())
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })
}
