import type {
  AwsNetworkSettingsInput,
  NatGatewayOptionEnum,
  NetworkSubnetInput,
} from '../generated/graphql'

export interface NetworkCreateOptions {
  subnet?: string[]
  nat?: string
  internet?: boolean
}

export type NetworkSettings =
  | { ok: true; subnets: NetworkSubnetInput[]; aws?: AwsNetworkSettingsInput }
  | { ok: false; message: string }

const NAT_OPTIONS: Record<string, NatGatewayOptionEnum> = {
  none: 'NONE',
  single: 'SINGLE',
  'per-az': 'PER_AZ',
}

/**
 * Reads `--subnet type:cidr[:zone]` flags (named `<slug>-<type>-<n>`) and the AWS-only
 * `--nat` / `--no-internet` flags into the create input.
 */
export function buildNetworkSettings(slug: string, options: NetworkCreateOptions): NetworkSettings {
  const counts = { public: 0, private: 0 }
  const subnets: NetworkSubnetInput[] = []
  for (const spec of options.subnet ?? []) {
    const [type, cidr, zone, ...rest] = spec.split(':')
    if ((type !== 'public' && type !== 'private') || !cidr || rest.length > 0) {
      return { ok: false, message: `--subnet ${spec} must look like public:10.0.0.0/24:us-east-1a` }
    }
    subnets.push({
      name: `${slug}-${type}-${String(counts[type]++)}`,
      cidr,
      type: type === 'public' ? 'PUBLIC' : 'PRIVATE',
      ...(zone ? { zone } : {}),
    })
  }

  if (options.nat !== undefined && !(options.nat in NAT_OPTIONS)) {
    return { ok: false, message: '--nat must be none, single or per-az' }
  }
  const aws: AwsNetworkSettingsInput = {}
  if (options.nat !== undefined) aws.natGatewayOption = NAT_OPTIONS[options.nat]
  if (options.internet === false) aws.enableInternetAccess = false

  return Object.keys(aws).length > 0 ? { ok: true, subnets, aws } : { ok: true, subnets }
}
