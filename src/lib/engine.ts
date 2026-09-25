import type { CacheEngineEnum, DatabaseEngineEnum } from '../generated/graphql'

export type EngineFamily = 'postgres' | 'mysql' | 'redis' | 'memcached'

const POSTGRES_ENGINES = ['aurora-postgresql', 'postgresql', 'postgres']
const MYSQL_ENGINES = ['aurora-mysql', 'mysql', 'mariadb']
const REDIS_ENGINES = ['redis', 'valkey']
const MEMCACHED_ENGINES = ['memcached']

const CACHE_ENGINES = {
  MEMCACHED: 'MEMCACHED',
  REDIS: 'REDIS',
  VALKEY: 'VALKEY',
} as const satisfies Record<CacheEngineEnum, CacheEngineEnum>

const DATABASE_ENGINES = {
  AURORA_MYSQL: 'AURORA_MYSQL',
  AURORA_POSTGRESQL: 'AURORA_POSTGRESQL',
  MARIADB: 'MARIADB',
  MYSQL: 'MYSQL',
  POSTGRESQL: 'POSTGRESQL',
} as const satisfies Record<DatabaseEngineEnum, DatabaseEngineEnum>

const PORT_MAP: Record<EngineFamily, number> = {
  postgres: 5432,
  mysql: 3306,
  redis: 6379,
  memcached: 11211,
}

/** Accepts either the API enum name (`AURORA_POSTGRESQL`) or the catalog form (`aurora-postgresql`). */
export function normalizeEngine(engine: string): string {
  return engine.trim().toLowerCase().replaceAll('_', '-')
}

export function getEngineFamily(engine: string): EngineFamily {
  const normalized = normalizeEngine(engine)
  if (POSTGRES_ENGINES.includes(normalized)) return 'postgres'
  if (MYSQL_ENGINES.includes(normalized)) return 'mysql'
  if (REDIS_ENGINES.includes(normalized)) return 'redis'
  if (MEMCACHED_ENGINES.includes(normalized)) return 'memcached'
  throw new Error('Unknown database or cache engine.')
}

export function getDefaultPort(engine: string): number {
  return PORT_MAP[getEngineFamily(engine)]
}

/** The engine string the server's version and instance-type catalogs compare against. */
export function toCatalogEngine(engine: string): string {
  const normalized = normalizeEngine(engine)
  return normalized === 'postgresql' ? 'postgres' : normalized
}

function toEnumMember<T extends string>(
  engine: string,
  members: Record<T, T>,
  kind: 'cache' | 'database'
): T {
  const normalized = normalizeEngine(engine)
  const name = (normalized === 'postgres' ? 'postgresql' : normalized)
    .replaceAll('-', '_')
    .toUpperCase()
  const allowed = Object.values<T>(members)
  const match = allowed.find((member) => member === name)
  if (!match) {
    throw new Error(
      `Unknown ${kind} engine. Supported engines: ${allowed.map(normalizeEngine).join(', ')}`
    )
  }
  return match
}

export function toCacheEngineEnum(engine: string): CacheEngineEnum {
  return toEnumMember(engine, CACHE_ENGINES, 'cache')
}

export function toDatabaseEngineEnum(engine: string): DatabaseEngineEnum {
  return toEnumMember(engine, DATABASE_ENGINES, 'database')
}
