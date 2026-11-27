import { EventEmitter } from 'events'
import { PassThrough } from 'stream'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  graphqlRequest: vi.fn(),
  sessionPluginInstalled: vi.fn(),
  spawn: vi.fn(),
}))

vi.mock('child_process', () => ({ spawn: mocks.spawn }))
vi.mock('./client', () => ({ graphqlRequest: mocks.graphqlRequest }))
vi.mock('./session-plugin', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sessionPluginInstalled: mocks.sessionPluginInstalled,
}))

const { openSessionStream, proxySession, startBastionSession } = await import('./bastion-session')
const { PLUGIN_MISSING_MESSAGE, sessionPluginArgs } = await import('./session-plugin')

const SESSION = {
  region: 'us-east-2',
  sessionId: 'gantry-bastion-session-0a1b2c3d4e5f67890',
  streamUrl: 'wss://ssmmessages.us-east-2.amazonaws.com/v1/data-channel/session',
  tokenValue: 'AAEAAQ-session-token',
  target: 'i-0a1b2c3d4e5f67890',
}

interface FakePlugin extends EventEmitter {
  stdin: PassThrough
  stdout: PassThrough
  exitCode: number | null
  kill: ReturnType<typeof vi.fn>
}

function fakePlugin(): FakePlugin {
  const plugin = new EventEmitter() as FakePlugin
  plugin.stdin = new PassThrough()
  plugin.stdout = new PassThrough()
  plugin.exitCode = null
  plugin.kill = vi.fn()
  return plugin
}

describe('startBastionSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.sessionPluginInstalled.mockReturnValue(true)
  })

  it('opens a session through the API without replay', async () => {
    mocks.graphqlRequest.mockResolvedValueOnce({
      startBastionSession: { success: true, message: null, aws: SESSION },
    })

    await expect(startBastionSession('ops-jump')).resolves.toEqual(SESSION)
    expect(mocks.graphqlRequest).toHaveBeenCalledWith(
      expect.stringContaining('startBastionSession(slug: $slug)'),
      { slug: 'ops-jump' },
      { idempotent: false }
    )
  })

  it('opens no session when the plugin is missing', async () => {
    mocks.sessionPluginInstalled.mockReturnValue(false)

    await expect(startBastionSession('ops-jump')).rejects.toThrow(PLUGIN_MISSING_MESSAGE)
    expect(mocks.graphqlRequest).not.toHaveBeenCalled()
  })

  it("throws the API's refusal", async () => {
    mocks.graphqlRequest.mockResolvedValueOnce({
      startBastionSession: {
        success: false,
        message: "This bastion isn't ready for sessions yet.",
        aws: null,
      },
    })

    await expect(startBastionSession('ops-jump')).rejects.toThrow(
      "This bastion isn't ready for sessions yet."
    )
  })
})

describe('openSessionStream', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("carries bytes both ways through the plugin's stdio", async () => {
    const plugin = fakePlugin()
    mocks.spawn.mockReturnValue(plugin)

    const { sock } = openSessionStream(SESSION)
    expect(mocks.spawn).toHaveBeenCalledWith('session-manager-plugin', sessionPluginArgs(SESSION), {
      stdio: ['pipe', 'pipe', 'ignore'],
    })

    const written = new Promise((resolve) => plugin.stdin.once('data', resolve))
    sock.write('SSH-2.0-client\r\n')
    expect(String(await written)).toBe('SSH-2.0-client\r\n')

    const read = new Promise((resolve) => sock.once('data', resolve))
    plugin.stdout.write('SSH-2.0-OpenSSH_9.6\r\n')
    expect(String(await read)).toBe('SSH-2.0-OpenSSH_9.6\r\n')
  })

  it('ends the stream with the install hint when the plugin is missing', async () => {
    const plugin = fakePlugin()
    mocks.spawn.mockReturnValue(plugin)
    const { sock } = openSessionStream(SESSION)

    const failed = new Promise<Error>((resolve) => sock.once('error', resolve))
    plugin.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))

    expect((await failed).message).toBe(PLUGIN_MISSING_MESSAGE)
  })

  it('kills a running plugin on close', () => {
    const plugin = fakePlugin()
    mocks.spawn.mockReturnValue(plugin)

    openSessionStream(SESSION).close()

    expect(plugin.kill).toHaveBeenCalledOnce()
  })
})

describe('proxySession', () => {
  it("resolves with the plugin's exit code", async () => {
    const plugin = fakePlugin()
    mocks.spawn.mockReturnValue(plugin)

    const exited = proxySession(SESSION)
    plugin.emit('exit', 255)

    await expect(exited).resolves.toBe(255)
    expect(mocks.spawn).toHaveBeenCalledWith('session-manager-plugin', sessionPluginArgs(SESSION), {
      stdio: 'inherit',
    })
  })
})
