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
  AwsFirewallAction,
  AwsFirewallBotCategory,
  AwsFirewallConditionField,
  AwsFirewallConditionInput,
  AwsFirewallManagedGroup,
  AwsFirewallMatchCombine,
  AwsFirewallMatchInput,
  AwsFirewallRateAggregate,
  AwsFirewallRuleInput,
  AwsFirewallRuleKind,
  AwsFirewallTextOperator,
  AwsNatGatewayOptionEnum,
  AwsNetworkSettingsInput,
} from '../../generated/graphql'
import { isRecord } from '../is-record'
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

export interface AwsNetworkUpdateFlags extends AwsNetworkFlags {
  awsInternet?: boolean
}

/** `gantry networks update` AWS flags, with the warnings a confirmation shows. */
export function buildAwsNetworkUpdate(
  flags: AwsNetworkUpdateFlags
): Result<{ aws: AwsNetworkSettingsInput; warnings: string[] }> {
  const internet = choose(flags.awsInternet, flags.awsNoInternet, 'internet')
  if (!internet.ok) return internet
  const settings = buildAwsNetworkSettings({ awsNat: flags.awsNat })
  if (!settings.ok) return settings

  const aws: AwsNetworkSettingsInput = { ...settings.value }
  if (internet.value !== undefined) aws.enableInternetAccess = internet.value

  const warnings: string[] = []
  if (aws.enableInternetAccess === false) {
    warnings.push(
      'The network loses its internet gateway and NAT gateways, so nothing in it can reach the internet.'
    )
  } else if (aws.natGatewayOption === 'NONE') {
    warnings.push('Services in private subnets lose outbound internet access.')
  } else if (aws.natGatewayOption === 'PER_AZ') {
    warnings.push('A NAT gateway in every zone costs more and survives a zone outage.')
  }
  return { ok: true, value: { aws, warnings } }
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

export interface AwsCacheUpdateFlags {
  awsNodes?: string
  awsShards?: string
  awsReplicas?: string
  awsMaxStorage?: string
  awsMaxEcpu?: string
  awsSnapshotTime?: string
}

const AWS_CACHE_NUMBER_FLAGS = [
  ['awsNodes', '--aws-nodes', 'numCacheNodes'],
  ['awsShards', '--aws-shards', 'numNodeGroups'],
  ['awsReplicas', '--aws-replicas', 'replicasPerNodeGroup'],
  ['awsMaxStorage', '--aws-max-storage', 'maxDataStorageGb'],
  ['awsMaxEcpu', '--aws-max-ecpu', 'maxEcpuPerSecond'],
] as const

const SNAPSHOT_TIME = /^([01]\d|2[0-3]):[0-5]\d$/

export function buildAwsCacheUpdate(flags: AwsCacheUpdateFlags): Result<AwsCacheSettingsInput> {
  const aws: AwsCacheSettingsInput = {}
  for (const [option, flag, field] of AWS_CACHE_NUMBER_FLAGS) {
    const raw = flags[option]
    if (raw === undefined) continue
    const value = parseNumber(raw, true)
    if (value === null) return { ok: false, message: notANumberMessage(flag, true) }
    aws[field] = value
  }
  if (flags.awsSnapshotTime !== undefined) {
    if (!SNAPSHOT_TIME.test(flags.awsSnapshotTime)) {
      return { ok: false, message: '--aws-snapshot-time must be a UTC time like 03:30.' }
    }
    aws.dailySnapshotTime = flags.awsSnapshotTime
  }
  return { ok: true, value: aws }
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

const AWS_FIREWALL_RULE_KINDS = {
  MANAGED_GROUP: true,
  RATE_LIMIT: true,
  BOT_CONTROL: true,
  CUSTOM: true,
} as const satisfies Record<AwsFirewallRuleKind, true>

const AWS_FIREWALL_MANAGED_GROUPS = {
  IP_REPUTATION: true,
  COMMON: true,
  KNOWN_BAD_INPUTS: true,
  SQL: true,
  LINUX: true,
  PHP: true,
  WORDPRESS: true,
} as const satisfies Record<AwsFirewallManagedGroup, true>

const AWS_FIREWALL_ACTIONS = {
  BLOCK: true,
  ALLOW: true,
  COUNT: true,
  CAPTCHA: true,
  CHALLENGE: true,
} as const satisfies Record<AwsFirewallAction, true>

const AWS_FIREWALL_RATE_AGGREGATES = {
  IP: 'per IP',
  FORWARDED_IP: 'per forwarded IP',
} as const satisfies Record<AwsFirewallRateAggregate, string>

const AWS_FIREWALL_COMBINES = {
  ALL: ' and ',
  ANY: ' or ',
} as const satisfies Record<AwsFirewallMatchCombine, string>

const AWS_FIREWALL_CONDITION_FIELDS = {
  PATH: true,
  IP: true,
  COUNTRY: true,
  HEADER: true,
  METHOD: true,
  QUERY_PARAM: true,
  BODY_SIZE: true,
} as const satisfies Record<AwsFirewallConditionField, true>

const AWS_FIREWALL_TEXT_OPERATORS = {
  EXACT: '=',
  STARTS_WITH: 'starts with',
  ENDS_WITH: 'ends with',
  CONTAINS: 'contains',
  REGEX: 'matches',
} as const satisfies Record<AwsFirewallTextOperator, string>

const AWS_FIREWALL_BOT_CATEGORIES = {
  ADVERTISING: true,
  AI: true,
  ARCHIVER: true,
  CONTENT_FETCHER: true,
  EMAIL_CLIENT: true,
  HTTP_LIBRARY: true,
  LINK_CHECKER: true,
  MISCELLANEOUS: true,
  MONITORING: true,
  PAGE_PREVIEW: true,
  SCRAPING_FRAMEWORK: true,
  SEARCH_ENGINE: true,
  SECURITY: true,
  SEO: true,
  SOCIAL_MEDIA: true,
  WEBHOOKS: true,
  AUTOMATED_BROWSER: true,
  KNOWN_BOT_DATA_CENTER: true,
  NON_BROWSER_USER_AGENT: true,
} as const satisfies Record<AwsFirewallBotCategory, true>

/** Stored rules and rules files spell enum values in kebab case (`rate-limit`). */
function kebab(value: string): string {
  return value.toLowerCase().replaceAll('_', '-')
}

class AwsFirewallRulesShapeError extends Error {}

function refuse(at: string, message: string): never {
  throw new AwsFirewallRulesShapeError(`${at}: ${message}.`)
}

function readRecord(value: unknown, at: string): Record<string, unknown> {
  if (!isRecord(value)) refuse(at, 'must be an object')
  return value
}

function readText(fields: Record<string, unknown>, key: string, at: string): string {
  const value = fields[key]
  if (typeof value !== 'string') refuse(at, `${key} must be text`)
  return value
}

function readBoolean(fields: Record<string, unknown>, key: string, at: string): boolean {
  const value = fields[key]
  if (typeof value !== 'boolean') refuse(at, `${key} must be true or false`)
  return value
}

function readInteger(fields: Record<string, unknown>, key: string, at: string): number {
  const value = fields[key]
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    refuse(at, `${key} must be a whole number`)
  }
  return value
}

function readTexts(fields: Record<string, unknown>, key: string, at: string): string[] {
  const value = fields[key]
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    refuse(at, `${key} must be a list of text`)
  }
  return value
}

function toEnum<T extends string>(raw: unknown, values: Record<T, unknown>): T | undefined {
  return (Object.keys(values) as T[]).find((value) => kebab(value) === raw)
}

function readEnum<T extends string>(
  fields: Record<string, unknown>,
  key: string,
  at: string,
  values: Record<T, unknown>
): T {
  const value = toEnum(fields[key], values)
  if (!value) refuse(at, `${key} must be ${Object.keys(values).map(kebab).join(', ')}`)
  return value
}

function readEnums<T extends string>(
  fields: Record<string, unknown>,
  key: string,
  at: string,
  values: Record<T, unknown>
): T[] {
  const raw = fields[key]
  const read = Array.isArray(raw) ? raw.map((item) => toEnum(item, values)) : []
  if (!Array.isArray(raw) || read.some((value) => value === undefined)) {
    refuse(at, `${key} must be a list of ${Object.keys(values).map(kebab).join(', ')}`)
  }
  return read.filter((value) => value !== undefined)
}

interface Read<T> {
  input: T
  summary: string
}

function textComparison(subject: string, operator: AwsFirewallTextOperator, value: string): string {
  return `${subject} ${AWS_FIREWALL_TEXT_OPERATORS[operator]} ${value}`
}

function pathSummary(operator: AwsFirewallTextOperator, value: string): string {
  if (operator === 'EXACT') return value
  if (operator === 'STARTS_WITH') return `${value}*`
  if (operator === 'ENDS_WITH') return `*${value}`
  if (operator === 'CONTAINS') return `*${value}*`
  return `path matching ${value}`
}

function readCondition(value: unknown, at: string): Read<AwsFirewallConditionInput> {
  const fields = readRecord(value, at)
  const field = readEnum(fields, 'field', at, AWS_FIREWALL_CONDITION_FIELDS)
  const negate = fields.negate === undefined ? undefined : readBoolean(fields, 'negate', at)

  let read: Read<AwsFirewallConditionInput>
  if (field === 'PATH' || field === 'HEADER' || field === 'QUERY_PARAM') {
    const operator = readEnum(fields, 'operator', at, AWS_FIREWALL_TEXT_OPERATORS)
    const text = readText(fields, 'value', at)
    if (field === 'PATH') {
      read = { input: { field, operator, value: text }, summary: pathSummary(operator, text) }
    } else {
      const name = readText(fields, 'name', at)
      const subject = field === 'HEADER' ? `header ${name}` : `query ${name}`
      read = {
        input: { field, name, operator, value: text },
        summary: textComparison(subject, operator, text),
      }
    }
  } else if (field === 'IP') {
    const cidrs = readTexts(fields, 'cidrs', at)
    read = { input: { field, cidrs }, summary: `IP in ${cidrs.join(', ')}` }
  } else if (field === 'COUNTRY') {
    const countries = readTexts(fields, 'countries', at)
    read = { input: { field, countries }, summary: `country in ${countries.join(', ')}` }
  } else if (field === 'METHOD') {
    const methods = readTexts(fields, 'methods', at)
    read = { input: { field, methods }, summary: `method ${methods.join(', ')}` }
  } else {
    const greaterThan = readInteger(fields, 'greaterThan', at)
    read = {
      input: { field, greaterThan },
      summary: `body over ${greaterThan.toLocaleString('en-US')} bytes`,
    }
  }

  if (negate === undefined) return read
  return {
    input: { ...read.input, negate },
    summary: negate ? `not ${read.summary}` : read.summary,
  }
}

function readMatch(value: unknown, at: string): Read<AwsFirewallMatchInput> {
  const fields = readRecord(value, `${at} match`)
  const combine = readEnum(fields, 'combine', `${at} match`, AWS_FIREWALL_COMBINES)
  const raw = fields.conditions
  if (!Array.isArray(raw)) refuse(`${at} match`, 'conditions must be a list')
  const conditions = raw.map((condition, index) =>
    readCondition(condition, `${at} condition ${String(index + 1)}`)
  )
  return {
    input: { combine, conditions: conditions.map((c) => c.input) },
    summary: conditions.map((c) => c.summary).join(AWS_FIREWALL_COMBINES[combine]),
  }
}

function readRule(value: unknown, at: string): Read<AwsFirewallRuleInput> {
  const fields = readRecord(value, at)
  const kind = readEnum(fields, 'kind', at, AWS_FIREWALL_RULE_KINDS)
  const base = {
    ...(fields.id === undefined ? {} : { id: readText(fields, 'id', at) }),
    name: readText(fields, 'name', at),
    enabled: readBoolean(fields, 'enabled', at),
    kind,
  }

  if (kind === 'MANAGED_GROUP') {
    const group = readEnum(fields, 'group', at, AWS_FIREWALL_MANAGED_GROUPS)
    const countRules = fields.countRules === undefined ? [] : readTexts(fields, 'countRules', at)
    return {
      input: { ...base, managedGroup: { group, countRules } },
      summary:
        countRules.length > 0 ? `${kebab(group)}, counting ${countRules.join(', ')}` : kebab(group),
    }
  }

  if (kind === 'RATE_LIMIT') {
    const limit = readInteger(fields, 'limit', at)
    const windowSeconds = readInteger(fields, 'windowSeconds', at)
    const aggregate = readEnum(fields, 'aggregate', at, AWS_FIREWALL_RATE_AGGREGATES)
    const action = readEnum(fields, 'action', at, AWS_FIREWALL_ACTIONS)
    const match = fields.match === undefined ? undefined : readMatch(fields.match, at)
    const scope = match ? ` on ${match.summary}` : ''
    return {
      input: {
        ...base,
        rateLimit: {
          limit,
          windowSeconds,
          aggregate,
          action,
          ...(match ? { match: match.input } : {}),
        },
      },
      summary: `${limit.toLocaleString('en-US')} per ${String(windowSeconds / 60)} min ${AWS_FIREWALL_RATE_AGGREGATES[aggregate]}${scope} → ${kebab(action)}`,
    }
  }

  if (kind === 'BOT_CONTROL') {
    const block = readEnums(fields, 'block', at, AWS_FIREWALL_BOT_CATEGORIES)
    return {
      input: { ...base, botControl: { block } },
      summary: block.length > 0 ? `blocks ${block.map(kebab).join(', ')}` : 'counts every category',
    }
  }

  const match = readMatch(fields.match, at)
  const action = readEnum(fields, 'action', at, AWS_FIREWALL_ACTIONS)
  return {
    input: { ...base, custom: { match: match.input, action } },
    summary: `${match.summary} → ${kebab(action)}`,
  }
}

function readRules(list: unknown): Result<Read<AwsFirewallRuleInput>[]> {
  if (!Array.isArray(list)) return { ok: false, message: 'It must be a list of rules.' }
  try {
    return {
      ok: true,
      value: list.map((rule, index) => readRule(rule, `Rule ${String(index + 1)}`)),
    }
  } catch (error) {
    if (error instanceof AwsFirewallRulesShapeError) return { ok: false, message: error.message }
    throw error
  }
}

/**
 * Reads a rules file (the list `firewalls rules --json` prints) into the input
 * `setFirewallRules` takes. A rule without an `id` is new.
 */
export function parseAwsFirewallRules(list: unknown): Result<AwsFirewallRuleInput[]> {
  const read = readRules(list)
  return read.ok ? { ok: true, value: read.value.map((rule) => rule.input) } : read
}

/** The rule list an AWS firewall stores, in evaluation order. */
export function awsFirewallStoredRules(rules: Record<string, unknown>): unknown[] {
  if (!Array.isArray(rules.rules)) {
    throw new Error('The firewall rules are not in the expected shape.')
  }
  return rules.rules
}

export interface AwsFirewallRuleRow {
  name: string
  kind: string
  enabled: boolean
  summary: string
}

/** An AWS firewall's rules in evaluation order, with a one-line summary of each. */
export function awsFirewallRuleRows(rules: Record<string, unknown>): AwsFirewallRuleRow[] {
  const read = readRules(awsFirewallStoredRules(rules))
  if (!read.ok) throw new Error('The firewall rules are not in the expected shape.')
  return read.value.map(({ input, summary }) => ({
    name: input.name,
    kind: kebab(input.kind),
    enabled: input.enabled,
    summary,
  }))
}
