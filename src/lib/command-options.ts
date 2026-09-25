import type { Command } from 'commander'

export function globalCwd(command: Command): string | undefined {
  const cwd: unknown = command.optsWithGlobals().cwd
  return typeof cwd === 'string' ? cwd : undefined
}
