import type { Command } from 'commander'

let cliVersion: string | null = null
let commandPath: string | null = null

/** Recorded once by `buildProgram`, from the same package.json `--version` prints. */
export function setCliVersion(version: string): void {
  cliVersion = version
}

/**
 * Records the command being run as its names from the top level down, without `gantry`.
 * Arguments and flag values never enter it: `run`, `env set` and `shell` arguments can hold secrets.
 */
export function setCommand(command: Command): void {
  const names: string[] = []
  let current = command
  while (current.parent) {
    names.unshift(current.name())
    current = current.parent
  }
  commandPath = names.join(' ')
}

function runsInCi(): boolean {
  const ci = process.env.CI
  return ci !== undefined && ci !== '' && ci !== 'false' && ci !== '0'
}

/** Headers that tell the API which CLI release and command sent a request. */
export function clientIdentityHeaders(): Record<string, string> {
  if (cliVersion === null) {
    throw new Error('The CLI version was not recorded before a request.')
  }
  const platform = [
    `node ${process.versions.node}`,
    `${process.platform} ${process.arch}`,
    ...(runsInCi() ? ['ci'] : []),
  ].join('; ')
  return {
    'User-Agent': `gantry-cli/${cliVersion} (${platform})`,
    ...(commandPath ? { 'X-Gantry-Command': commandPath } : {}),
  }
}
