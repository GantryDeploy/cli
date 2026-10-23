import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AuthenticationError,
  formatApiError,
  GantryApiError,
  graphqlRequest,
  isMutationDocument,
  NetworkError,
} from './client'
import { getApiUrl, getTeam, loadToken } from './config'

vi.mock('./config', () => ({
  getApiUrl: vi.fn(() => 'https://api.gantrydeploy.com'),
  loadToken: vi.fn(() => 'gpat_test_abc123'),
  getTeam: vi.fn(() => null),
}))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status })
}

function textResponse(text: string, status: number): Response {
  return new Response(text, { status })
}

describe('client', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(loadToken).mockReturnValue('gpat_test_abc123')
    vi.mocked(getTeam).mockReturnValue(null)
    vi.mocked(getApiUrl).mockReturnValue('https://api.gantrydeploy.com')
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function runWithTimers<T>(promise: Promise<T>): Promise<T> {
    let settled = false
    const tracked = promise.finally(() => {
      settled = true
    })
    // Marks the rejection handled while timers advance; the caller still receives it.
    tracked.catch(() => undefined)

    let iterations = 0
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- settled is mutated inside async .then/.catch callbacks that control-flow analysis cannot model
    while (!settled && iterations < 100) {
      await vi.advanceTimersByTimeAsync(65_000) // Jump past MAX_RETRY_DELAY_MS
      iterations++
    }

    return tracked
  }

  describe('graphqlRequest', () => {
    describe('successful requests', () => {
      it('returns data from a successful response', async () => {
        mockFetch.mockResolvedValueOnce(jsonResponse({ data: { whoami: { authenticated: true } } }))

        const result = await runWithTimers(
          graphqlRequest<{ whoami: { authenticated: boolean } }>(
            'query { whoami { authenticated } }'
          )
        )

        expect(result).toEqual({ whoami: { authenticated: true } })
        expect(mockFetch).toHaveBeenCalledTimes(1)
      })

      it('sends no team header when no team is selected', async () => {
        mockFetch.mockResolvedValueOnce(jsonResponse({ data: {} }))

        await runWithTimers(graphqlRequest('query { test }'))

        const { headers } = mockFetch.mock.calls[0][1] as { headers: Record<string, string> }
        expect(headers).not.toHaveProperty('X-Gantry-Team')
      })

      it('sends the selected team as a header so one flag covers every command', async () => {
        vi.mocked(getTeam).mockReturnValue('x7qm2d')
        mockFetch.mockResolvedValueOnce(jsonResponse({ data: {} }))

        await runWithTimers(graphqlRequest('query { test }'))

        const { headers } = mockFetch.mock.calls[0][1] as { headers: Record<string, string> }
        expect(headers['X-Gantry-Team']).toBe('x7qm2d')
      })
    })

    describe('authentication errors (no retry)', () => {
      it('throws AuthenticationError when no token is found', async () => {
        vi.mocked(loadToken).mockReturnValue(null)

        await expect(runWithTimers(graphqlRequest('query { test }'))).rejects.toThrow(
          AuthenticationError
        )
        expect(mockFetch).not.toHaveBeenCalled()
      })

      it('sends a malformed token instead of judging it locally', async () => {
        // A local format check would reject the next new token kind the API accepts.
        vi.mocked(loadToken).mockReturnValue('not-a-token')
        mockFetch.mockResolvedValue(jsonResponse({ data: { test: 'ok' } }))

        await runWithTimers(graphqlRequest('query { test }'))

        expect(mockFetch).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            headers: expect.objectContaining({ Authorization: 'Bearer not-a-token' }) as unknown,
          })
        )
      })

      it('throws AuthenticationError on HTTP 401 without retrying', async () => {
        mockFetch.mockResolvedValue(textResponse('Unauthorized', 401))

        await expect(runWithTimers(graphqlRequest('query { test }'))).rejects.toThrow(
          AuthenticationError
        )
        expect(mockFetch).toHaveBeenCalledTimes(1)
      })

      it('throws AuthenticationError on HTTP 403 without retrying', async () => {
        mockFetch.mockResolvedValue(textResponse('Forbidden', 403))

        await expect(runWithTimers(graphqlRequest('query { test }'))).rejects.toThrow(
          AuthenticationError
        )
        expect(mockFetch).toHaveBeenCalledTimes(1)
      })
    })

    describe('network errors (with retry)', () => {
      it('fails fast with NetworkError on ECONNREFUSED', async () => {
        mockFetch.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:3023'))

        await expect(runWithTimers(graphqlRequest('query { test }'))).rejects.toThrow(NetworkError)

        expect(mockFetch).toHaveBeenCalledTimes(1)
      })

      it('includes the cause label for ECONNREFUSED', async () => {
        mockFetch.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:3023'))

        try {
          await runWithTimers(graphqlRequest('query { test }'))
        } catch (error) {
          expect(error).toBeInstanceOf(NetworkError)
          expect((error as NetworkError).message).toContain('ECONNREFUSED')
          expect((error as NetworkError).message).toContain('https://api.gantrydeploy.com')
        }
      })

      it('includes the cause label for timeouts', async () => {
        mockFetch.mockRejectedValue(new Error('connect ETIMEDOUT'))

        try {
          await runWithTimers(graphqlRequest('query { test }'))
        } catch (error) {
          expect(error).toBeInstanceOf(NetworkError)
          expect((error as NetworkError).message).toContain('ETIMEDOUT')
          expect((error as NetworkError).message).toContain('timed out')
        }
      })

      it('includes the cause label for DNS errors', async () => {
        mockFetch.mockRejectedValue(new Error('getaddrinfo ENOTFOUND api.gantrydeploy.com'))

        try {
          await runWithTimers(graphqlRequest('query { test }'))
        } catch (error) {
          expect(error).toBeInstanceOf(NetworkError)
          expect((error as NetworkError).message).toContain('ENOTFOUND')
        }
      })

      it('succeeds after transient network errors', async () => {
        mockFetch
          .mockRejectedValueOnce(new Error('fetch failed'))
          .mockRejectedValueOnce(new Error('fetch failed'))
          .mockResolvedValueOnce(jsonResponse({ data: { test: true } }))

        const result = await runWithTimers(graphqlRequest<{ test: boolean }>('query { test }'))

        expect(result).toEqual({ test: true })
        expect(mockFetch).toHaveBeenCalledTimes(3)
      })
    })

    describe('HTTP error responses (with retry)', () => {
      it('retries HTTP 500 and keeps the status code', async () => {
        mockFetch.mockResolvedValue(textResponse('Internal Server Error', 500))

        try {
          await runWithTimers(graphqlRequest('query { test }'))
          expect.fail('should have thrown')
        } catch (error) {
          expect(error).toBeInstanceOf(GantryApiError)
          const apiError = error as GantryApiError
          expect(apiError.statusCode).toBe(500)
          expect(apiError.message).toContain('HTTP 500')
        }

        expect(mockFetch).toHaveBeenCalledTimes(10)
      })

      it('retries HTTP 503 and includes the status in the message', async () => {
        mockFetch.mockResolvedValue(textResponse('Service Unavailable', 503))

        try {
          await runWithTimers(graphqlRequest('query { test }'))
          expect.fail('should have thrown')
        } catch (error) {
          expect(error).toBeInstanceOf(GantryApiError)
          const apiError = error as GantryApiError
          expect(apiError.statusCode).toBe(503)
          expect(apiError.message).toContain('HTTP 503')
          expect(apiError.message).toContain('temporarily unavailable')
        }

        expect(mockFetch).toHaveBeenCalledTimes(10)
      })

      it('does not retry HTTP 400', async () => {
        mockFetch.mockResolvedValue(textResponse('Bad Request', 400))

        try {
          await runWithTimers(graphqlRequest('query { test }'))
          expect.fail('should have thrown')
        } catch (error) {
          expect(error).toBeInstanceOf(GantryApiError)
          const apiError = error as GantryApiError
          expect(apiError.statusCode).toBe(400)
          expect(apiError.message).toContain('HTTP 400')
        }

        expect(mockFetch).toHaveBeenCalledTimes(1)
      })

      it('does not retry HTTP 404', async () => {
        mockFetch.mockResolvedValue(textResponse('Not Found', 404))

        try {
          await runWithTimers(graphqlRequest('query { test }'))
          expect.fail('should have thrown')
        } catch (error) {
          expect(error).toBeInstanceOf(GantryApiError)
          const apiError = error as GantryApiError
          expect(apiError.statusCode).toBe(404)
        }

        expect(mockFetch).toHaveBeenCalledTimes(1)
      })

      it('succeeds after transient HTTP errors', async () => {
        mockFetch
          .mockResolvedValueOnce(textResponse('Service Unavailable', 503))
          .mockResolvedValueOnce(textResponse('Service Unavailable', 503))
          .mockResolvedValueOnce(jsonResponse({ data: { test: 'ok' } }))

        const result = await runWithTimers(graphqlRequest<{ test: string }>('query { test }'))

        expect(result).toEqual({ test: 'ok' })
        expect(mockFetch).toHaveBeenCalledTimes(3)
      })

      it('includes a response body snippet in GantryApiError', async () => {
        mockFetch.mockImplementation(() =>
          Promise.resolve(textResponse('Something went very wrong on the server', 500))
        )

        const error = await runWithTimers(graphqlRequest('query { test }')).catch((e: unknown) => e)
        expect(error).toBeInstanceOf(GantryApiError)
        expect(error).toMatchObject({ responseBody: 'Something went very wrong on the server' })
      })

      it('parses GraphQL errors from the response body and includes the status', async () => {
        mockFetch.mockResolvedValue(
          jsonResponse({ errors: [{ message: 'Field "foo" not found' }] }, 400)
        )

        try {
          await runWithTimers(graphqlRequest('query { test }'))
          expect.fail('should have thrown')
        } catch (error) {
          expect(error).toBeInstanceOf(GantryApiError)
          const apiError = error as GantryApiError
          expect(apiError.message).toContain('Field "foo" not found')
          expect(apiError.message).toContain('HTTP 400')
          expect(apiError.statusCode).toBe(400)
          expect(apiError.errors).toHaveLength(1)
        }
      })
    })

    describe('mutations', () => {
      const MUTATION = 'mutation StartDeployment { startDeployment { id } }'
      const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      const deployed = { data: { startDeployment: { id: 'dep_8Kq2mZ' } } }

      function undiciError(code: string, message: string): TypeError {
        const cause = Object.assign(new Error(message), { code })
        return new TypeError('fetch failed', { cause })
      }

      function sentKeys(): (string | undefined)[] {
        return mockFetch.mock.calls.map(
          ([, init]) => (init as { headers: Record<string, string> }).headers['Idempotency-Key']
        )
      }

      it('sends the same idempotency key on every attempt of one call', async () => {
        mockFetch
          .mockResolvedValueOnce(textResponse('Bad Gateway', 502))
          .mockResolvedValueOnce(jsonResponse(deployed))

        const result = await runWithTimers(graphqlRequest(MUTATION))

        expect(result).toEqual(deployed.data)
        const [first, second] = sentKeys()
        expect(first).toMatch(UUID)
        expect(second).toBe(first)
      })

      it('uses a new idempotency key for each call', async () => {
        mockFetch.mockImplementation(() => Promise.resolve(jsonResponse(deployed)))

        await runWithTimers(graphqlRequest(MUTATION))
        await runWithTimers(graphqlRequest(MUTATION))

        const [first, second] = sentKeys()
        expect(first).toMatch(UUID)
        expect(second).toMatch(UUID)
        expect(second).not.toBe(first)
      })

      it('sends no idempotency key with a query', async () => {
        mockFetch.mockResolvedValueOnce(jsonResponse({ data: { test: 'ok' } }))

        await runWithTimers(graphqlRequest('query { test }'))

        expect(sentKeys()).toEqual([undefined])
      })

      it('detects a mutation behind comments and fragments', async () => {
        mockFetch.mockResolvedValueOnce(jsonResponse({ data: { runDeploy: { output: 'ok' } } }))
        const document = `# deploys the service
          fragment Out on DeployResult { output }
          mutation { runDeploy(command: "query") { ...Out } }`

        await runWithTimers(graphqlRequest(document))

        expect(sentKeys()[0]).toMatch(UUID)
      })

      it.each([
        ['a 502', () => textResponse('Bad Gateway', 502)],
        [
          'a request timeout',
          () => {
            throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
          },
        ],
        [
          'a connection reset after sending',
          () => {
            throw undiciError('ECONNRESET', 'read ECONNRESET')
          },
        ],
      ])('retries %s', async (_label, fail) => {
        mockFetch
          .mockImplementationOnce(() => Promise.resolve().then(fail))
          .mockResolvedValueOnce(jsonResponse(deployed))

        const result = await runWithTimers(graphqlRequest(MUTATION))

        expect(result).toEqual(deployed.data)
        expect(mockFetch).toHaveBeenCalledTimes(2)
      })

      it('retries while the API is still running the first attempt', async () => {
        mockFetch
          .mockResolvedValueOnce(
            jsonResponse({
              data: null,
              errors: [
                {
                  message: 'This request is already being processed.',
                  extensions: { code: 'IDEMPOTENCY_IN_PROGRESS' },
                },
              ],
            })
          )
          .mockResolvedValueOnce(jsonResponse(deployed))

        const result = await runWithTimers(graphqlRequest(MUTATION))

        expect(result).toEqual(deployed.data)
        expect(mockFetch).toHaveBeenCalledTimes(2)
      })

      it('does not retry a key the API says was used for a different request', async () => {
        mockFetch.mockResolvedValue(
          jsonResponse({
            data: null,
            errors: [
              {
                message: 'This idempotency key was already used for a different request.',
                extensions: { code: 'IDEMPOTENCY_KEY_REUSED' },
              },
            ],
          })
        )

        await expect(runWithTimers(graphqlRequest(MUTATION))).rejects.toMatchObject({
          errors: [{ code: 'IDEMPOTENCY_KEY_REUSED' }],
        })
        expect(mockFetch).toHaveBeenCalledTimes(1)
      })

      it('does not retry connection refused, matching queries', async () => {
        mockFetch.mockRejectedValue(
          undiciError('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:3023')
        )

        await expect(runWithTimers(graphqlRequest(MUTATION))).rejects.toThrow(NetworkError)
        expect(mockFetch).toHaveBeenCalledTimes(1)
      })
    })

    describe('mutations marked idempotent: false (no blind retries)', () => {
      const MUTATION =
        'mutation RunConsoleCommand { runConsoleCommand(command: "migrate") { output } }'
      const unkeyed = { idempotent: false } as const

      function undiciError(code: string, message: string): TypeError {
        const cause = Object.assign(new Error(message), { code })
        return new TypeError('fetch failed', { cause })
      }

      it('sends no idempotency key', async () => {
        mockFetch.mockResolvedValueOnce(
          jsonResponse({ data: { runConsoleCommand: { output: 'ok' } } })
        )

        await runWithTimers(graphqlRequest(MUTATION, undefined, unkeyed))

        const [, init] = mockFetch.mock.calls[0] as [string, { headers: Record<string, string> }]
        expect(init.headers['Idempotency-Key']).toBeUndefined()
      })

      it('does not retry a 502 that may follow a committed write', async () => {
        mockFetch.mockResolvedValue(textResponse('Bad Gateway', 502))

        await expect(runWithTimers(graphqlRequest(MUTATION, undefined, unkeyed))).rejects.toThrow(
          GantryApiError
        )
        expect(mockFetch).toHaveBeenCalledTimes(1)
      })

      it('does not retry a request timeout', async () => {
        mockFetch.mockRejectedValue(
          new DOMException('The operation was aborted due to timeout', 'TimeoutError')
        )

        await expect(runWithTimers(graphqlRequest(MUTATION, undefined, unkeyed))).rejects.toThrow(
          NetworkError
        )
        expect(mockFetch).toHaveBeenCalledTimes(1)
      })

      it('does not retry a connection reset after sending', async () => {
        mockFetch.mockRejectedValue(undiciError('ECONNRESET', 'read ECONNRESET'))

        await expect(runWithTimers(graphqlRequest(MUTATION, undefined, unkeyed))).rejects.toThrow(
          NetworkError
        )
        expect(mockFetch).toHaveBeenCalledTimes(1)
      })

      it.each([
        ['EHOSTUNREACH', 'connect EHOSTUNREACH 10.0.0.1:443'],
        ['ENETUNREACH', 'connect ENETUNREACH 10.0.0.1:443'],
        ['UND_ERR_CONNECT_TIMEOUT', 'Connect Timeout Error'],
      ])('retries %s, where the request never left the machine', async (code, message) => {
        mockFetch
          .mockRejectedValueOnce(undiciError(code, message))
          .mockResolvedValueOnce(jsonResponse({ data: { runConsoleCommand: { output: 'ok' } } }))

        const result = await runWithTimers(graphqlRequest(MUTATION, undefined, unkeyed))

        expect(result).toEqual({ runConsoleCommand: { output: 'ok' } })
        expect(mockFetch).toHaveBeenCalledTimes(2)
      })

      it('ignores a pre-send code that appears only in the API URL', async () => {
        vi.mocked(getApiUrl).mockReturnValue('https://ehostunreach.example.com')
        mockFetch.mockRejectedValueOnce(
          new DOMException('The operation was aborted due to timeout', 'TimeoutError')
        )

        await expect(runWithTimers(graphqlRequest(MUTATION, undefined, unkeyed))).rejects.toThrow(
          /ehostunreach\.example\.com/
        )
        expect(mockFetch).toHaveBeenCalledTimes(1)
      })
    })

    describe('queries', () => {
      it('still retries a query on 502', async () => {
        mockFetch
          .mockResolvedValueOnce(textResponse('Bad Gateway', 502))
          .mockResolvedValueOnce(jsonResponse({ data: { test: 'ok' } }))

        await runWithTimers(graphqlRequest('query { test }'))

        expect(mockFetch).toHaveBeenCalledTimes(2)
      })

      it('still retries a query on timeout', async () => {
        mockFetch
          .mockRejectedValueOnce(
            new DOMException('The operation was aborted due to timeout', 'TimeoutError')
          )
          .mockResolvedValueOnce(jsonResponse({ data: { test: 'ok' } }))

        await runWithTimers(graphqlRequest('query { test }'))

        expect(mockFetch).toHaveBeenCalledTimes(2)
      })
    })

    describe('GraphQL-level errors in 200 response', () => {
      it('throws GantryApiError for GraphQL errors in a 200 response', async () => {
        mockFetch.mockResolvedValueOnce(
          jsonResponse({
            data: null,
            errors: [{ message: 'Not authorized' }],
          })
        )

        try {
          await runWithTimers(graphqlRequest('query { test }'))
          expect.fail('should have thrown')
        } catch (error) {
          expect(error).toBeInstanceOf(GantryApiError)
          const apiError = error as GantryApiError
          expect(apiError.message).toContain('Not authorized')
          expect(apiError.statusCode).toBe(200)
        }
      })

      it('redacts and strips control sequences from the GraphQL error message', async () => {
        mockFetch.mockResolvedValueOnce(
          jsonResponse({
            data: null,
            errors: [{ message: 'got { key: "K", value: "leaked" } \x1b[2J' }],
          })
        )

        await expect(runWithTimers(graphqlRequest('query { test }'))).rejects.toThrow(
          'Gantry API error (HTTP 200): got { key: "K", value: "[redacted]" } '
        )
      })

      it('throws GantryApiError when no data is returned', async () => {
        mockFetch.mockResolvedValueOnce(jsonResponse({ data: null }))

        try {
          await runWithTimers(graphqlRequest('query { test }'))
          expect.fail('should have thrown')
        } catch (error) {
          expect(error).toBeInstanceOf(GantryApiError)
          expect((error as GantryApiError).message).toContain('No data returned')
        }
      })

      it('keeps numeric path segments from the GraphQL error', async () => {
        mockFetch.mockResolvedValueOnce(
          jsonResponse({ data: null, errors: [{ message: 'Bad item', path: ['items', 2] }] })
        )

        const error = await runWithTimers(graphqlRequest('query { test }')).catch(
          (caught: unknown) => caught
        )

        expect(error).toBeInstanceOf(GantryApiError)
        expect(error).toMatchObject({ errors: [{ message: 'Bad item', path: ['items', '2'] }] })
      })
    })

    describe('malformed response bodies', () => {
      it.each([
        ['a JSON array', []],
        ['a JSON string', 'ok'],
        ['errors that are not an array', { data: null, errors: 'nope' }],
        ['an error without a message', { data: null, errors: [{ code: 'X' }] }],
      ])('rejects %s as an invalid response', async (_label, body) => {
        mockFetch.mockResolvedValueOnce(jsonResponse(body))

        await expect(runWithTimers(graphqlRequest('query { test }'))).rejects.toThrow(
          'Invalid response from Gantry API. (HTTP 200)'
        )
      })

      it('treats non-object data as no data', async () => {
        mockFetch.mockResolvedValueOnce(jsonResponse({ data: 'ok' }))

        await expect(runWithTimers(graphqlRequest('query { test }'))).rejects.toThrow(
          'No data returned from API. (HTTP 200)'
        )
      })
    })
  })

  describe('isMutationDocument', () => {
    it.each([
      ['mutation CreateVersion { createVersion { id } }', true],
      ['mutation { createVersion { id } }', true],
      ['  \n# leading comment\n\tmutation Go($id: ID!) { go(id: $id) }', true],
      ['﻿mutation { go }', true],
      ['query Q { a }\nmutation M { b }', true],
      ['query Projects { projects { id } }', false],
      ['{ projects { id } }', false],
      ['# mutation in a comment\nquery { a }', false],
      ['query { run(command: "mutation { x }") }', false],
      ['query { run(command: """\nmutation\n""") }', false],
      ['query Q($mutation: Boolean) { a(flag: $mutation) }', false],
      ['query { a @mutation }', false],
      ['query { mutation }', false],
      ['subscription { events }', false],
    ])('%j -> %s', (document, expected) => {
      expect(isMutationDocument(document)).toBe(expected)
    })
  })

  describe('formatApiError', () => {
    it('formats GantryApiError with its status code', () => {
      const error = new GantryApiError('Something failed. (HTTP 500)', undefined, 500)
      const formatted = formatApiError(error)
      expect(formatted).toBe('Something failed. (HTTP 500)')
    })

    it('formats GantryApiError with a response body snippet', () => {
      const error = new GantryApiError(
        'Gantry API error. (HTTP 500)',
        undefined,
        500,
        '{"error": "internal"}'
      )
      const formatted = formatApiError(error)
      expect(formatted).toContain('Gantry API error. (HTTP 500)')
      expect(formatted).toContain('Response: {"error": "internal"}')
    })

    it('truncates a long response body', () => {
      const longBody = 'x'.repeat(300)
      const error = new GantryApiError('Error. (HTTP 500)', undefined, 500, longBody)
      const formatted = formatApiError(error)
      expect(formatted).toContain('...')
      expect(formatted.length).toBeLessThan(longBody.length + 100)
    })

    it('does not repeat a NetworkError cause already in the message', () => {
      const cause = new Error('connect ECONNREFUSED 127.0.0.1:3023')
      const error = new NetworkError(
        'Unable to connect to Gantry API at https://api.gantrydeploy.com (ECONNREFUSED).',
        cause
      )
      const formatted = formatApiError(error)
      expect(formatted).toContain('Unable to connect to Gantry API')
      expect(formatted).toContain('ECONNREFUSED')
    })

    it('appends a NetworkError cause missing from the message', () => {
      const cause = new Error('some obscure reason')
      const error = new NetworkError(
        'Unable to reach Gantry API at https://api.gantrydeploy.com.',
        cause
      )
      const formatted = formatApiError(error)
      expect(formatted).toContain('Unable to reach Gantry API')
      expect(formatted).toContain('Cause: some obscure reason')
    })

    it('formats a plain Error', () => {
      const error = new Error('Something broke')
      expect(formatApiError(error)).toBe('Something broke')
    })

    it('formats string errors', () => {
      expect(formatApiError('string error')).toBe('string error')
    })

    it('masks a synthetic API token in the message and body', () => {
      const error = new GantryApiError(
        'Gantry API error (HTTP 400): token gpat_synthetic123 rejected',
        undefined,
        400,
        '{"errors":[{"message":"token gnat_synthetic456 rejected"}]}'
      )

      const formatted = formatApiError(error)

      expect(formatted).not.toContain('gpat_synthetic123')
      expect(formatted).not.toContain('gnat_synthetic456')
      expect(formatted).toContain('token [redacted] rejected')
    })

    it('masks a JSON password key in the response body', () => {
      const error = new GantryApiError(
        'Invalid request. (HTTP 400)',
        undefined,
        400,
        '{"input":{"password":"Synthetic-P4ss!"}}'
      )

      expect(formatApiError(error)).toBe(
        'Invalid request. (HTTP 400) Response: {"input":{"password":"[redacted]"}}'
      )
    })

    it('masks submitted secret values the server echoes back', () => {
      const error = new GantryApiError(
        'Gantry API error (HTTP 400): unknown field API_KEY=s3cret-submitted',
        undefined,
        400,
        `${'x'.repeat(190)} s3cret-submitted`
      )

      const formatted = formatApiError(error, ['s3cret-submitted'])

      expect(formatted).not.toContain('s3cret')
      expect(formatted).toContain('API_KEY=[redacted]')
    })

    it('neutralises terminal control sequences but keeps plain text', () => {
      const error = new GantryApiError(
        'Gantry API error (HTTP 500): \x1b[2Jdeploy \x1b]0;Deploy succeeded\x07\x9b2Jfailed',
        undefined,
        500
      )

      expect(formatApiError(error)).toBe('Gantry API error (HTTP 500): deploy failed')
    })

    it('neutralises control sequences in plain errors and network causes', () => {
      expect(formatApiError(new Error('boom\x1b[2J'))).toBe('boom')
      const network = new NetworkError('Unable to reach Gantry API.', new Error('odd\x1b]0;t\x07'))
      expect(formatApiError(network)).toBe('Unable to reach Gantry API. Cause: odd')
    })
  })
})
