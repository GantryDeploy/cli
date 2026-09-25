/**
 * Renderers the CLI picks between at runtime. Listr's constructor is generic over
 * the renderer, defaulting to the `'default'` literal, so a task list built from a
 * runtime choice has to name this union as its type argument:
 * `new Listr<Ctx, CliRenderer>(...)`.
 */
export type CliRenderer = 'default' | 'simple' | 'verbose'

export function resolveRenderer(verbose: boolean): CliRenderer {
  if (verbose) return 'verbose'
  const isCI = process.env.CI === 'true' || !process.stdout.isTTY
  return isCI ? 'simple' : 'default'
}

/** Used as Listr's `fallbackRendererCondition`. */
export function shouldUseFallbackRenderer(): boolean {
  return process.env.CI === 'true' || !process.stdout.isTTY
}
