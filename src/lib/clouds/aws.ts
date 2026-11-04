import { checkbox, input, select } from '@inquirer/prompts'
import { Option } from 'commander'

import type {
  AwsCacheDeploymentModeEnum,
  AwsCacheSettingsInput,
  AwsCapacityProviderTypeEnum,
  AwsClusterOrchestratorEnum,
  AwsClusterSettingsInput,
  AwsDatabaseDeploymentModeEnum,
  AwsDatabaseSettingsInput,
  AwsEfsPerformanceModeEnum,
  AwsEfsThroughputModeEnum,
  AwsFilesystemSettingsInput,
  AwsNatGatewayOptionEnum,
  AwsNetworkSettingsInput,
} from '../../generated/graphql'
import { notANumberMessage, parseNumber } from '../numbers'
import { isInteractive } from '../terminal'

type Result<T> = { ok: true; value: T } | { ok: false; message: string }

export const AWS_OPTIONS_GROUP = 'AWS options:'

export function awsOption(flags: string, description: string): Option {
  return new Option(flags, description).helpGroup(AWS_OPTIONS_GROUP)
}

function choose(
  on: boolean | undefined,
  off: boolean | undefined,
  flag: string
): Result<boolean | undefined> {
  if (on && off) return { ok: false, message: `Choose either --aws-${flag} or --aws-no-${flag}.` }
  if (on) return { ok: true, value: true }
  if (off) return { ok: true, value: false }
  return { ok: true, value: undefined }
}

export type AwsDatabaseFlavor = 'rds' | 'aurora'

/** Which AWS database service runs a server: RDS, or Aurora (the only one with serverless). */
export function toAwsDatabaseFlavor(flavor: string): AwsDatabaseFlavor {
  const normalized = flavor.trim().toLowerCase()
  if (normalized === 'rds' || normalized === 'aurora') return normalized
  throw new Error('Unknown AWS database service. Use rds or aurora.')
}

export function awsDatabaseFlavorOf(providerData: Record<string, unknown>): string | undefined {
  return typeof providerData.flavor === 'string' ? providerData.flavor : undefined
}

export interface AwsDatabaseCreateFlags {
  awsFlavor?: string
  awsServerless?: boolean
  awsNoMasterRotation?: boolean
}

export function awsDatabaseCreateSettings(
  flavor: string,
  serverless: boolean,
  flags: AwsDatabaseCreateFlags
): AwsDatabaseSettingsInput {
  return {
    flavor,
    deploymentMode: serverless ? 'SERVERLESS' : 'PROVISIONED',
    ...(flags.awsNoMasterRotation ? { masterPasswordRotation: false } : {}),
  }
}

export interface AwsDatabaseUpdateFlags {
  awsMinCapacity?: string
  awsMaxCapacity?: string
  awsPauseAfter?: string
  awsStorageType?: string
  awsIops?: string
  awsPerformanceInsights?: boolean
  awsNoPerformanceInsights?: boolean
  awsMasterRotation?: boolean
  awsNoMasterRotation?: boolean
}

const AWS_DATABASE_NUMBER_FLAGS = [
  ['awsMinCapacity', '--aws-min-capacity', 'minCapacity', false],
  ['awsMaxCapacity', '--aws-max-capacity', 'maxCapacity', false],
  ['awsPauseAfter', '--aws-pause-after', 'secondsUntilAutoPause', true],
  ['awsIops', '--aws-iops', 'iops', true],
] as const

export function buildAwsDatabaseUpdate(
  flags: AwsDatabaseUpdateFlags
): Result<AwsDatabaseSettingsInput> {
  const aws: AwsDatabaseSettingsInput = {}
  if (flags.awsStorageType !== undefined) aws.storageType = flags.awsStorageType

  const insights = choose(
    flags.awsPerformanceInsights,
    flags.awsNoPerformanceInsights,
    'performance-insights'
  )
  if (!insights.ok) return insights
  if (insights.value !== undefined) aws.performanceInsightsEnabled = insights.value

  const rotation = choose(flags.awsMasterRotation, flags.awsNoMasterRotation, 'master-rotation')
  if (!rotation.ok) return rotation
  if (rotation.value !== undefined) aws.masterPasswordRotation = rotation.value

  for (const [option, flag, field, whole] of AWS_DATABASE_NUMBER_FLAGS) {
    const raw = flags[option]
    if (raw === undefined) continue
    const value = parseNumber(raw, whole)
    if (value === null) return { ok: false, message: notANumberMessage(flag, whole) }
    aws[field] = value
  }
  return { ok: true, value: aws }
}

export interface AwsNetworkFlags {
  awsNat?: string
  awsNoInternet?: boolean
}

const NAT_OPTIONS: Record<string, AwsNatGatewayOptionEnum> = {
  none: 'NONE',
  single: 'SINGLE',
  'per-az': 'PER_AZ',
}

export function buildAwsNetworkSettings(
  flags: AwsNetworkFlags
): Result<AwsNetworkSettingsInput | undefined> {
  if (flags.awsNat !== undefined && !(flags.awsNat in NAT_OPTIONS)) {
    return { ok: false, message: '--aws-nat must be none, single or per-az' }
  }
  const aws: AwsNetworkSettingsInput = {}
  if (flags.awsNat !== undefined) aws.natGatewayOption = NAT_OPTIONS[flags.awsNat]
  if (flags.awsNoInternet) aws.enableInternetAccess = false
  return { ok: true, value: Object.keys(aws).length > 0 ? aws : undefined }
}

/** The parameter group family an AWS catalog entry carries in its provider data. */
export function awsCatalogFamily(providerData: Record<string, unknown>): string | undefined {
  return typeof providerData.parameterGroupFamily === 'string'
    ? providerData.parameterGroupFamily
    : undefined
}

export function toAwsCacheDeploymentMode(mode: string): AwsCacheDeploymentModeEnum {
  if (mode === 'serverless') return 'SERVERLESS'
  if (mode === 'node-based') return 'NODE_BASED'
  throw new Error('--aws-mode must be serverless or node-based')
}

export function toAwsDatabaseDeploymentMode(mode: string): AwsDatabaseDeploymentModeEnum {
  if (mode === 'serverless') return 'SERVERLESS'
  if (mode === 'provisioned') return 'PROVISIONED'
  throw new Error('--aws-mode must be provisioned or serverless')
}

export function awsCacheSettings(serverless: boolean): AwsCacheSettingsInput {
  return { deploymentMode: serverless ? 'SERVERLESS' : 'NODE_BASED' }
}

const CAPACITY_PROVIDERS: Partial<Record<string, AwsCapacityProviderTypeEnum>> = {
  fargate: 'FARGATE',
  'fargate-spot': 'FARGATE_SPOT',
  'managed-instances': 'MANAGED_INSTANCES',
}

const ORCHESTRATORS: Partial<Record<string, AwsClusterOrchestratorEnum>> = { ecs: 'ECS' }

export async function awsClusterSettings(
  clusterType: string,
  capacityProvider: string | undefined
): Promise<Result<AwsClusterSettingsInput>> {
  const orchestrator = ORCHESTRATORS[clusterType.toLowerCase()]
  if (!orchestrator) return { ok: false, message: 'Unknown cluster type.' }

  let capacityType: AwsCapacityProviderTypeEnum | undefined
  if (capacityProvider !== undefined) {
    capacityType = CAPACITY_PROVIDERS[capacityProvider]
    if (!capacityType) {
      return {
        ok: false,
        message: '--aws-capacity-provider must be fargate, fargate-spot or managed-instances',
      }
    }
  } else {
    capacityType = await select<AwsCapacityProviderTypeEnum>({
      message: 'Capacity:',
      choices: [
        { name: 'Fargate: serverless containers', value: 'FARGATE' },
        { name: 'Fargate Spot: serverless containers on spare capacity', value: 'FARGATE_SPOT' },
        {
          name: 'Managed Instances: EC2 instances AWS manages for you',
          value: 'MANAGED_INSTANCES',
        },
      ],
    })
  }
  return { ok: true, value: { orchestrator, capacityProviders: [{ type: capacityType }] } }
}

export interface AwsFilesystemFlags {
  awsPerformanceMode?: string
  awsThroughputMode?: string
  awsThroughputMibps?: string
  awsEncrypted?: boolean
}

const PERFORMANCE_MODES: Partial<Record<string, AwsEfsPerformanceModeEnum>> = {
  'general-purpose': 'GENERAL_PURPOSE',
  'max-io': 'MAX_IO',
}

const THROUGHPUT_MODES: Partial<Record<string, AwsEfsThroughputModeEnum>> = {
  elastic: 'ELASTIC',
  bursting: 'BURSTING',
  provisioned: 'PROVISIONED',
}

const MAX_THROUGHPUT_MIBPS = 3414

function validThroughput(value: number | null): value is number {
  return value !== null && value >= 1 && value <= MAX_THROUGHPUT_MIBPS
}

/** Reads the `--aws-*` filesystem flags, prompting for any left out when a terminal is attached. */
export async function awsFilesystemSettings(
  flags: AwsFilesystemFlags
): Promise<Result<AwsFilesystemSettingsInput>> {
  const interactive = isInteractive()

  let performanceMode: AwsEfsPerformanceModeEnum | undefined
  if (flags.awsPerformanceMode !== undefined) {
    performanceMode = PERFORMANCE_MODES[flags.awsPerformanceMode]
    if (!performanceMode) {
      return { ok: false, message: '--aws-performance-mode must be general-purpose or max-io' }
    }
  } else if (interactive) {
    performanceMode = await select<AwsEfsPerformanceModeEnum>({
      message: 'Performance mode:',
      choices: [
        { name: 'General Purpose: Recommended for most workloads', value: 'GENERAL_PURPOSE' },
        { name: 'Max I/O: For highly parallelized applications', value: 'MAX_IO' },
      ],
    })
  }

  let throughputMode: AwsEfsThroughputModeEnum | undefined
  if (flags.awsThroughputMode !== undefined) {
    throughputMode = THROUGHPUT_MODES[flags.awsThroughputMode]
    if (!throughputMode) {
      return {
        ok: false,
        message: '--aws-throughput-mode must be elastic, bursting or provisioned',
      }
    }
  } else if (interactive) {
    const choices: { name: string; value: AwsEfsThroughputModeEnum }[] = [
      { name: 'Elastic: Recommended, scales automatically', value: 'ELASTIC' },
      { name: 'Bursting: Scales with storage size', value: 'BURSTING' },
      { name: 'Provisioned: Fixed throughput', value: 'PROVISIONED' },
    ]
    throughputMode = await select<AwsEfsThroughputModeEnum>({
      message: 'Throughput mode:',
      choices:
        performanceMode === 'MAX_IO' ? choices.filter((c) => c.value !== 'ELASTIC') : choices,
    })
  }
  if (performanceMode === 'MAX_IO' && throughputMode === 'ELASTIC') {
    return { ok: false, message: 'Elastic throughput is not available with max-io performance.' }
  }

  let provisionedThroughputMibps: number | undefined
  if (flags.awsThroughputMibps !== undefined) {
    if (throughputMode !== 'PROVISIONED') {
      return {
        ok: false,
        message: '--aws-throughput-mibps needs --aws-throughput-mode provisioned',
      }
    }
    const value = parseNumber(flags.awsThroughputMibps, true)
    if (!validThroughput(value)) {
      return {
        ok: false,
        message: `--aws-throughput-mibps must be a whole number from 1 to ${String(MAX_THROUGHPUT_MIBPS)}`,
      }
    }
    provisionedThroughputMibps = value
  } else if (throughputMode === 'PROVISIONED') {
    if (!interactive) {
      return { ok: false, message: 'Provisioned throughput needs --aws-throughput-mibps.' }
    }
    provisionedThroughputMibps = Number(
      await input({
        message: 'Provisioned throughput (MiB/s):',
        default: '128',
        validate: (v) =>
          validThroughput(parseNumber(v, true))
            ? true
            : `Enter a whole number from 1 to ${String(MAX_THROUGHPUT_MIBPS)}`,
      })
    )
  }

  let encrypted = flags.awsEncrypted
  if (encrypted === undefined && interactive) {
    encrypted = await select({
      message: 'Enable encryption at rest?',
      choices: [
        { name: 'Yes', value: true },
        { name: 'No', value: false },
      ],
    })
  }

  return {
    ok: true,
    value: {
      ...(performanceMode ? { performanceMode } : {}),
      ...(throughputMode ? { throughputMode } : {}),
      ...(provisionedThroughputMibps !== undefined ? { provisionedThroughputMibps } : {}),
      ...(encrypted !== undefined ? { encrypted } : {}),
    },
  }
}

/** CloudFront only serves certificates issued in us-east-1. */
const CDN_CERTIFICATE_REGION = 'us-east-1'

export async function awsCertificateRegions(
  flag: string | undefined,
  available: { code: string; name: string }[]
): Promise<Result<string[]>> {
  const codes = new Set(available.map((r) => r.code))
  let regions: string[]
  if (flag !== undefined) {
    regions = flag
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean)
    const unknown = regions.filter((r) => !codes.has(r))
    if (unknown.length > 0) {
      return {
        ok: false,
        message: `Unknown region: ${unknown.join(', ')}. See "gantry regions --cloud <id>".`,
      }
    }
  } else {
    regions = await checkbox({
      message: 'Certificate regions:',
      choices: available.map((r) => ({
        name: `${r.code} — ${r.name}`,
        value: r.code,
        checked: r.code === CDN_CERTIFICATE_REGION,
      })),
      required: true,
    })
  }
  if (regions.length === 0) return { ok: false, message: 'Choose at least one region.' }

  if (!regions.includes(CDN_CERTIFICATE_REGION)) {
    console.log(
      `\n  ⚠ CloudFront distributions require certificates in ${CDN_CERTIFICATE_REGION}. If you plan to use CloudFront CDN, consider including that region.\n`
    )
  }
  return { ok: true, value: regions }
}
