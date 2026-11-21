import type { Command } from 'commander'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildProgram, commandExamples } from './program'

function subcommand(parent: Command, ...path: string[]): Command {
  return path.reduce((command, name) => {
    const found = command.commands.find((child) => child.name() === name)
    if (!found) throw new Error(`No command ${name} under ${command.name()}`)
    return found
  }, parent)
}

describe('buildProgram', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('builds the command tree without calling the API', () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    const program = buildProgram()

    expect(program.name()).toBe('gantry')
    expect(program.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(['lift', 'deploy', 'run', 'shell', 'env'])
    )
    expect(fetchSpy.mock.calls).toEqual([])
  })

  it('describes the environment argument of deploy cutover', () => {
    const args = subcommand(buildProgram(), 'deploy', 'cutover').registeredArguments

    expect(args.map((arg) => [arg.name(), arg.description])).toEqual([
      ['environment', 'Environment name'],
    ])
  })

  it.each([['run'], ['shell'], ['logs']])('refuses %s without an environment', async (name) => {
    const program = buildProgram()
    let error = ''
    subcommand(program, name)
      .exitOverride()
      .configureOutput({ writeErr: (text) => (error += text) })

    await expect(program.parseAsync(['node', 'gantry', name, 'web'])).rejects.toMatchObject({
      code: 'commander.missingMandatoryOptionValue',
    })
    expect(error).toContain("required option '-e, --env <environment>' not specified")
  })

  it.each([
    ['run'],
    ['shell'],
    ['logs'],
    ['versions', 'list'],
    ['deployments', 'list'],
    ['validate'],
    ['env', 'get'],
  ])('takes the environment as -e, --env on %s', (...path) => {
    const option = subcommand(buildProgram(), ...path).options.find((o) => o.long === '--env')

    expect(option?.flags).toBe('-e, --env <environment>')
  })

  it('records the examples declared on run', () => {
    expect(
      commandExamples(subcommand(buildProgram(), 'run')).map((example) => example.command)
    ).toEqual([
      'gantry run --env production web -- php artisan migrate --force',
      'gantry run --env production web -- migrate --force',
    ])
  })
})
