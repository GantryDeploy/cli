import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

const graphqlRequest = vi.hoisted(() => vi.fn())
const spinner = vi.hoisted(() => ({ fail: vi.fn(), stop: vi.fn(), succeed: vi.fn() }))

vi.mock('ora', () => ({ default: () => ({ ...spinner, start: () => spinner }) }))
vi.mock('../lib/client', () => ({
  formatApiError: (error: unknown) => (error instanceof Error ? error.message : 'API error'),
  graphqlRequest,
}))

const { registerDatabasesCommand } = await import('./databases')

class ExitError extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`)
  }
}

const mainDb = {
  id: 'Xk9mQ2pL',
  name: 'Main DB',
  slug: 'main-db',
  engine: 'POSTGRESQL',
  status: 'ACTIVE',
  cloudAccountId: 'Jt5wPq8N',
  networkId: 'Hd3nVx6R',
  provider: 'AWS',
  endpoint: 'main-db.cluster-c9akciq32.us-east-1.rds.amazonaws.com',
  port: 5432,
  publiclyAccessible: false,
  createdAt: '2026-11-01T12:00:00Z',
}

const databases = { databases: [mainDb] }
const ready = { prepareDatabaseAccess: { success: true, ready: true, deploymentId: null } }

async function run(args: string[]): Promise<void> {
  const program = new Command()
  program.exitOverride()
  registerDatabasesCommand(program)
  await program.parseAsync(['node', 'gantry', 'databases', ...args])
}

function sentVariables(call: number): unknown {
  return graphqlRequest.mock.calls[call]?.[1]
}

describe('databases server commands', () => {
  let errorSpy: MockInstance
  let logSpy: MockInstance
  const logOutput = () => logSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n')
  const errorOutput = () => errorSpy.mock.calls.flat().join(' ')

  beforeEach(() => {
    vi.resetAllMocks()
    vi.useFakeTimers()
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitError(code as number | undefined)
    })
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe('repair', () => {
    it('asks the API to repair the server by id', async () => {
      graphqlRequest
        .mockResolvedValueOnce(databases)
        .mockResolvedValueOnce({ repairResource: { success: true, message: 'Repair initiated' } })

      await run(['repair', 'main-db'])

      expect(sentVariables(1)).toEqual({ resourceType: 'DATABASE', id: 'Xk9mQ2pL' })
      expect(logOutput()).toContain('Repairing main-db.')
      expect(logOutput()).toContain('gantry databases list')
    })

    it("prints the API's refusal and exits", async () => {
      graphqlRequest.mockResolvedValueOnce(databases).mockResolvedValueOnce({
        repairResource: { success: false, message: 'Resource is not in a repairable state.' },
      })

      await expect(run(['repair', 'main-db'])).rejects.toThrow(ExitError)
      expect(errorOutput()).toContain('Resource is not in a repairable state.')
    })

    it('refuses a server that does not exist', async () => {
      graphqlRequest.mockResolvedValueOnce(databases)

      await expect(run(['repair', 'old-db'])).rejects.toThrow(ExitError)
      expect(errorOutput()).toContain('Database not found.')
    })
  })

  describe('create-db', () => {
    it('creates the database once the server is ready', async () => {
      graphqlRequest
        .mockResolvedValueOnce(databases)
        .mockResolvedValueOnce(ready)
        .mockResolvedValueOnce({ createDatabaseOnServer: { success: true, message: 'Created' } })

      await run(['create-db', 'main-db', '--name', 'analytics'])

      expect(sentVariables(1)).toEqual({ databaseId: 'Xk9mQ2pL' })
      expect(sentVariables(2)).toEqual({ databaseId: 'Xk9mQ2pL', name: 'analytics' })
      expect(logOutput()).toContain('Created database analytics on main-db.')
    })

    it('waits for the provisioner to deploy before creating', async () => {
      graphqlRequest
        .mockResolvedValueOnce(databases)
        .mockResolvedValueOnce({
          prepareDatabaseAccess: { success: true, ready: false, deploymentId: 'Qs8wFj3T' },
        })
        .mockResolvedValueOnce({ deployment: { status: 'COMPLETE', lastMessage: 'Ready' } })
        .mockResolvedValueOnce({ createDatabaseOnServer: { success: true, message: 'Created' } })

      const pending = run(['create-db', 'main-db', '--name', 'analytics'])
      await vi.advanceTimersByTimeAsync(2000)
      await pending

      expect(sentVariables(2)).toEqual({ id: 'Qs8wFj3T' })
      expect(sentVariables(3)).toEqual({ databaseId: 'Xk9mQ2pL', name: 'analytics' })
    })

    it('stops when the provisioner deploy fails', async () => {
      graphqlRequest
        .mockResolvedValueOnce(databases)
        .mockResolvedValueOnce({
          prepareDatabaseAccess: { success: true, ready: false, deploymentId: 'Qs8wFj3T' },
        })
        .mockResolvedValueOnce({ deployment: { status: 'FAILED', lastMessage: 'Deploy failed' } })

      const pending = run(['create-db', 'main-db', '--name', 'analytics'])
      const failed = expect(pending).rejects.toThrow(ExitError)
      await vi.advanceTimersByTimeAsync(2000)
      await failed

      expect(spinner.fail).toHaveBeenCalledWith('Deploy failed')
      expect(graphqlRequest).toHaveBeenCalledTimes(3)
    })
  })

  describe('create-user', () => {
    const created = {
      createUserOnServer: {
        success: true,
        message: 'Created user reporting.',
        password: '7hQ2v-Xk9mPz4R8wLc3N',
        secretId: 'Bw9kTz2M',
      },
    }

    it('sends each grant and prints the password once with its secret', async () => {
      graphqlRequest
        .mockResolvedValueOnce(databases)
        .mockResolvedValueOnce(ready)
        .mockResolvedValueOnce(created)

      await run([
        'create-user',
        'main-db',
        '--name',
        'reporting',
        '--grant',
        'analytics:SELECT',
        '--grant',
        'events:ALL PRIVILEGES',
      ])

      expect(sentVariables(2)).toEqual({
        databaseId: 'Xk9mQ2pL',
        username: 'reporting',
        grants: [
          { database: 'analytics', privilege: 'SELECT' },
          { database: 'events', privilege: 'ALL PRIVILEGES' },
        ],
      })
      expect(logOutput()).toContain('Password: 7hQ2v-Xk9mPz4R8wLc3N  (shown once)')
      expect(logOutput()).toContain('Saved as secret: Bw9kTz2M')
    })

    it('prints JSON for scripts', async () => {
      graphqlRequest
        .mockResolvedValueOnce(databases)
        .mockResolvedValueOnce(ready)
        .mockResolvedValueOnce(created)

      await run(['create-user', 'main-db', '--name', 'reporting', '--json'])

      expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toEqual({
        username: 'reporting',
        password: '7hQ2v-Xk9mPz4R8wLc3N',
        secretId: 'Bw9kTz2M',
      })
    })

    it('says the password was not saved when the secret could not be written', async () => {
      graphqlRequest
        .mockResolvedValueOnce(databases)
        .mockResolvedValueOnce(ready)
        .mockResolvedValueOnce({
          createUserOnServer: {
            success: true,
            message:
              'Created user reporting. Its credentials could not be saved as a secret, so keep this password.',
            password: '7hQ2v-Xk9mPz4R8wLc3N',
            secretId: null,
          },
        })

      await run(['create-user', 'main-db', '--name', 'reporting'])

      expect(logOutput()).toContain('could not be saved as a secret')
    })

    it('refuses a grant without a database before calling the API', async () => {
      await expect(
        run(['create-user', 'main-db', '--name', 'reporting', '--grant', 'SELECT'])
      ).rejects.toThrow(ExitError)

      expect(errorOutput()).toContain('--grant SELECT is not <database>:<privilege>')
      expect(graphqlRequest).not.toHaveBeenCalled()
    })

    it("prints the API's refusal", async () => {
      graphqlRequest
        .mockResolvedValueOnce(databases)
        .mockResolvedValueOnce(ready)
        .mockResolvedValueOnce({
          createUserOnServer: {
            success: false,
            message: 'There was an error while creating the database user.',
            password: null,
            secretId: null,
          },
        })

      await expect(run(['create-user', 'main-db', '--name', 'reporting'])).rejects.toThrow(
        ExitError
      )
      expect(errorOutput()).toContain('There was an error while creating the database user.')
    })
  })
})
