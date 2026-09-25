export const SUPPORTED_NODE_RANGE = '^22.13.0 || >=24'

export function isSupportedNodeVersion(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\./.exec(version)
  if (!match) return false

  const major = Number(match[1])
  const minor = Number(match[2])
  return (major === 22 && minor >= 13) || major >= 24
}

export function assertSupportedNodeVersion(version: string = process.versions.node): void {
  if (isSupportedNodeVersion(version)) return

  console.error(
    `Gantry CLI requires Node.js ${SUPPORTED_NODE_RANGE}. You are running Node.js ${version}.`
  )
  process.exit(1)
}
