import { PassThrough } from 'stream'

import type { Ora } from 'ora'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fetchBastionCredentials: vi.fn(),
  graphqlRequest: vi.fn(),
  openSessionStream: vi.fn(),
  openSshTunnel: vi.fn(),
  startBastionSession: vi.fn(),
}))

vi.mock('./bastion-prompts', () => ({ fetchBastionCredentials: mocks.fetchBastionCredentials }))
vi.mock('./bastion-session', () => ({
  openSessionStream: mocks.openSessionStream,
  startBastionSession: mocks.startBastionSession,
}))
vi.mock('./client', () => ({ graphqlRequest: mocks.graphqlRequest }))
vi.mock('./ssh-tunnel', () => ({ openSshTunnel: mocks.openSshTunnel }))

const { openBastionTunnel } = await import('./bastion-tunnel')

const spinnerStop = vi.fn()
const spinnerStart = vi.fn()
const spinner = { stop: spinnerStop, start: spinnerStart } as unknown as Ora
const FINGERPRINT = 'SHA256:ZLHH8qScCNumv6jTt1L8kj+sFVAHleXj5Y3NxKTXIWs'
const SESSION = {
  region: 'us-east-2',
  sessionId: 'gantry-bastion-session-0a1b2c3d4e5f67890',
  streamUrl: 'wss://ssmmessages.us-east-2.amazonaws.com/v1/data-channel/session',
  tokenValue: 'AAEAAQ-session-token',
  target: 'i-0a1b2c3d4e5f67890',
}

const request = {
  slug: 'ops-jump',
  remoteHost: 'primary.example.internal',
  remotePort: 5432,
  localPort: 15432,
  trustHostKey: true,
  spinner,
}

function bastionIs(
  bastion: { publicAccess: boolean; publicIp: string | null; provider?: string } | null
) {
  mocks.graphqlRequest.mockResolvedValueOnce({
    bastion: bastion && { id: 'r3bq9m', provider: 'aws', ...bastion },
  })
}

describe('openBastionTunnel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.fetchBastionCredentials.mockResolvedValue({
      privateKey: 'fake-bastion-private-key',
      sshUser: 'ec2-user',
      hostPublicKey: null,
      hostKeyFingerprint: FINGERPRINT,
    })
    mocks.openSshTunnel.mockResolvedValue({ localPort: 15432, close: vi.fn() })
  })

  it('connects straight to a public bastion and pins the host key under its address', async () => {
    bastionIs({ publicAccess: true, publicIp: '203.0.113.10' })

    await openBastionTunnel(request)

    expect(mocks.startBastionSession).not.toHaveBeenCalled()
    expect(mocks.openSshTunnel).toHaveBeenCalledWith({
      endpoint: { host: '203.0.113.10' },
      bastionUsername: 'ec2-user',
      hostKey: {
        hostId: 'bastion-r3bq9m@203.0.113.10',
        label: 'ops-jump',
        expectedFingerprint: FINGERPRINT,
        trustHostKey: true,
        pauseOutput: expect.any(Function) as unknown,
        resumeOutput: expect.any(Function) as unknown,
      },
      privateKey: 'fake-bastion-private-key',
      remoteHost: 'primary.example.internal',
      remotePort: 5432,
      localPort: 15432,
    })
  })

  it('runs SSH through a session to a private bastion, with the same host key pinning', async () => {
    bastionIs({ publicAccess: false, publicIp: null })
    const sock = new PassThrough()
    const close = vi.fn()
    mocks.startBastionSession.mockResolvedValueOnce(SESSION)
    mocks.openSessionStream.mockReturnValueOnce({ sock, close })

    await openBastionTunnel(request)

    expect(mocks.startBastionSession).toHaveBeenCalledWith('ops-jump')
    expect(mocks.openSessionStream).toHaveBeenCalledWith(SESSION)
    expect(mocks.openSshTunnel).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: { sock, release: close },
        hostKey: expect.objectContaining({
          hostId: 'bastion-r3bq9m',
          expectedFingerprint: FINGERPRINT,
        }) as unknown,
      })
    )
  })

  it('pauses the spinner while the host key is confirmed', async () => {
    bastionIs({ publicAccess: true, publicIp: '203.0.113.10' })

    await openBastionTunnel(request)
    const config = mocks.openSshTunnel.mock.calls[0]?.[0] as {
      hostKey: { pauseOutput: () => void; resumeOutput: () => void }
    }

    config.hostKey.pauseOutput()
    expect(spinnerStop).toHaveBeenCalledOnce()
    config.hostKey.resumeOutput()
    expect(spinnerStart).toHaveBeenCalledOnce()
  })

  it('refuses a public bastion that has no address yet', async () => {
    bastionIs({ publicAccess: true, publicIp: null })

    await expect(openBastionTunnel(request)).rejects.toThrow(
      'Bastion host does not have a public IP address yet.'
    )
    expect(mocks.openSshTunnel).not.toHaveBeenCalled()
  })

  it('refuses a private bastion on a cloud the CLI has no transport for', async () => {
    bastionIs({ provider: 'gcp', publicAccess: false, publicIp: null })

    await expect(openBastionTunnel(request)).rejects.toThrow(
      'The bastion configuration is not valid.'
    )
    expect(mocks.startBastionSession).not.toHaveBeenCalled()
    expect(mocks.openSshTunnel).not.toHaveBeenCalled()
  })

  it('refuses a bastion that is not found', async () => {
    bastionIs(null)

    await expect(openBastionTunnel(request)).rejects.toThrow('Bastion host not found: ops-jump')
  })
})
