import { Command } from 'commander'
import { describe, expect, it } from 'vitest'

import { addExamples, commandExamples } from './examples'

function helpOf(command: Command): string {
  let output = ''
  command.configureOutput({ writeOut: (text) => (output += text) })
  command.outputHelp()
  return output
}

describe('addExamples', () => {
  const cutover = () => new Command('cutover').argument('<environment>', 'Environment name')

  it('shows each example under "Examples:" in --help', () => {
    const command = addExamples(cutover(), [
      {
        command: 'gantry deploy cutover production',
        description: 'Send all traffic to the new version',
      },
    ])

    expect(helpOf(command)).toContain(
      'Examples:\n  Send all traffic to the new version:\n    $ gantry deploy cutover production'
    )
  })

  it('records the examples for the command', () => {
    const examples = [{ command: 'gantry deploy cutover staging', description: 'Cut over staging' }]
    const command = addExamples(cutover(), examples)

    expect(commandExamples(command)).toEqual(examples)
  })

  it('returns no examples for a command that declares none', () => {
    expect(commandExamples(cutover())).toEqual([])
  })
})
