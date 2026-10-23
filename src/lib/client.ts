import { randomUUID } from 'node:crypto'

import { getApiUrl, getTeam, loadToken } from './config'
import { isRecord } from './is-record'
import { redact, sanitizeTerminal } from './sanitize'

interface GraphqlError {
  message: string
  path?: string[]
  code?: string
}

/** Returns undefined when `value` is not a well-formed GraphQL `errors` array. */
function parseGraphqlErrors(value: unknown): GraphqlError[] | undefined {
  if (!Array.isArray(value)) return undefined
  const errors: GraphqlError[] = []
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.message !== 'string') return undefined
    const { path, extensions } = entry
    const error: GraphqlError = { message: entry.message }
    if (Array.isArray(path) && path.every((p) => typeof p === 'string' || typeof p === 'number')) {
      error.path = path.map(String)
    }
    if (isRecord(extensions) && typeof extensions.code === 'string') {
      error.code = extensions.code
    }
    errors.push(error)
  }
  return errors
}

export class GantryApiError extends Error {
  constructor(
    message: string,
    public errors?: GraphqlError[],
    public statusCode?: number,
    public responseBody?: string
  ) {
    super(message)
    this.name = 'GantryApiError'
  }
}

export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthenticationError'
  }
}

export class NetworkError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error
  ) {
    super(message)
    this.name = 'NetworkError'
  }
}

const MAX_RETRIES = 10
const MAX_RETRY_DELAY_MS = 60_000
const BASE_RETRY_DELAY_MS = 1_000

function getRetryDelay(attempt: number): number {
  const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt)
  return Math.min(delay, MAX_RETRY_DELAY_MS)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** A short, safe parenthetical such as " (ECONNREFUSED)", or '' when nothing is recognised. */
function extractCauseLabel(cause: Error | undefined): string {
  if (!cause?.message) return ''
  const msg = cause.message

  const codeMatch = /(ECONNREFUSED|ETIMEDOUT|ENOTFOUND|ECONNRESET|EPIPE)/i.exec(msg)
  if (codeMatch) return ` (${codeMatch[1].toUpperCase()})`

  if (msg.toLowerCase().includes('fetch failed')) return ' (fetch failed)'
  if (msg.toLowerCase().includes('socket hang up')) return ' (socket hang up)'
  if (msg.toLowerCase().includes('timeout')) return ' (timeout)'

  return ''
}

function buildNetworkError(error: unknown, apiUrl: string): NetworkError {
  const cause = error instanceof Error ? error : undefined
  const message = cause?.message.toLowerCase() ?? ''
  const causeLabel = extractCauseLabel(cause)

  if (message.includes('econnrefused') || message.includes('fetch failed')) {
    return new NetworkError(`Unable to connect to Gantry API at ${apiUrl}${causeLabel}.`, cause)
  }
  if (message.includes('etimedout') || message.includes('timeout')) {
    return new NetworkError(`Connection to Gantry API timed out at ${apiUrl}${causeLabel}.`, cause)
  }
  if (message.includes('enotfound') || message.includes('getaddrinfo')) {
    return new NetworkError(`Unable to resolve Gantry API host at ${apiUrl}${causeLabel}.`, cause)
  }
  if (message.includes('econnreset') || message.includes('socket hang up')) {
    return new NetworkError(
      `Connection to Gantry API was interrupted at ${apiUrl}${causeLabel}.`,
      cause
    )
  }
  return new NetworkError(`Unable to reach Gantry API at ${apiUrl}${causeLabel}.`, cause)
}

function cleanServerText(text: string): string {
  return sanitizeTerminal(redact(text))
}

async function buildResponseError(
  response: Response
): Promise<GantryApiError | AuthenticationError> {
  const status = response.status

  let bodySnippet: string | undefined
  try {
    const text = await response.text()
    bodySnippet = text.length > 500 ? text.slice(0, 500) + '...' : text
  } catch {
    // The status code alone still produces a useful error.
  }

  if (bodySnippet) {
    try {
      const errorBody: unknown = JSON.parse(bodySnippet.replace(/\.\.\.$/, ''))
      const errors = isRecord(errorBody) ? parseGraphqlErrors(errorBody.errors) : undefined
      if (errors && errors.length > 0) {
        return new GantryApiError(
          `Gantry API error (HTTP ${String(status)}): ${cleanServerText(errors[0].message)}`,
          errors,
          status,
          bodySnippet
        )
      }
    } catch {
      // Not JSON: fall through to the status-based message.
    }
  }

  if (status === 401) {
    return new AuthenticationError(
      'Invalid or expired API token. Run `gantry login`, or check GANTRY_API_TOKEN.'
    )
  }
  if (status === 403) {
    return new AuthenticationError('Access denied. You may not have permission for this action.')
  }

  const statusMessages: Record<number, string> = {
    400: 'Invalid request to Gantry API.',
    404: 'Gantry API endpoint not found.',
    500: 'Gantry API encountered an internal error.',
    502: 'Gantry API is temporarily unavailable.',
    503: 'Gantry API is temporarily unavailable.',
    504: 'Gantry API is temporarily unavailable.',
  }

  const baseMessage = statusMessages[status] ?? `Gantry API returned an error.`

  return new GantryApiError(
    `${baseMessage} (HTTP ${String(status)})`,
    undefined,
    status,
    bodySnippet
  )
}

/** Connection refused and host not found are not retried: the server is unreachable, and retrying only hangs the CLI. */
function isRetryable(error: unknown): boolean {
  if (error instanceof AuthenticationError) return false
  if (error instanceof NetworkError) {
    // Node's fetch wraps the real error (TypeError "fetch failed" -> cause -> ECONNREFUSED), so search the whole chain.
    const combined = collectErrorMessages(error)
    if (
      combined.includes('econnrefused') ||
      combined.includes('enotfound') ||
      combined.includes('getaddrinfo')
    ) {
      return false
    }
    return true
  }
  if (error instanceof GantryApiError) {
    // The API is still running the first attempt under this idempotency key.
    if (error.errors?.some((e) => e.code === 'IDEMPOTENCY_IN_PROGRESS')) return true
    return error.statusCode !== undefined && error.statusCode >= 500
  }
  return false
}

function collectErrorMessages(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    parts.push(current.message)
    const code = 'code' in current ? current.code : undefined
    if (typeof code === 'string') parts.push(code)
    current = current.cause
  }
  return parts.join(' ').toLowerCase()
}

const PRE_SEND_ERROR_CODES = ['ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']

function collectErrorCodes(error: unknown): string[] {
  const codes: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    const code = 'code' in current ? current.code : undefined
    if (typeof code === 'string') codes.push(code.toUpperCase())
    current = current.cause
  }
  return codes
}

/**
 * True only when the connection was never established, so the server cannot
 * have seen the request. A timeout or reset after connecting proves nothing.
 * Matches error codes only: messages embed the API URL, whose hostname could
 * contain a code by chance.
 */
function failedBeforeSending(error: unknown): boolean {
  if (!(error instanceof NetworkError)) return false
  return collectErrorCodes(error).some((code) => PRE_SEND_ERROR_CODES.includes(code))
}

function shouldRetry(error: unknown, unkeyedMutation: boolean): boolean {
  if (!isRetryable(error)) return false
  return !unkeyedMutation || failedBeforeSending(error)
}

/**
 * Whether the document's operation is a mutation. Scans top-level tokens only,
 * so fragments, comments, strings and selection sets cannot trigger a false
 * match. A document holding any mutation counts as one.
 */
export function isMutationDocument(document: string): boolean {
  let braceDepth = 0
  let parenDepth = 0
  let i = 0
  while (i < document.length) {
    const char = document[i]
    if (char === '#') {
      while (i < document.length && document[i] !== '\n' && document[i] !== '\r') i++
      continue
    }
    if (char === '"') {
      i = skipString(document, i)
      continue
    }
    if (char === '{') braceDepth++
    else if (char === '}') braceDepth--
    else if (char === '(') parenDepth++
    else if (char === ')') parenDepth--
    else if (/[_A-Za-z]/.test(char)) {
      const name = /^[_A-Za-z][_0-9A-Za-z]*/.exec(document.slice(i))?.[0] ?? ''
      const prefix = document[i - 1]
      if (
        name === 'mutation' &&
        braceDepth === 0 &&
        parenDepth === 0 &&
        prefix !== '$' &&
        prefix !== '@'
      ) {
        return true
      }
      i += name.length
      continue
    }
    i++
  }
  return false
}

function skipString(document: string, start: number): number {
  if (document.startsWith('"""', start)) {
    let i = start + 3
    while (i < document.length) {
      if (document[i] === '\\' && document.startsWith('\\"""', i)) {
        i += 4
        continue
      }
      if (document.startsWith('"""', i)) return i + 3
      i++
    }
    return i
  }
  let i = start + 1
  while (i < document.length && document[i] !== '"' && document[i] !== '\n') {
    i += document[i] === '\\' ? 2 : 1
  }
  return i + 1
}

/**
 * Make a GraphQL request to the Gantry Public API with retry logic.
 *
 * Retries up to MAX_RETRIES times with exponential backoff on transient
 * network errors (timeout, reset) and 5xx responses. Each mutation call sends
 * one `Idempotency-Key` on every attempt, so the API runs it at most once; a
 * retry that arrives while the first attempt is still running is retried too.
 *
 * Pass `idempotent: false` for a mutation the API does not deduplicate
 * (`runConsoleCommand`). It sends no key and retries only when the connection
 * was never established.
 *
 * Never retries 4xx responses, authentication errors, or connection refused /
 * host not found.
 */
export async function graphqlRequest<
  TData,
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- callers pass the generated `*Variables` type explicitly so `variables` is checked against the operation
  TVariables extends Record<string, unknown> = never,
>(
  query: string,
  variables?: TVariables,
  // `gantry login` verifies a token before it is written to disk, so it has one
  // in hand that `loadToken` cannot see yet.
  options?: { token?: string; idempotent?: false }
): Promise<TData> {
  const token = options?.token ?? loadToken()

  if (!token) {
    throw new AuthenticationError(
      'No API token found. Run `gantry login`, or set the GANTRY_API_TOKEN environment variable.'
    )
  }

  const apiUrl = getApiUrl()
  const mutation = isMutationDocument(query)
  const idempotencyKey = mutation && options?.idempotent !== false ? randomUUID() : undefined
  let lastError: Error | undefined

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await executeGraphqlRequest<TData>(apiUrl, token, query, variables, idempotencyKey)
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))

      if (!shouldRetry(error, mutation && !idempotencyKey)) {
        throw error
      }

      if (attempt < MAX_RETRIES - 1) {
        const delay = getRetryDelay(attempt)
        await sleep(delay)
      }
    }
  }

  throw lastError ?? new Error('GraphQL request failed after all retries')
}

async function executeGraphqlRequest<T>(
  apiUrl: string,
  token: string,
  query: string,
  variables?: Record<string, unknown>,
  idempotencyKey?: string
): Promise<T> {
  const team = getTeam()

  let response: Response
  try {
    response = await fetch(`${apiUrl}/public/graphql`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        // Sent as a header rather than a query argument so one flag covers every
        // command. A `team` argument on the operation still wins, for a client
        // that wants to name the team per call.
        ...(team ? { 'X-Gantry-Team': team } : {}),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (error) {
    throw buildNetworkError(error, apiUrl)
  }

  if (!response.ok) {
    throw await buildResponseError(response)
  }

  const invalidResponse = () =>
    new GantryApiError(
      `Invalid response from Gantry API. (HTTP ${String(response.status)})`,
      undefined,
      response.status
    )

  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw invalidResponse()
  }
  if (!isRecord(body)) {
    throw invalidResponse()
  }

  if (body.errors !== undefined && body.errors !== null) {
    const errors = parseGraphqlErrors(body.errors)
    if (!errors) {
      throw invalidResponse()
    }
    if (errors.length > 0) {
      throw new GantryApiError(
        `Gantry API error (HTTP ${String(response.status)}): ${cleanServerText(errors[0].message)}`,
        errors,
        response.status
      )
    }
  }

  if (!isRecord(body.data)) {
    throw new GantryApiError(
      `No data returned from API. (HTTP ${String(response.status)})`,
      undefined,
      response.status
    )
  }

  // The network boundary: every operation's T is generated from the schema it was validated against.
  return body.data as T
}

/**
 * Format an error for display, including status code and cause when available.
 * Server-provided text is redacted and stripped of terminal control sequences;
 * pass the secret values the request submitted so an echo of them is masked.
 */
export function formatApiError(error: unknown, knownSecrets: readonly string[] = []): string {
  return sanitizeTerminal(redact(describeError(error, knownSecrets), knownSecrets))
}

function describeError(error: unknown, knownSecrets: readonly string[]): string {
  if (error instanceof GantryApiError) {
    const parts = [error.message]
    if (error.responseBody) {
      // Redact before truncating so the cut cannot split a secret past the mask.
      const body = redact(error.responseBody, knownSecrets)
      const snippet = body.length > 200 ? body.slice(0, 200) + '...' : body
      parts.push(`Response: ${snippet}`)
    }
    return parts.join(' ')
  }

  if (error instanceof NetworkError) {
    const parts = [error.message]
    if (error.cause?.message && !error.message.includes(error.cause.message)) {
      parts.push(`Cause: ${error.cause.message}`)
    }
    return parts.join(' ')
  }

  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}
