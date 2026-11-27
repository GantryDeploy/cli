export const SUPPORTED_NODE_RANGE = '^22.22.2 || >=24.15.0'

export function isSupportedNodeVersion(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (!match) return false

  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  if (major === 22) return minor > 22 || (minor === 22 && patch >= 2)
  if (major === 24) return minor >= 15
  return major > 24
}

export function assertSupportedNodeVersion(version: string = process.versions.node): void {
  if (isSupportedNodeVersion(version)) return

  console.error(
    `Gantry CLI requires Node.js ${SUPPORTED_NODE_RANGE}. You are running Node.js ${version}.`
  )
  process.exit(1)
}
