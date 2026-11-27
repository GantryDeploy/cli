import type { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildProgram } from '../program'

import { clientIdentityHeaders, setCliVersion, setCommand } from './client-identity'

function findCommand(root: Command, path: string[]): Command {
  let current = root
  for (const name of path) {
    const next = current.commands.find((command) => command.name() === name)
    if (!next) throw new Error(`No ${path.join(' ')} command`)
    current = next
  }
  return current
}

describe('clientIdentityHeaders', () => {
  beforeEach(() => {
    setCliVersion('1.4.0')
    vi.stubEnv('CI', '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('sends the release, node version and platform', () => {
    expect(clientIdentityHeaders()['User-Agent']).toBe(
      `gantry-cli/1.4.0 (node ${process.versions.node}; ${process.platform} ${process.arch})`
    )
  })

  it.each(['true', '1'])('marks a CI run when CI=%s', (value) => {
    vi.stubEnv('CI', value)

    expect(clientIdentityHeaders()['User-Agent']).toMatch(/; ci\)$/)
  })

  it.each(['false', '0'])('treats CI=%s as a terminal run', (value) => {
    vi.stubEnv('CI', value)

    expect(clientIdentityHeaders()['User-Agent']).not.toContain('ci)')
  })

  it.each([
    [['deploy', 'cutover'], 'deploy cutover'],
    [['databases', 'update'], 'databases update'],
    [['whoami'], 'whoami'],
    [['run'], 'run'],
    [['env', 'set'], 'env set'],
    [['shell'], 'shell'],
  ])('names the %j command by its path', (path, expected) => {
    setCommand(findCommand(buildProgram(), path))

    expect(clientIdentityHeaders()['X-Gantry-Command']).toBe(expected)
  })

  it.each([
    ['run', ['run', '--env', 'staging', '--', 'mysql', '-psuper-secret-password']],
    ['env set', ['env', 'set', 'STRIPE_KEY=sk_live_51HxQ2', '--env', 'production']],
    ['shell', ['shell', '--env', 'production', '--', 'export TOKEN=gpat_live_8f2c91']],
  ])('keeps the arguments of %s out of the command header', async (expected, argv) => {
    const program = buildProgram()
    findCommand(program, expected.split(' ')).action(() => undefined)

    await program.parseAsync(argv, { from: 'user' })

    expect(clientIdentityHeaders()['X-Gantry-Command']).toBe(expected)
  })
})
