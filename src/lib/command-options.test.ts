import { Command } from 'commander'
import { describe, expect, it } from 'vitest'

import { globalCwd } from './command-options'

function parseCwd(argv: string[]): string | undefined {
  let seen: string | undefined
  const program = new Command().option('--cwd <path>').exitOverride()
  program.command('lift').action((_options: unknown, command: Command) => {
    seen = globalCwd(command)
  })
  program.parse(['node', 'gantry', ...argv])
  return seen
}

describe('globalCwd', () => {
  it('reads the global --cwd from a subcommand', () => {
    expect(parseCwd(['--cwd', '/srv/app', 'lift'])).toBe('/srv/app')
  })

  it('is undefined when --cwd is not passed', () => {
    expect(parseCwd(['lift'])).toBeUndefined()
  })
})
