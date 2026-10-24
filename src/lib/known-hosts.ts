import { createHash } from 'crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'

import { confirm } from '@inquirer/prompts'

import { isInteractive } from './terminal'

export interface HostKeyPolicy {
  hostId: string
  label: string
  /** Fingerprint Gantry recorded when it provisioned the bastion; null for older bastions */
  expectedFingerprint: string | null
  trustHostKey?: boolean
  pauseOutput?: () => void
  resumeOutput?: () => void
}

export interface BastionIdentity {
  id?: string | null
  instanceId?: string | null
  publicIp?: string | null
}

export class HostKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HostKeyError'
  }
}

export function knownHostsPath(): string {
  return join(homedir(), '.gantry', 'known_hosts')
}

export function fingerprintHostKey(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
}

export function bastionHostId(bastion: BastionIdentity): string {
  const { instanceId, publicIp } = bastion
  if (instanceId) return instanceId

  if (!bastion.id || !publicIp) {
    throw new Error('Bastion has no instance id or public IP to identify its host key by.')
  }
  return `bastion-${bastion.id}@${publicIp}`
}

function readEntries(): Map<string, string> {
  const entries = new Map<string, string>()
  const path = knownHostsPath()
  if (!existsSync(path)) return entries

  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const [hostId, fingerprint] = trimmed.split(/\s+/)
    if (hostId && fingerprint) entries.set(hostId, fingerprint)
  }
  return entries
}

export function readKnownHost(hostId: string): string | null {
  return readEntries().get(hostId) ?? null
}

export function recordKnownHost(hostId: string, fingerprint: string): void {
  const path = knownHostsPath()
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)

  const entries = readEntries()
  entries.set(hostId, fingerprint)
  const body = [...entries].map(([id, fp]) => `${id} ${fp}`).join('\n') + '\n'
  writeFileSync(path, body, { mode: 0o600 })
  chmodSync(path, 0o600)
}

async function withPausedOutput<T>(policy: HostKeyPolicy, fn: () => Promise<T>): Promise<T> {
  policy.pauseOutput?.()
  try {
    return await fn()
  } finally {
    policy.resumeOutput?.()
  }
}

export async function verifyHostKey(key: Buffer, policy: HostKeyPolicy): Promise<void> {
  const fingerprint = fingerprintHostKey(key)
  const known = readKnownHost(policy.hostId)

  // The API's record is authoritative, so it overrides a stale or
  // first-use entry in known_hosts and there is nothing to prompt for.
  if (policy.expectedFingerprint) {
    if (fingerprint !== policy.expectedFingerprint) {
      throw new HostKeyError(
        `The host key for bastion ${policy.label} (${policy.hostId}) does not match the one Gantry recorded when it provisioned the bastion. ` +
          `Someone may be intercepting the connection, so the tunnel was not opened. ` +
          `A bastion created in the last few minutes may not have installed its recorded host key yet.`
      )
    }
    if (known !== fingerprint) recordKnownHost(policy.hostId, fingerprint)
    return
  }

  if (known === fingerprint) return

  if (known) {
    throw new HostKeyError(
      `The host key for bastion ${policy.label} (${policy.hostId}) does not match the one recorded in ${knownHostsPath()}. ` +
        `Someone may be intercepting the connection, so the tunnel was not opened. ` +
        `If you know the bastion's key legitimately changed, delete the line starting with "${policy.hostId}" from that file and reconnect to trust the new key.`
    )
  }

  if (policy.trustHostKey) {
    await withPausedOutput(policy, () => {
      console.log(
        `Trusting host key for bastion ${policy.label} (${policy.hostId}): ${fingerprint} (--trust-host-key)`
      )
      return Promise.resolve()
    })
    recordKnownHost(policy.hostId, fingerprint)
    return
  }

  if (!isInteractive()) {
    throw new HostKeyError(
      `The host key for bastion ${policy.label} (${policy.hostId}) is not yet trusted, and there is no terminal to confirm it. ` +
        `Pass --trust-host-key to trust and record it (${fingerprint}).`
    )
  }

  const trusted = await withPausedOutput(policy, () => {
    console.log(
      `The authenticity of bastion ${policy.label} (${policy.hostId}) can't be established.`
    )
    console.log(`Host key fingerprint is ${fingerprint}.`)
    return confirm({ message: 'Trust this bastion?', default: false })
  })

  if (!trusted) {
    throw new HostKeyError('The bastion host key was not trusted, so the tunnel was not opened.')
  }

  recordKnownHost(policy.hostId, fingerprint)
}
