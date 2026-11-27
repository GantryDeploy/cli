/** A single error produced by parsing or resolving a `gantry.yml`. */
export interface ResolutionError {
  code: string
  message: string
  path: string
  suggestion?: string
}

export type VariableValue = string | number | boolean

export interface ResolvedVariable {
  type: string
  value: VariableValue
  source: string
}

export type VariableProvenance = Record<string, ResolvedVariable>

export interface ServicePlanEntry {
  name: string
  type: string
  deploymentType: string
  source: string
  cluster: string | null
}

export interface RoutingPathEntry {
  path: string
  service: string
  deploymentType: string
  routeHops: string[]
}

export interface RoutingPlanEntry {
  domain: string
  entryType: string
  loadBalancer: string | null
  paths: RoutingPathEntry[]
}

export interface BuildPlanEntry {
  name: string
  architecture: string
}

export interface DeploymentPlan {
  services: ServicePlanEntry[]
  routing: RoutingPlanEntry[]
  builds: BuildPlanEntry[]
}

/** A named Docker build declared under `setup.builds`, read by `gantry lift`. */
export interface NamedBuildConfig {
  dockerfile: string
  /** Build context directory */
  working_dir?: string
  args?: Record<string, string>
  /** Passed to `docker build --target`. */
  docker_target?: string
  /** Name of another build in setup.builds that must complete first */
  depends_on?: string
}
