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

export interface DeploymentPlan {
  services: ServicePlanEntry[]
  routing: RoutingPlanEntry[]
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

const ROUTE_HOP_LABELS: Record<string, string> = {
  cloudfront: 'CloudFront',
  alb: 'ALB',
  ecs: 'ECS',
  lambda: 'Lambda',
  'lambda-edge': 'Lambda@Edge',
  s3: 'S3',
  'cloud-cdn': 'Cloud CDN',
  gcs: 'GCS',
  'global-lb': 'Global LB',
  'cloud-run': 'Cloud Run',
  gke: 'GKE',
  cloudflare: 'Cloudflare',
  r2: 'R2',
  worker: 'Worker',
}

/** Render hops as the arrow-joined chain users read: `CloudFront → ALB → Lambda`. */
export function formatRouteChain(hops: readonly string[], fallback: string): string {
  if (hops.length === 0) return fallback
  return hops.map((hop) => ROUTE_HOP_LABELS[hop] ?? hop).join(' → ')
}
