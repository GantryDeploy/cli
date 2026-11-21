import type { Command } from 'commander'

export interface CommandExample {
  command: string
  description: string
}

const examplesByCommand = new WeakMap<Command, CommandExample[]>()

/** Show `examples` under "Examples:" in the command's `--help`, and record them for the docs reference. */
export function addExamples(command: Command, examples: CommandExample[]): Command {
  examplesByCommand.set(command, examples)
  return command.addHelpText(
    'after',
    [
      '',
      'Examples:',
      ...examples.flatMap(({ command: line, description }) => [
        `  ${description}:`,
        `    $ ${line}`,
      ]),
    ].join('\n')
  )
}

export function commandExamples(command: Command): CommandExample[] {
  return examplesByCommand.get(command) ?? []
}
