import { createHash } from 'crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'

import { confirm } from '@inquirer/prompts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  bastionHostId,
  fingerprintHostKey,
  HostKeyError,
  knownHostsPath,
  readKnownHost,
  recordKnownHost,
  verifyHostKey,
} from './known-hosts'

vi.mock(import('os'), async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, homedir: vi.fn() }
})
vi.mock('@inquirer/prompts', () => ({ confirm: vi.fn() }))

const KEY = Buffer.from('bastion-host-key')
const OTHER_KEY = Buffer.from('attacker-host-key')

function setTty(value: boolean) {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true })
  Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true })
}

describe('known-hosts', () => {
  let home: string
  const originalCi = process.env.CI
  const stdinTty = process.stdin.isTTY
  const stdoutTty = process.stdout.isTTY

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'gantry-known-hosts-'))
    vi.mocked(homedir).mockReturnValue(home)
    vi.mocked(confirm).mockReset()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    delete process.env.CI
    setTty(true)
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    vi.restoreAllMocks()
    if (originalCi === undefined) delete process.env.CI
    else process.env.CI = originalCi
    Object.defineProperty(process.stdin, 'isTTY', { value: stdinTty, configurable: true })
    Object.defineProperty(process.stdout, 'isTTY', { value: stdoutTty, configurable: true })
  })

  describe('fingerprintHostKey', () => {
    it('formats the key as an OpenSSH SHA256 fingerprint without padding', () => {
      const digest = createHash('sha256').update(KEY).digest('base64')
      const fingerprint = fingerprintHostKey(KEY)

      expect(digest.endsWith('=')).toBe(true)
      expect(fingerprint).toBe(`SHA256:${digest.replace(/=+$/, '')}`)
    })
  })

  describe('bastionHostId', () => {
    it('uses the instance id when present', () => {
      expect(bastionHostId({ id: 'b1', instanceId: 'i-0abc', publicIp: '1.2.3.4' })).toBe('i-0abc')
    })

    it('falls back to the bastion id and public IP', () => {
      expect(bastionHostId({ id: 'b1', publicIp: '1.2.3.4' })).toBe('bastion-b1@1.2.3.4')
    })

    it('throws when neither identifier is available', () => {
      expect(() => bastionHostId({ id: 'b1', publicIp: null })).toThrow(
        'Bastion has no instance id or public IP'
      )
      expect(() => bastionHostId({ publicIp: '1.2.3.4' })).toThrow()
    })
  })

  describe('store', () => {
    it('lives at ~/.gantry/known_hosts', () => {
      expect(knownHostsPath()).toBe(join(home, '.gantry', 'known_hosts'))
    })

    it('returns null when the file does not exist', () => {
      expect(readKnownHost('i-0abc')).toBeNull()
    })

    it('creates the directory 0700 and the file 0600', () => {
      recordKnownHost('i-0abc', 'SHA256:abc')

      expect(statSync(join(home, '.gantry')).mode & 0o777).toBe(0o700)
      expect(statSync(knownHostsPath()).mode & 0o777).toBe(0o600)
      expect(readKnownHost('i-0abc')).toBe('SHA256:abc')
    })

    it('tightens permissions on an existing directory and file', () => {
      mkdirSync(join(home, '.gantry'), { mode: 0o755 })
      writeFileSync(knownHostsPath(), '', { mode: 0o644 })

      recordKnownHost('i-0abc', 'SHA256:abc')

      expect(statSync(join(home, '.gantry')).mode & 0o777).toBe(0o700)
      expect(statSync(knownHostsPath()).mode & 0o777).toBe(0o600)
    })

    it('keeps other entries and replaces an existing one', () => {
      recordKnownHost('i-one', 'SHA256:one')
      recordKnownHost('i-two', 'SHA256:two')
      recordKnownHost('i-one', 'SHA256:new')

      expect(readFileSync(knownHostsPath(), 'utf-8')).toBe('i-one SHA256:new\ni-two SHA256:two\n')
    })

    it('ignores blank lines, comments and malformed lines', () => {
      mkdirSync(join(home, '.gantry'))
      writeFileSync(knownHostsPath(), '# note\n\ni-broken\n  i-0abc   SHA256:abc  \n')

      expect(readKnownHost('i-broken')).toBeNull()
      expect(readKnownHost('i-0abc')).toBe('SHA256:abc')
    })
  })

  describe('verifyHostKey', () => {
    const policy = { hostId: 'i-0abc', label: 'my-bastion' }

    it('accepts a key that matches the recorded fingerprint without prompting', async () => {
      recordKnownHost('i-0abc', fingerprintHostKey(KEY))

      await expect(verifyHostKey(KEY, policy)).resolves.toBeUndefined()
      expect(confirm).not.toHaveBeenCalled()
    })

    it('refuses a mismatched key without prompting, even with --trust-host-key', async () => {
      recordKnownHost('i-0abc', fingerprintHostKey(KEY))

      await expect(verifyHostKey(OTHER_KEY, { ...policy, trustHostKey: true })).rejects.toThrow(
        /does not match.*delete the line starting with "i-0abc"/s
      )
      expect(confirm).not.toHaveBeenCalled()
      expect(readKnownHost('i-0abc')).toBe(fingerprintHostKey(KEY))
    })

    it('prompts for an unknown key, pausing output, and records it when accepted', async () => {
      vi.mocked(confirm).mockResolvedValue(true)
      const pauseOutput = vi.fn()
      const resumeOutput = vi.fn()

      await verifyHostKey(KEY, { ...policy, pauseOutput, resumeOutput })

      expect(confirm).toHaveBeenCalledWith({ message: 'Trust this bastion?', default: false })
      expect(console.log).toHaveBeenCalledWith(
        `Host key fingerprint is ${fingerprintHostKey(KEY)}.`
      )
      expect(pauseOutput).toHaveBeenCalledOnce()
      expect(resumeOutput).toHaveBeenCalledOnce()
      expect(readKnownHost('i-0abc')).toBe(fingerprintHostKey(KEY))
    })

    it('refuses and records nothing when the prompt is declined', async () => {
      vi.mocked(confirm).mockResolvedValue(false)
      const resumeOutput = vi.fn()

      await expect(verifyHostKey(KEY, { ...policy, resumeOutput })).rejects.toBeInstanceOf(
        HostKeyError
      )
      expect(resumeOutput).toHaveBeenCalledOnce()
      expect(readKnownHost('i-0abc')).toBeNull()
    })

    it('fails without a TTY when --trust-host-key is not passed', async () => {
      setTty(false)

      await expect(verifyHostKey(KEY, policy)).rejects.toThrow(/Pass --trust-host-key/)
      expect(confirm).not.toHaveBeenCalled()
      expect(readKnownHost('i-0abc')).toBeNull()
    })

    it('fails in CI even with a TTY when --trust-host-key is not passed', async () => {
      process.env.CI = 'true'

      await expect(verifyHostKey(KEY, policy)).rejects.toThrow(/Pass --trust-host-key/)
      expect(confirm).not.toHaveBeenCalled()
    })

    it('records the key and prints the fingerprint with --trust-host-key and no TTY', async () => {
      setTty(false)

      await verifyHostKey(KEY, { ...policy, trustHostKey: true })

      expect(confirm).not.toHaveBeenCalled()
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining(fingerprintHostKey(KEY)))
      expect(readKnownHost('i-0abc')).toBe(fingerprintHostKey(KEY))
    })
  })
})
