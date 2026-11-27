import { stripVTControlCharacters } from 'util'

import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

const graphqlRequest = vi.hoisted(() => vi.fn())
const confirm = vi.hoisted(() => vi.fn())
const isInteractive = vi.hoisted(() => vi.fn(() => true))

vi.mock('@inquirer/prompts', () => ({ confirm }))
vi.mock('../lib/client', () => ({
  formatApiError: (error: unknown) => (error instanceof Error ? error.message : 'API error'),
  graphqlRequest,
}))
vi.mock('../lib/terminal', () => ({ isInteractive }))

const { registerOriginLockCommand } = await import('./origin-lock')

class ExitError extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`)
  }
}

async function run(args: string[]): Promise<void> {
  const program = new Command()
  registerOriginLockCommand(program)
  await program.parseAsync(['node', 'gantry', 'origin-lock', ...args])
}

const shopLock = {
  originLock: {
    hostname: 'shop.example.com',
    provider: 'CLOUDFLARE',
    header: 'X-Gantry-Origin-Lock',
    value: 'olk_7Gm2xQp9rT4vWc8nYb3e',
  },
}

describe('origin-lock command', () => {
  let logSpy: MockInstance
  let errorSpy: MockInstance

  beforeEach(() => {
    vi.clearAllMocks()
    isInteractive.mockReturnValue(true)
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitError(typeof code === 'number' ? code : undefined)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function printed(): string {
    return stripVTControlCharacters(logSpy.mock.calls.map((call) => String(call[0])).join('\n'))
  }

  it('prints the header and value with --reveal and how to set it up in Cloudflare', async () => {
    graphqlRequest.mockResolvedValueOnce(shopLock)

    await run(['show', 'shop.example.com', '--reveal'])

    expect(graphqlRequest.mock.calls[0]?.[1]).toEqual({ hostname: 'shop.example.com' })
    expect(confirm).not.toHaveBeenCalled()
    const out = printed()
    expect(out).toContain('Header: X-Gantry-Origin-Lock')
    expect(out).toContain('Value:  olk_7Gm2xQp9rT4vWc8nYb3e')
    expect(out).toContain(
      'Add a Cloudflare Transform Rule that sets this request header on shop.example.com, and proxy its DNS record.'
    )
  })

  it('tells a hostname locked to any proxy how to set the header there', async () => {
    graphqlRequest.mockResolvedValueOnce({
      originLock: { ...shopLock.originLock, provider: 'HEADER' },
    })

    await run(['show', 'shop.example.com', '--reveal'])

    const out = printed()
    expect(out).toContain(
      'Configure your proxy to set this header on every request it forwards to shop.example.com, replacing any value the client sent, and point its DNS at your proxy.'
    )
    expect(out).not.toContain('Cloudflare')
  })

  it.each([
    [true, true],
    [false, false],
  ])('prints the value only when the prompt is confirmed (%s)', async (answer, shown) => {
    confirm.mockResolvedValueOnce(answer)
    graphqlRequest.mockResolvedValueOnce(shopLock)

    await run(['show', 'shop.example.com'])

    expect(printed().includes('olk_7Gm2xQp9rT4vWc8nYb3e')).toBe(shown)
    expect(printed()).toContain('Header: X-Gantry-Origin-Lock')
  })

  it('hides the value without a terminal unless --reveal is passed', async () => {
    isInteractive.mockReturnValue(false)
    graphqlRequest.mockResolvedValueOnce(shopLock)

    await run(['show', 'shop.example.com'])

    expect(confirm).not.toHaveBeenCalled()
    expect(printed()).not.toContain('olk_7Gm2xQp9rT4vWc8nYb3e')
    expect(printed()).toContain('Value:  hidden. Re-run with --reveal to print it.')
  })

  it('says so when no live deploy locks the hostname', async () => {
    graphqlRequest.mockResolvedValueOnce({ originLock: null })

    await run(['show', 'blog.example.com'])

    expect(printed()).toBe('No live deploy locks blog.example.com.')
  })

  it('prints the API error and exits non-zero', async () => {
    graphqlRequest.mockRejectedValueOnce(new Error('You do not have access to this domain.'))

    await expect(run(['show', 'shop.example.com'])).rejects.toThrow(ExitError)

    expect(stripVTControlCharacters(String(errorSpy.mock.calls[0]?.[0]))).toBe(
      'Error: You do not have access to this domain.'
    )
  })
})
