import { input, select } from '@inquirer/prompts'
import type { Command } from 'commander'
import ora from 'ora'

import type {
  CreateCacheMutation,
  CreateCacheMutationVariables,
  GetCacheEngineVersionsQuery,
  GetCacheEngineVersionsQueryVariables,
  GetCacheNodeTypesQuery,
  GetCacheNodeTypesQueryVariables,
  GetCachesQuery,
  GetCachesQueryVariables,
  GetCacheTunnelBastionQuery,
  GetCacheTunnelBastionQueryVariables,
  GetCacheTypesQuery,
  GetCacheTypesQueryVariables,
} from '../generated/graphql'
import {
  activeOnly,
  createBastionInteractive,
  fetchBastionCredentials,
  selectBastion,
} from '../lib/bastion-prompts'
import { formatApiError, graphqlRequest } from '../lib/client'
import { getDefaultPort, normalizeEngine, toCacheEngineEnum, toCatalogEngine } from '../lib/engine'
import { selectCloud, selectNetwork } from '../lib/interactive-prompts'
import { bastionHostId } from '../lib/known-hosts'
import { createTable, formatDate, printError, printSuccess, slugify } from '../lib/output'
import { sanitizeTerminal } from '../lib/sanitize'
import { openSshTunnel } from '../lib/ssh-tunnel'

type Cache = GetCachesQuery['caches'][number]

type CacheEngineVersion = GetCacheEngineVersionsQuery['cacheEngineVersions'][number]

interface TunnelOptions {
  port?: string
  bastion?: string
  trustHostKey?: boolean
}

const CACHES_QUERY = /* GraphQL */ `
  query GetCaches {
    caches {
      id
      name
      slug
      engine
      status
      cloudAccountId
      networkId
      endpoint
      port
      createdAt
    }
  }
`

const CACHE_TYPES_QUERY = /* GraphQL */ `
  query GetCacheTypes($provider: String) {
    cacheTypes(provider: $provider) {
      type
      displayName
      provider
      description
      guidance
      supportsServerless
      supportsClusterMode
      requiresNetwork
    }
  }
`

const CACHE_ENGINE_VERSIONS_QUERY = /* GraphQL */ `
  query GetCacheEngineVersions($engine: String, $region: String) {
    cacheEngineVersions(engine: $engine, region: $region) {
      engine
      version
      family
      supportedModes
    }
  }
`

const CACHE_NODE_TYPES_QUERY = /* GraphQL */ `
  query GetCacheNodeTypes($engine: String, $region: String) {
    cacheNodeTypes(engine: $engine, region: $region) {
      nodeType
      family
      size
      memoryGiB
      vcpu
    }
  }
`

const CREATE_CACHE_MUTATION = /* GraphQL */ `
  mutation CreateCache($input: CreateCacheInput!) {
    createCache(input: $input) {
      success
      message
      cache {
        id
        name
        slug
        engine
        status
      }
      deploymentId
    }
  }
`

async function fetchCacheEngineVersions(filters: {
  engine?: string
  region?: string
  mode?: string
}): Promise<CacheEngineVersion[]> {
  const variables: GetCacheEngineVersionsQueryVariables = {}
  if (filters.engine) variables.engine = toCatalogEngine(filters.engine)
  if (filters.region) variables.region = filters.region

  const data = await graphqlRequest<
    GetCacheEngineVersionsQuery,
    GetCacheEngineVersionsQueryVariables
  >(CACHE_ENGINE_VERSIONS_QUERY, variables)

  const { mode } = filters
  if (!mode) return data.cacheEngineVersions
  return data.cacheEngineVersions.filter((v) => v.supportedModes.includes(mode))
}

async function findCache(slugOrId: string): Promise<Cache | undefined> {
  const data = await graphqlRequest<GetCachesQuery, GetCachesQueryVariables>(CACHES_QUERY)
  return data.caches.find((c) => c.id === slugOrId) ?? data.caches.find((c) => c.slug === slugOrId)
}

export function registerCachesCommand(program: Command): void {
  const cachesCmd = program.command('caches').description('Manage caches')

  cachesCmd
    .command('list')
    .description('List all caches')
    .action(async () => {
      try {
        const data = await graphqlRequest<GetCachesQuery, GetCachesQueryVariables>(CACHES_QUERY)
        const { caches } = data

        if (caches.length === 0) {
          console.log('No caches found.')
          return
        }

        const table = createTable({
          head: ['ID', 'Name', 'Slug', 'Engine', 'Status', 'Created'],
        })

        for (const cache of caches) {
          table.push([
            cache.id,
            cache.name,
            cache.slug,
            cache.engine,
            cache.status.toUpperCase(),
            formatDate(cache.createdAt),
          ])
        }

        console.log(table.toString())
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })

  cachesCmd
    .command('engines')
    .description('List available cache engines')
    .action(async () => {
      try {
        const data = await graphqlRequest<GetCacheTypesQuery, GetCacheTypesQueryVariables>(
          CACHE_TYPES_QUERY
        )

        const table = createTable({
          head: ['Engine', 'Name', 'Description', 'Serverless', 'Cluster Mode'],
        })

        for (const t of data.cacheTypes) {
          table.push([
            t.type,
            t.displayName,
            t.description,
            t.supportsServerless ? 'Yes' : 'No',
            t.supportsClusterMode ? 'Yes' : 'No',
          ])
        }

        console.log(table.toString())
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })

  cachesCmd
    .command('engine-versions')
    .description('List available cache engine versions')
    .option('--engine <engine>', 'Filter by engine')
    .option('--region <region>', 'Filter by region')
    .option('--mode <mode>', 'Filter by deployment mode (serverless, node-based)')
    .action(async (options: { engine?: string; region?: string; mode?: string }) => {
      try {
        const versions = await fetchCacheEngineVersions(options)

        if (versions.length === 0) {
          console.log('No engine versions found matching the filters.')
          return
        }

        const table = createTable({
          head: ['Engine', 'Version', 'Family', 'Modes'],
        })

        for (const v of versions) {
          table.push([v.engine, v.version, v.family, v.supportedModes.join(', ')])
        }

        console.log(table.toString())
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })

  cachesCmd
    .command('node-types')
    .description('List available cache node types')
    .option('--engine <engine>', 'Filter by engine')
    .option('--region <region>', 'Filter by region')
    .action(async (options: { engine?: string; region?: string }) => {
      try {
        const variables: GetCacheNodeTypesQueryVariables = {}
        if (options.engine) variables.engine = toCatalogEngine(options.engine)
        if (options.region) variables.region = options.region

        const data = await graphqlRequest<GetCacheNodeTypesQuery, GetCacheNodeTypesQueryVariables>(
          CACHE_NODE_TYPES_QUERY,
          variables
        )

        if (data.cacheNodeTypes.length === 0) {
          console.log('No node types found matching the filters.')
          return
        }

        const table = createTable({
          head: ['Node Type', 'Family', 'Size', 'Memory (GiB)', 'vCPU'],
        })

        for (const nt of data.cacheNodeTypes) {
          table.push([nt.nodeType, nt.family, nt.size, String(nt.memoryGiB), String(nt.vcpu)])
        }

        console.log(table.toString())
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })

  cachesCmd
    .command('create')
    .description('Create a new cache')
    .option('--cloud <id>', 'Cloud account ID')
    .option('--network <id>', 'Network ID')
    .option('--name <name>', 'Cache name')
    .option('--slug <slug>', 'Cache slug (auto-generated from name if omitted)')
    .option('--engine <engine>', 'Cache engine (see "gantry caches engines")')
    .option('--node-type <type>', 'Node type (see "gantry caches node-types")')
    .option('--engine-version <version>', 'Engine version (see "gantry caches engine-versions")')
    .option('--serverless', 'Use serverless mode')
    .action(
      async (options: {
        cloud?: string
        network?: string
        name?: string
        slug?: string
        engine?: string
        nodeType?: string
        engineVersion?: string
        serverless?: boolean
      }) => {
        try {
          const cloudAccountId = options.cloud ?? (await selectCloud())
          const networkId = options.network ?? (await selectNetwork(cloudAccountId))
          if (!networkId) {
            printError('A network is required to create a cache.')
            process.exit(1)
          }

          const name =
            options.name ??
            (await input({
              message: 'Cache name:',
              validate: (v) => (v.trim().length > 0 ? true : 'Name is required'),
            }))

          let selectedEngine = options.engine
          if (!selectedEngine) {
            const enginesData = await graphqlRequest<
              GetCacheTypesQuery,
              GetCacheTypesQueryVariables
            >(CACHE_TYPES_QUERY)

            selectedEngine = await select({
              message: 'Cache engine:',
              choices: enginesData.cacheTypes.map((t) => ({
                name: `${t.displayName} — ${t.description}`,
                value: t.type,
              })),
            })
          }
          const engine = toCacheEngineEnum(selectedEngine)

          let useServerless = options.serverless ?? false
          if (!options.serverless && options.serverless === undefined) {
            const enginesData = await graphqlRequest<
              GetCacheTypesQuery,
              GetCacheTypesQueryVariables
            >(CACHE_TYPES_QUERY)
            const engineInfo = enginesData.cacheTypes.find(
              (t) => normalizeEngine(t.type) === normalizeEngine(engine)
            )
            if (engineInfo?.supportsServerless) {
              useServerless = await select({
                message: 'Use serverless mode?',
                choices: [
                  { name: 'No', value: false },
                  { name: 'Yes', value: true },
                ],
              })
            }
          }

          let engineVersion = options.engineVersion
          if (!engineVersion) {
            const versions = await fetchCacheEngineVersions({
              engine,
              mode: useServerless ? 'serverless' : 'node-based',
            })

            if (versions.length > 0) {
              engineVersion = await select({
                message: 'Engine version:',
                choices: versions.map((v) => ({
                  name: `${v.version} (${v.family})`,
                  value: v.version,
                })),
              })
            }
          }

          let nodeType = options.nodeType
          if (!nodeType && !useServerless) {
            const typesData = await graphqlRequest<
              GetCacheNodeTypesQuery,
              GetCacheNodeTypesQueryVariables
            >(CACHE_NODE_TYPES_QUERY, { engine: toCatalogEngine(engine) })

            if (typesData.cacheNodeTypes.length > 0) {
              nodeType = await select({
                message: 'Node type:',
                choices: typesData.cacheNodeTypes.map((nt) => ({
                  name: `${nt.nodeType} — ${String(nt.vcpu)} vCPU, ${String(nt.memoryGiB)} GiB RAM`,
                  value: nt.nodeType,
                })),
              })
            }
          }

          // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty --slug string should fall back to a slug derived from the name, not be used verbatim
          const slug = options.slug || slugify(name)
          const providerData: Record<string, unknown> = {
            deploymentMode: useServerless ? 'serverless' : 'node-based',
          }
          if (nodeType) providerData.nodeType = nodeType
          if (engineVersion) providerData.engineVersion = engineVersion

          const data = await graphqlRequest<CreateCacheMutation, CreateCacheMutationVariables>(
            CREATE_CACHE_MUTATION,
            {
              input: {
                cloudAccountId,
                networkId,
                name,
                slug,
                engine,
                providerData,
              },
            }
          )

          const result = data.createCache
          const cache = result.cache
          if (!result.success || !cache) {
            printError(result.message ?? 'Failed to create cache')
            process.exit(1)
          }

          printSuccess(`Cache created: ${cache.name} (${cache.slug})`)
          console.log(`  ID: ${cache.id}`)
          if (result.deploymentId) {
            console.log(`  Deployment: ${result.deploymentId}`)
          }
        } catch (error) {
          printError(formatApiError(error))
          process.exit(1)
        }
      }
    )

  cachesCmd
    .command('tunnel')
    .description('Create a local tunnel to a cache')
    .argument('[slug]', 'Cache slug')
    .option('--port <port>', 'Local port to expose')
    .option('--bastion <slug>', 'Bastion host slug')
    .option('--trust-host-key', 'Trust and record an unknown bastion host key without prompting')
    .action(async (slug?: string, options?: TunnelOptions) => {
      try {
        let cache: Cache

        if (slug) {
          const found = await findCache(slug)
          if (!found) {
            printError('Cache not found.')
            process.exit(1)
          }
          cache = found
        } else {
          const data = await graphqlRequest<GetCachesQuery, GetCachesQueryVariables>(CACHES_QUERY)
          const activeCaches = data.caches.filter((c) => c.status.toLowerCase() === 'active')

          if (activeCaches.length === 0) {
            printError('No active caches found.')
            process.exit(1)
          }

          const selectedId = await select({
            message: 'Select a cache:',
            choices: activeCaches.map((c) => ({
              name: `${c.name} (${c.engine}) — ${c.slug}`,
              value: c.id,
            })),
          })

          const selected = activeCaches.find((c) => c.id === selectedId)
          if (!selected) {
            printError('Cache not found.')
            process.exit(1)
          }
          cache = selected
        }

        const remoteHost = cache.endpoint?.split(':')[0] ?? ''

        if (!remoteHost) {
          printError('Cache endpoint not available. The cache may still be provisioning.')
          process.exit(1)
        }

        const remotePort = cache.port ?? getDefaultPort(cache.engine)

        const localPort = options?.port
          ? parseInt(options.port, 10)
          : parseInt(
              await input({
                message: 'Local port to expose:',
                default: String(remotePort),
                validate: (v) => {
                  const n = parseInt(v, 10)
                  if (isNaN(n) || n < 1 || n > 65535) return 'Enter a valid port (1-65535)'
                  return true
                },
              }),
              10
            )

        let bastionSlug: string

        if (options?.bastion) {
          bastionSlug = options.bastion
        } else {
          const result = await selectBastion({
            networkId: cache.networkId,
            includeCreateOption: true,
            filter: activeOnly,
          })

          if (result === 'create') {
            const bastion = await createBastionInteractive({
              cloudAccountId: cache.cloudAccountId,
              networkId: cache.networkId,
              waitForActive: true,
            })
            bastionSlug = bastion.slug
          } else {
            bastionSlug = result.slug
          }
        }

        const spinner = ora('Connecting tunnel...').start()

        try {
          const credentials = await fetchBastionCredentials(bastionSlug)
          const bastionData = await graphqlRequest<
            GetCacheTunnelBastionQuery,
            GetCacheTunnelBastionQueryVariables
          >(
            /* GraphQL */ `
              query GetCacheTunnelBastion($slug: String!) {
                bastion(slug: $slug) {
                  id
                  instanceId
                  publicIp
                }
              }
            `,
            {
              slug: bastionSlug,
            }
          )

          const { bastion } = bastionData
          const bastionIp = bastion?.publicIp
          if (!bastion || !bastionIp) {
            spinner.fail('Bastion host does not have a public IP address.')
            process.exit(1)
          }

          const tunnel = await openSshTunnel({
            bastionHost: bastionIp,
            hostKey: {
              hostId: bastionHostId(bastion),
              label: bastionSlug,
              expectedFingerprint: credentials.hostKeyFingerprint,
              trustHostKey: options?.trustHostKey,
              pauseOutput: () => spinner.stop(),
              resumeOutput: () => spinner.start(),
            },
            privateKey: credentials.privateKey,
            remoteHost,
            remotePort,
            localPort,
          })

          spinner.succeed('Tunnel connected')
          console.log(`  Host:     localhost`)
          console.log(`  Port:     ${String(tunnel.localPort)}`)
          console.log(`  Engine:   ${sanitizeTerminal(cache.engine)}`)
          console.log(`  Cache:    ${sanitizeTerminal(remoteHost)}`)
          console.log('')
          console.log('  Press Ctrl+C to close the tunnel.')

          await new Promise<void>((resolve) => {
            let closing = false
            process.on('SIGINT', () => {
              void (async () => {
                if (closing) return
                closing = true
                console.log('\n  Closing tunnel...')
                await tunnel.close()
                resolve()
              })()
            })
          })
        } catch (error) {
          spinner.fail(
            `Failed to connect: ${error instanceof Error ? error.message : String(error)}`
          )
          process.exit(1)
        }
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })
}
