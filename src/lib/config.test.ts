import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { credentialsPath, getApiUrl, getTeam, loadToken, setTeam, validateApiUrl } from './config'

vi.mock('fs')
vi.mock('os', () => ({
  homedir: vi.fn(() => '/home/user'),
}))

describe('config', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
    vi.clearAllMocks()
  })

  afterEach(() => {
    process.env = originalEnv
  })

  describe('loadToken', () => {
    it('returns the token from GANTRY_API_TOKEN', () => {
      process.env.GANTRY_API_TOKEN = 'gantry_sk_test_abc123'
      vi.mocked(homedir).mockReturnValue('/home/user')
      vi.mocked(existsSync).mockReturnValue(false)

      const token = loadToken()

      expect(token).toBe('gantry_sk_test_abc123')
      expect(existsSync).not.toHaveBeenCalled()
    })

    it('reads the token from the credentials file when the env var is unset', () => {
      delete process.env.GANTRY_API_TOKEN
      vi.mocked(homedir).mockReturnValue('/home/user')
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ token: 'gantry_sk_file_xyz789' }))

      const token = loadToken()

      expect(token).toBe('gantry_sk_file_xyz789')
      expect(existsSync).toHaveBeenCalledWith(join('/home/user', '.gantry', 'credentials'))
      expect(readFileSync).toHaveBeenCalledWith(
        join('/home/user', '.gantry', 'credentials'),
        'utf-8'
      )
    })

    it('returns null when the credentials file does not exist', () => {
      delete process.env.GANTRY_API_TOKEN
      vi.mocked(homedir).mockReturnValue('/home/user')
      vi.mocked(existsSync).mockReturnValue(false)

      const token = loadToken()

      expect(token).toBeNull()
    })

    it('returns null when the credentials file is invalid JSON', () => {
      delete process.env.GANTRY_API_TOKEN
      vi.mocked(homedir).mockReturnValue('/home/user')
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue('invalid json')

      const token = loadToken()

      expect(token).toBeNull()
    })

    it('returns null when the credentials file has no token field', () => {
      delete process.env.GANTRY_API_TOKEN
      vi.mocked(homedir).mockReturnValue('/home/user')
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ other: 'data' }))

      const token = loadToken()

      expect(token).toBeNull()
    })

    it('prefers the environment variable over the credentials file', () => {
      process.env.GANTRY_API_TOKEN = 'gantry_sk_env_priority'
      vi.mocked(homedir).mockReturnValue('/home/user')
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({ token: 'gantry_sk_file_should_not_use' })
      )

      const token = loadToken()

      expect(token).toBe('gantry_sk_env_priority')
      expect(existsSync).not.toHaveBeenCalled()
    })
  })

  describe('getApiUrl', () => {
    it('returns GANTRY_API_URL when set', () => {
      process.env.GANTRY_API_URL = 'https://custom.api.com'

      const url = getApiUrl()

      expect(url).toBe('https://custom.api.com')
    })

    it('returns the default API URL when the variable is unset', () => {
      delete process.env.GANTRY_API_URL

      const url = getApiUrl()

      expect(url).toBe('https://api.gantrydeploy.com')
    })

    it('falls back to the default API URL when the environment variable is empty', () => {
      process.env.GANTRY_API_URL = ''

      const url = getApiUrl()

      expect(url).toBe('https://api.gantrydeploy.com')
    })

    it.each([
      'https://api.gantrydeploy.com',
      'https://staging.example.com:8443/base',
      'http://localhost:3023',
      'http://127.0.0.1:3023',
      'http://[::1]:3023',
      'HTTP://LOCALHOST:3023',
    ])('accepts %s', (value) => {
      process.env.GANTRY_API_URL = value

      expect(getApiUrl()).toBe(value)
    })

    it.each([
      ['http://example.com', /must use https/],
      ['http://localhost.example.com', /must use https/],
      ['http://10.0.0.5:3023', /must use https/],
      ['ftp://x', /must be an https URL/],
      ['file:///etc/passwd', /must be an https URL/],
      ['garbage', /not a valid URL/],
      ['https://user@host.example.com', /username or password/],
    ])('rejects %s', (value, message) => {
      process.env.GANTRY_API_URL = value

      expect(() => getApiUrl()).toThrow(message)
    })

    it('names the variable without echoing embedded credentials', () => {
      process.env.GANTRY_API_URL = 'https://u:s3cr3t-pass@host.example.com'

      expect(() => getApiUrl()).toThrow(/GANTRY_API_URL/)
      try {
        getApiUrl()
      } catch (error) {
        expect((error as Error).message).not.toContain('s3cr3t-pass')
        expect((error as Error).message).not.toContain('host.example.com')
      }
    })
  })

  describe('credentialsPath', () => {
    it('points at ~/.gantry/credentials', () => {
      expect(credentialsPath()).toBe(join('/home/user', '.gantry', 'credentials'))
    })
  })

  describe('getTeam', () => {
    afterEach(() => {
      setTeam(undefined)
    })

    it('is null with neither --team nor GANTRY_TEAM', () => {
      delete process.env.GANTRY_TEAM
      setTeam(undefined)

      expect(getTeam()).toBeNull()
    })

    it('falls back to GANTRY_TEAM', () => {
      process.env.GANTRY_TEAM = 'team_env'
      setTeam(undefined)

      expect(getTeam()).toBe('team_env')
    })

    it('prefers --team over GANTRY_TEAM', () => {
      process.env.GANTRY_TEAM = 'team_env'
      setTeam('team_flag')

      expect(getTeam()).toBe('team_flag')
    })
  })

  describe('validateApiUrl', () => {
    it('rejects credentials even on loopback http', () => {
      expect(() => {
        validateApiUrl('http://u:p@localhost:3023')
      }).toThrow(/username or password/)
    })
  })
})
