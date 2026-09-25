import { describe, expect, expectTypeOf, it } from 'vitest'

import type { CacheEngineEnum, DatabaseEngineEnum } from '../generated/graphql'

import {
  getDefaultPort,
  getEngineFamily,
  normalizeEngine,
  toCacheEngineEnum,
  toCatalogEngine,
  toDatabaseEngineEnum,
} from './engine'

describe('engine', () => {
  it.each([
    ['REDIS', 6379],
    ['VALKEY', 6379],
    ['MEMCACHED', 11211],
    ['MYSQL', 3306],
    ['MARIADB', 3306],
    ['AURORA_MYSQL', 3306],
    ['POSTGRESQL', 5432],
    ['AURORA_POSTGRESQL', 5432],
    ['valkey', 6379],
    ['aurora-mysql', 3306],
    ['postgres', 5432],
  ])('getDefaultPort(%s) is %i', (engine, port) => {
    expect(getDefaultPort(engine)).toBe(port)
  })

  it('maps API enum names and catalog names to the same family', () => {
    expect(getEngineFamily('AURORA_MYSQL')).toBe(getEngineFamily('aurora-mysql'))
    expect(getEngineFamily('VALKEY')).toBe('redis')
    expect(getEngineFamily(' MEMCACHED ')).toBe('memcached')
  })

  it.each(['SQLSERVER', 'dragonfly', ''])('rejects the unknown engine %j', (engine) => {
    expect(() => getEngineFamily(engine)).toThrow('Unknown database or cache engine.')
    expect(() => getDefaultPort(engine)).toThrow('Unknown database or cache engine.')
  })

  it('does not echo the unknown engine back in the error', () => {
    expect(() => getDefaultPort('\u001b[2Jevil')).toThrow(/^Unknown database or cache engine\.$/)
  })

  it.each([
    ['AURORA_POSTGRESQL', 'aurora-postgresql'],
    [' Redis ', 'redis'],
  ])('normalizeEngine(%j) is %s', (engine, expected) => {
    expect(normalizeEngine(engine)).toBe(expected)
  })

  it.each([
    ['VALKEY', 'valkey'],
    ['valkey', 'valkey'],
    ['AURORA_POSTGRESQL', 'aurora-postgresql'],
    ['POSTGRESQL', 'postgres'],
    ['postgresql', 'postgres'],
    ['AURORA_MYSQL', 'aurora-mysql'],
  ])('toCatalogEngine(%s) is %s', (engine, expected) => {
    expect(toCatalogEngine(engine)).toBe(expected)
  })

  it.each([
    ['valkey', 'VALKEY'],
    ['Redis', 'REDIS'],
    ['MEMCACHED', 'MEMCACHED'],
  ])('toCacheEngineEnum(%s) is %s', (engine, expected) => {
    expect(toCacheEngineEnum(engine)).toBe(expected)
  })

  it.each([
    ['aurora-postgresql', 'AURORA_POSTGRESQL'],
    ['AURORA_MYSQL', 'AURORA_MYSQL'],
    ['postgres', 'POSTGRESQL'],
    ['postgresql', 'POSTGRESQL'],
    ['mariadb', 'MARIADB'],
  ])('toDatabaseEngineEnum(%s) is %s', (engine, expected) => {
    expect(toDatabaseEngineEnum(engine)).toBe(expected)
  })

  it('rejects an engine the API does not know', () => {
    expect(() => toCacheEngineEnum('postgres')).toThrow(
      'Unknown cache engine. Supported engines: memcached, redis, valkey'
    )
    expect(() => toDatabaseEngineEnum('redis')).toThrow('Unknown database engine.')
  })

  it.each(['dragonfly', '', 'SQLSERVER', '\u001b[2Jevil'])(
    'rejects the unknown engine %j without echoing it back',
    (engine) => {
      expect(() => toCacheEngineEnum(engine)).toThrow(
        /^Unknown cache engine\. Supported engines: memcached, redis, valkey$/
      )
      expect(() => toDatabaseEngineEnum(engine)).toThrow(
        /^Unknown database engine\. Supported engines: aurora-mysql, aurora-postgresql, mariadb, mysql, postgresql$/
      )
    }
  )

  it('returns the generated enum types', () => {
    expectTypeOf(toCacheEngineEnum).returns.toEqualTypeOf<CacheEngineEnum>()
    expectTypeOf(toDatabaseEngineEnum).returns.toEqualTypeOf<DatabaseEngineEnum>()
  })
})
