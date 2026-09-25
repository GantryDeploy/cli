export function isInteractive(): boolean {
  return process.env.CI !== 'true' && process.stdin.isTTY && process.stdout.isTTY
}
