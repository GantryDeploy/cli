import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

import { isRecord } from './is-record'

const CREDENTIALS_PATH = join(homedir(), '.gantry', 'credentials')

/** Where `gantry login` writes, and `loadToken` reads. */
export function credentialsPath(): string {
  return CREDENTIALS_PATH
}

export function loadToken(): string | null {
  const envToken = process.env.GANTRY_API_TOKEN
  if (envToken) {
    return envToken
  }

  if (existsSync(CREDENTIALS_PATH)) {
    try {
      const content = readFileSync(CREDENTIALS_PATH, 'utf-8')
      const credentials: unknown = JSON.parse(content)
      if (isRecord(credentials) && typeof credentials.token === 'string' && credentials.token) {
        return credentials.token
      }
    } catch {
      // An unreadable credentials file counts as logged out.
    }
  }

  return null
}

export function getApiUrl(): string {
  const fromEnv = process.env.GANTRY_API_URL
  const url = fromEnv === undefined || fromEnv === '' ? 'https://api.gantrydeploy.com' : fromEnv
  validateApiUrl(url)
  return url
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * The API token rides on every request, so a remote endpoint must be HTTPS.
 * Plain HTTP is allowed only on loopback, for local development.
 */
export function validateApiUrl(value: string): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('GANTRY_API_URL is not a valid URL.')
  }

  if (url.username || url.password) {
    throw new Error('GANTRY_API_URL must not contain a username or password.')
  }
  if (url.protocol === 'https:') return
  if (url.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(url.hostname)) return
  if (url.protocol === 'http:') {
    throw new Error(
      'GANTRY_API_URL must use https. Plain http is allowed only for localhost, 127.0.0.1 and [::1].'
    )
  }
  throw new Error('GANTRY_API_URL must be an https URL.')
}

/** Set by the global `--team` flag, before any command runs. */
let teamOverride: string | null = null

export function setTeam(team: string | undefined): void {
  teamOverride = team ?? null
}

/**
 * The team every request in this invocation acts on.
 *
 * Only matters for a personal token that covers several teams: with one team
 * the API settles it from the token, and for anything addressed by resource id
 * it derives the team from the resource. Priority mirrors the token:
 * `--team` beats `GANTRY_TEAM`, which is there for CI.
 */
export function getTeam(): string | null {
  return teamOverride ?? process.env.GANTRY_TEAM ?? null
}
