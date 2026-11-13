import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

const mocks = vi.hoisted(() => ({
  graphqlRequest: vi.fn(),
  confirm: vi.fn(),
  isInteractive: vi.fn(() => true),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  readStdin: vi.fn(),
  loadProjectIdentity: vi.fn(),
  resolveEnvironmentSlug: vi.fn(),
}))

vi.mock('fs', () => ({
  existsSync: mocks.existsSync,
  readFileSync: mocks.readFileSync,
  writeFileSync: mocks.writeFileSync,
}))
vi.mock('@inquirer/prompts', () => ({ confirm: mocks.confirm }))
vi.mock('../lib/client', () => ({
  formatApiError: (error: unknown) => (error instanceof Error ? error.message : 'API error'),
  graphqlRequest: mocks.graphqlRequest,
}))
vi.mock('../lib/project-identity', () => ({
  loadProjectIdentity: mocks.loadProjectIdentity,
  resolveEnvironmentSlug: mocks.resolveEnvironmentSlug,
}))
vi.mock('../lib/stdin', () => ({ readStdin: mocks.readStdin }))
vi.mock('../lib/terminal', () => ({ isInteractive: mocks.isInteractive }))

const { registerEnvCommand } = await import('./env')

class ExitError extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`)
  }
}

const PROJECT_ID = 'p9ue62'
const STAGING = { scope: 'ENVIRONMENT', projectId: PROJECT_ID, environmentSlug: 'staging' }

function changes(created: string[] = [], updated: string[] = [], removed: string[] = []) {
  return { success: true, message: null, created, updated, removed }
}

async function run(...args: string[]): Promise<void> {
  const program = new Command()
  program.exitOverride()
  registerEnvCommand(program)
  await program.parseAsync(['node', 'gantry', 'env', ...args])
}

describe('env command', () => {
  let log: MockInstance
  let error: MockInstance
  let stdout: MockInstance

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isInteractive.mockReturnValue(true)
    mocks.existsSync.mockReturnValue(false)
    mocks.loadProjectIdentity.mockReturnValue({
      id: PROJECT_ID,
      environments: ['staging', 'production'],
    })
    mocks.resolveEnvironmentSlug.mockImplementation((_identity: unknown, slug: string) => slug)
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitError(typeof code === 'number' ? code : undefined)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const logged = () => log.mock.calls.map((call) => String(call[0])).join('\n')
  const errors = () => error.mock.calls.map((call) => String(call[0])).join('\n')

  describe('scope flags', () => {
    it.each([
      [['--team-wide'], { scope: 'TEAM' }],
      [['--cloud', 'ca_9mx4'], { scope: 'CLOUD_ACCOUNT', cloudAccountId: 'ca_9mx4' }],
      [['--network', 'nw_3kd8'], { scope: 'NETWORK', networkId: 'nw_3kd8' }],
      [['--project'], { scope: 'PROJECT', projectId: PROJECT_ID }],
      [['--env', 'staging'], STAGING],
      [['--env', 'staging', '--service', 'api'], { ...STAGING, service: 'api' }],
    ])('%j targets %j', async (flags, target) => {
      mocks.graphqlRequest.mockResolvedValueOnce({ envVars: [] })

      await run('get', ...flags)

      expect(mocks.graphqlRequest.mock.calls[0][1]).toEqual({ input: target })
    })

    it('requires a scope', async () => {
      await expect(run('get')).rejects.toThrow(ExitError)
      expect(errors()).toContain('Choose where the variables apply')
      expect(mocks.graphqlRequest).not.toHaveBeenCalled()
    })

    it('refuses two scopes at once', async () => {
      await expect(run('get', '--project', '--env', 'staging')).rejects.toThrow(ExitError)
      expect(errors()).toContain('Choose one of --project, --env.')
    })

    it('refuses --service without --env', async () => {
      await expect(run('get', '--project', '--service', 'api')).rejects.toThrow(ExitError)
      expect(errors()).toContain('--service needs --env <environment>.')
    })
  })

  describe('get', () => {
    it('prints one value bare, for scripts', async () => {
      mocks.graphqlRequest.mockResolvedValueOnce({
        envVars: [{ key: 'LOG_LEVEL', value: 'debug', updatedAt: '2026-11-12T10:00:00Z' }],
      })

      await run('get', '--env', 'staging', 'LOG_LEVEL')

      expect(stdout).toHaveBeenCalledWith('debug\n')
    })

    it('fails for a key that is not set', async () => {
      mocks.graphqlRequest.mockResolvedValueOnce({ envVars: [] })

      await expect(run('get', '--env', 'staging', 'LOG_LEVEL')).rejects.toThrow(ExitError)
      expect(errors()).toContain('LOG_LEVEL is not set for staging.')
    })

    it('shows the resolved env of a service with each source', async () => {
      mocks.graphqlRequest.mockResolvedValueOnce({
        resolvedServiceEnv: {
          versionNumber: 12,
          variables: [
            {
              key: 'LOG_LEVEL',
              value: 'debug',
              source: 'SERVICE_OVERRIDE',
              overrides: ['SERVICE_YAML', 'PROJECT'],
            },
            { key: 'APP_PG_*', value: 'database app-pg', source: 'BINDING', overrides: [] },
          ],
        },
      })

      await run('get', '--env', 'staging', '--service', 'api', '--resolved')

      expect(mocks.graphqlRequest.mock.calls[0][1]).toEqual({
        projectId: PROJECT_ID,
        environmentSlug: 'staging',
        service: 'api',
      })
      expect(logged()).toContain('staging/api, live version 12')
      expect(logged()).toContain('service override')
      expect(logged()).toContain('gantry.yml service, project')
    })

    it('refuses --resolved without a service', async () => {
      await expect(run('get', '--env', 'staging', '--resolved')).rejects.toThrow(ExitError)
      expect(errors()).toContain('--resolved needs --env <environment> and --service <name>.')
    })
  })

  describe('set', () => {
    it('sends each KEY=value and suggests a redeploy', async () => {
      mocks.graphqlRequest.mockResolvedValueOnce({
        setEnvVars: changes(['FEATURE_CHECKOUT_V2'], ['LOG_LEVEL']),
      })

      await run('set', '--env', 'staging', 'LOG_LEVEL=debug', 'FEATURE_CHECKOUT_V2=on')

      expect(mocks.graphqlRequest.mock.calls[0][1]).toEqual({
        input: {
          ...STAGING,
          variables: [
            { key: 'LOG_LEVEL', value: 'debug' },
            { key: 'FEATURE_CHECKOUT_V2', value: 'on' },
          ],
        },
      })
      expect(logged()).toContain('staging: added FEATURE_CHECKOUT_V2; changed LOG_LEVEL.')
      expect(logged()).toContain('Run `gantry redeploy staging` to apply it now.')
    })

    it('merges --from-file with arguments, arguments winning', async () => {
      mocks.readStdin.mockResolvedValueOnce('TZ=UTC\nLOG_LEVEL=info\n')
      mocks.graphqlRequest.mockResolvedValueOnce({ setEnvVars: changes(['TZ', 'LOG_LEVEL']) })

      await run('set', '--project', '--from-file', '-', 'LOG_LEVEL=warn')

      const { input } = mocks.graphqlRequest.mock.calls[0][1] as {
        input: { variables: unknown[] }
      }
      expect(input.variables).toEqual([
        { key: 'TZ', value: 'UTC' },
        { key: 'LOG_LEVEL', value: 'warn' },
      ])
      expect(logged()).toContain('Takes effect on the next deploy of each environment it covers.')
    })

    it('refuses an argument without = and never echoes it', async () => {
      await expect(run('set', '--env', 'staging', 'hunter2')).rejects.toThrow(ExitError)
      expect(errors()).toContain('Argument 1 is not KEY=value.')
      expect(errors()).not.toContain('hunter2')
    })

    it('redacts submitted values from an API refusal', async () => {
      mocks.graphqlRequest.mockResolvedValueOnce({
        setEnvVars: { ...changes(), success: false, message: 'Value sk_live_51Hx is not allowed' },
      })

      await expect(run('set', '--env', 'staging', 'STRIPE=sk_live_51Hx')).rejects.toThrow(ExitError)
      expect(errors()).not.toContain('sk_live_51Hx')
    })
  })

  describe('unset', () => {
    it('reports keys that were not set', async () => {
      mocks.graphqlRequest.mockResolvedValueOnce({ unsetEnvVars: changes([], [], ['LOG_LEVEL']) })

      await run('unset', '--env', 'staging', 'LOG_LEVEL', 'OLD_FLAG')

      expect(logged()).toContain('Not set for staging: OLD_FLAG')
      expect(logged()).toContain('staging: removed LOG_LEVEL.')
    })
  })

  describe('pull', () => {
    it('writes the scope to its default file, readable only by the user', async () => {
      mocks.graphqlRequest.mockResolvedValueOnce({
        envVars: [
          { key: 'TZ', value: 'UTC', updatedAt: '' },
          { key: 'GREETING', value: 'hello world', updatedAt: '' },
        ],
      })

      await run('pull', '--env', 'staging', '--service', 'api')

      expect(mocks.writeFileSync).toHaveBeenCalledWith(
        '.env.staging.api',
        'GREETING="hello world"\nTZ=UTC\n',
        { mode: 0o600 }
      )
    })

    it('refuses to overwrite a file without --force', async () => {
      mocks.existsSync.mockReturnValue(true)

      await expect(run('pull', '--project')).rejects.toThrow(ExitError)
      expect(errors()).toContain('.env.project already exists. Pass --force to overwrite it.')
      expect(mocks.writeFileSync).not.toHaveBeenCalled()
    })
  })

  describe('push', () => {
    beforeEach(() => {
      mocks.existsSync.mockReturnValue(true)
      mocks.readFileSync.mockReturnValue('TZ=UTC\nLOG_LEVEL=debug\n')
    })

    it('replaces the scope after confirming the keys it removes', async () => {
      mocks.graphqlRequest
        .mockResolvedValueOnce({
          envVars: [
            { key: 'TZ', value: 'UTC', updatedAt: '' },
            { key: 'OLD_FLAG', value: 'on', updatedAt: '' },
          ],
        })
        .mockResolvedValueOnce({ replaceEnvVars: changes(['LOG_LEVEL'], [], ['OLD_FLAG']) })
      mocks.confirm.mockResolvedValueOnce(true)

      await run('push', '--env', 'staging')

      expect(mocks.readFileSync).toHaveBeenCalledWith('.env.staging', 'utf-8')
      expect(logged()).toContain('will be removed: OLD_FLAG')
      expect(mocks.graphqlRequest.mock.calls[1][1]).toEqual({
        input: {
          ...STAGING,
          variables: [
            { key: 'TZ', value: 'UTC' },
            { key: 'LOG_LEVEL', value: 'debug' },
          ],
        },
      })
    })

    it('changes nothing when the removal is declined', async () => {
      mocks.graphqlRequest.mockResolvedValueOnce({
        envVars: [{ key: 'OLD_FLAG', value: 'on', updatedAt: '' }],
      })
      mocks.confirm.mockResolvedValueOnce(false)

      await run('push', '--env', 'staging')

      expect(logged()).toContain('Push cancelled. No changes were made.')
      expect(mocks.graphqlRequest).toHaveBeenCalledTimes(1)
    })

    it('needs --yes to remove keys without a terminal', async () => {
      mocks.isInteractive.mockReturnValue(false)
      mocks.graphqlRequest.mockResolvedValueOnce({
        envVars: [{ key: 'OLD_FLAG', value: 'on', updatedAt: '' }],
      })

      await expect(run('push', '--env', 'staging')).rejects.toThrow(ExitError)
      expect(errors()).toContain('Re-run with --yes to confirm')
    })

    it('points at pull when the file is missing', async () => {
      mocks.existsSync.mockReturnValue(false)

      await expect(run('push', '--env', 'staging')).rejects.toThrow(ExitError)
      expect(errors()).toContain('.env.staging does not exist. Run `gantry env pull` first')
    })
  })
})
