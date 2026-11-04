import type { NetworkSubnetInput } from '../generated/graphql'

export type NetworkSubnets =
  { ok: true; subnets: NetworkSubnetInput[] } | { ok: false; message: string }

/** Reads `--subnet type:cidr[:zone]` flags into subnets named `<slug>-<type>-<n>`. */
export function buildNetworkSubnets(slug: string, specs: string[]): NetworkSubnets {
  const counts = { public: 0, private: 0 }
  const subnets: NetworkSubnetInput[] = []
  for (const spec of specs) {
    const [type, cidr, zone, ...rest] = spec.split(':')
    if ((type !== 'public' && type !== 'private') || !cidr || rest.length > 0) {
      return { ok: false, message: `--subnet ${spec} must look like private:10.0.16.0/20:<zone>` }
    }
    subnets.push({
      name: `${slug}-${type}-${String(counts[type]++)}`,
      cidr,
      type: type === 'public' ? 'PUBLIC' : 'PRIVATE',
      ...(zone ? { zone } : {}),
    })
  }
  return { ok: true, subnets }
}
