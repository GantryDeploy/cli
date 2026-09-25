import { Command } from 'commander'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'

const formatApiError = vi.hoisted(() =>
  vi.fn((error: unknown) => (error instanceof Error ? error.message : 'API error'))
)
const graphqlRequest = vi.hoisted(() => vi.fn())
const confirm = vi.hoisted(() => vi.fn())
const input = vi.hoisted(() => vi.fn())
const isInteractive = vi.hoisted(() => vi.fn(() => true))
const readFileSync = vi.hoisted(() => vi.fn())
const readStdin = vi.hoisted(() => vi.fn())
const selectCloud = vi.hoisted(() => vi.fn())
const selectSecret = vi.hoisted(() => vi.fn())

vi.mock('fs', () => ({ readFileSync }))
vi.mock('@inquirer/prompts', () => ({ confirm, input }))
vi.mock('../lib/client', () => ({ formatApiError, graphqlRequest }))
vi.mock('../lib/interactive-prompts', () => ({ selectCloud, selectSecret }))
vi.mock('../lib/stdin', () => ({ readStdin }))
vi.mock('../lib/terminal', () => ({ isInteractive }))

const { registerSecretsCommand } = await import('./secrets')

class ExitError extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`)
  }
}

async function run(args: string[]): Promise<void> {
  const program = new Command()
  registerSecretsCommand(program)
  await program.parseAsync(['node', 'gantry', 'secrets', ...args])
}

describe('secrets command', () => {
  let errorSpy: MockInstance

  beforeEach(() => {
    vi.clearAllMocks()
    isInteractive.mockReturnValue(true)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new ExitError(typeof code === 'number' ? code : undefined)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function printedErrors(): string {
    return errorSpy.mock.calls.map((call) => String(call[0])).join('\n')
  }

  it('create sends keyValuePairs, merging --from-file and --set', async () => {
    readFileSync.mockReturnValueOnce('# comment\nDB_HOST=db.internal\nAPI_KEY=from-file\n')
    graphqlRequest.mockResolvedValueOnce({
      createSecret: {
        success: true,
        secret: { id: 'sec-1', name: 'app', cloudAccountId: 'cloud-1', createdAt: '' },
      },
    })

    await run([
      'create',
      '--cloud',
      'cloud-1',
      '--name',
      'app',
      '--description',
      'App secrets',
      '--from-file',
      '.env',
      '--set',
      'API_KEY=a=b',
    ])

    expect(graphqlRequest).toHaveBeenCalledTimes(1)
    expect(graphqlRequest.mock.calls[0]?.[1]).toEqual({
      input: {
        cloudAccountId: 'cloud-1',
        name: 'app',
        description: 'App secrets',
        keyValuePairs: [
          { key: 'DB_HOST', value: 'db.internal' },
          { key: 'API_KEY', value: 'a=b' },
        ],
      },
    })
  })

  it('create sends an empty keyValuePairs list when no values are given', async () => {
    graphqlRequest.mockResolvedValueOnce({
      createSecret: {
        success: true,
        secret: { id: 'sec-1', name: 'app', cloudAccountId: 'cloud-1', createdAt: '' },
      },
    })

    await run(['create', '--cloud', 'cloud-1', '--name', 'app', '--description', 'x'])

    const variables = graphqlRequest.mock.calls[0]?.[1] as { input: Record<string, unknown> }
    expect(variables.input.keyValuePairs).toEqual([])
    expect(variables.input).not.toHaveProperty('values')
  })

  it('update sends keyValuePairs when values are set', async () => {
    graphqlRequest
      .mockResolvedValueOnce({ secret: { id: 'sec-1', keys: ['TOKEN', 'MODE'] } })
      .mockResolvedValueOnce({ updateSecret: { success: true } })

    await run(['update', 'sec-1', '--set', 'TOKEN=abc', '--set', 'MODE=prod'])

    expect(graphqlRequest.mock.calls[1]?.[1]).toEqual({
      input: {
        id: 'sec-1',
        description: undefined,
        keyValuePairs: [
          { key: 'TOKEN', value: 'abc' },
          { key: 'MODE', value: 'prod' },
        ],
      },
    })
  })

  it('update leaves keyValuePairs undefined when only the description changes', async () => {
    graphqlRequest.mockResolvedValueOnce({ updateSecret: { success: true } })

    await run(['update', 'sec-1', '--description', 'rotated'])

    expect(graphqlRequest.mock.calls[0]?.[1]).toEqual({
      input: { id: 'sec-1', description: 'rotated', keyValuePairs: undefined },
    })
  })

  it('reports a malformed --set by position without echoing the value', async () => {
    await expect(
      run(['update', 'sec-1', '--set', 'OK=fine', '--set', 'hunter2-typo-no-separator'])
    ).rejects.toThrow(ExitError)

    expect(printedErrors()).toContain('Invalid entry at --set #2. Expected KEY=value.')
    expect(printedErrors()).not.toContain('hunter2')
    expect(graphqlRequest).not.toHaveBeenCalled()
  })

  it('rejects a --set with an empty key without echoing the value', async () => {
    await expect(run(['update', 'sec-1', '--set', '=hunter2-value'])).rejects.toThrow(ExitError)

    expect(printedErrors()).toContain('--set #1')
    expect(printedErrors()).not.toContain('hunter2')
  })

  it('reports a malformed --from-file line by its line number without echoing it', async () => {
    readFileSync.mockReturnValueOnce('A=1\n# comment\n\nhunter2-line\n')

    await expect(run(['update', 'sec-1', '--from-file', 'prod.env'])).rejects.toThrow(ExitError)

    expect(printedErrors()).toContain('Invalid entry at prod.env line 4.')
    expect(printedErrors()).not.toContain('hunter2')
  })

  it('create --from-file - reads KEY=value lines from stdin without prompting', async () => {
    readStdin.mockResolvedValueOnce('# from a pipe\nDB_PASS=p@ss=word\nAPI_KEY=k1\n')
    graphqlRequest.mockResolvedValueOnce({
      createSecret: {
        success: true,
        secret: { id: 'sec-1', name: 'app', cloudAccountId: 'cloud-1', createdAt: '' },
      },
    })

    await run(['create', '--cloud', 'cloud-1', '--name', 'app', '--from-file', '-'])

    expect(readFileSync).not.toHaveBeenCalled()
    expect(input).not.toHaveBeenCalled()
    expect(graphqlRequest.mock.calls[0]?.[1]).toEqual({
      input: {
        cloudAccountId: 'cloud-1',
        name: 'app',
        description: undefined,
        keyValuePairs: [
          { key: 'DB_PASS', value: 'p@ss=word' },
          { key: 'API_KEY', value: 'k1' },
        ],
      },
    })
  })

  it('create --from-file - requires --cloud and --name because stdin is taken', async () => {
    await expect(run(['create', '--name', 'app', '--from-file', '-'])).rejects.toThrow(ExitError)

    expect(printedErrors()).toContain('--cloud and --name are required')
    expect(readStdin).not.toHaveBeenCalled()
    expect(selectCloud).not.toHaveBeenCalled()
  })

  it('update --from-file - reads values from stdin and names stdin in parse errors', async () => {
    readStdin.mockResolvedValueOnce('TOKEN=abc\n')
    graphqlRequest
      .mockResolvedValueOnce({ secret: { id: 'sec-1', keys: ['TOKEN'] } })
      .mockResolvedValueOnce({ updateSecret: { success: true } })

    await run(['update', 'sec-1', '--from-file', '-'])

    expect(graphqlRequest.mock.calls[1]?.[1]).toEqual({
      input: {
        id: 'sec-1',
        description: undefined,
        keyValuePairs: [{ key: 'TOKEN', value: 'abc' }],
      },
    })

    readStdin.mockResolvedValueOnce('\nhunter2\n')
    await expect(run(['update', 'sec-1', '--from-file', '-'])).rejects.toThrow(ExitError)
    expect(printedErrors()).toContain('Invalid entry at stdin line 2.')
    expect(printedErrors()).not.toContain('hunter2')
  })

  it('update --from-file - requires the secret ID', async () => {
    await expect(run(['update', '--from-file', '-'])).rejects.toThrow(ExitError)

    expect(printedErrors()).toContain('the secret ID is required')
    expect(selectSecret).not.toHaveBeenCalled()
  })

  it('passes the submitted values to formatApiError so an echo can be masked', async () => {
    const failure = new Error('server said no')
    graphqlRequest
      .mockResolvedValueOnce({ secret: { id: 'sec-1', keys: ['A', 'B'] } })
      .mockRejectedValueOnce(failure)

    await expect(
      run(['update', 'sec-1', '--set', 'A=first-secret', '--set', 'B=second'])
    ).rejects.toThrow(ExitError)

    expect(formatApiError).toHaveBeenCalledWith(failure, ['first-secret', 'second'])
  })

  it('masks submitted values echoed in an unsuccessful mutation message', async () => {
    graphqlRequest
      .mockResolvedValueOnce({ secret: { id: 'sec-1', keys: ['A'] } })
      .mockResolvedValueOnce({
        updateSecret: { success: false, message: 'value first-secret is not allowed' },
      })

    await expect(run(['update', 'sec-1', '--set', 'A=first-secret'])).rejects.toThrow(ExitError)

    expect(printedErrors()).toContain('[redacted] is not allowed')
    expect(printedErrors()).not.toContain('first-secret')
  })

  describe('update key removal guard', () => {
    const existingKeys = { secret: { id: 'sec-1', keys: ['TOKEN', 'DB_PASS', 'API_KEY'] } }

    function printedOutput(): string {
      return vi
        .mocked(console.log)
        .mock.calls.map((call) => String(call[0]))
        .join('\n')
    }

    it('asks before removing keys and lists their names but never values', async () => {
      graphqlRequest
        .mockResolvedValueOnce(existingKeys)
        .mockResolvedValueOnce({ updateSecret: { success: true } })
      confirm.mockResolvedValueOnce(true)

      await run(['update', 'sec-1', '--set', 'TOKEN=new-token-value'])

      expect(String(graphqlRequest.mock.calls[0]?.[0])).toContain('query GetSecretKeys')
      expect(graphqlRequest.mock.calls[0]?.[1]).toEqual({ id: 'sec-1' })
      expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ default: false }))
      expect(printedOutput()).toContain('These keys will be removed: DB_PASS, API_KEY')
      expect(printedOutput()).not.toContain('new-token-value')
      expect(graphqlRequest).toHaveBeenCalledTimes(2)
    })

    it('sends nothing when the removal is declined', async () => {
      graphqlRequest.mockResolvedValueOnce(existingKeys)
      confirm.mockResolvedValueOnce(false)

      await run(['update', 'sec-1', '--set', 'TOKEN=abc'])

      expect(graphqlRequest).toHaveBeenCalledTimes(1)
      expect(printedOutput()).toContain('Update cancelled. No changes were made.')
    })

    it('skips the prompt with --yes', async () => {
      graphqlRequest
        .mockResolvedValueOnce(existingKeys)
        .mockResolvedValueOnce({ updateSecret: { success: true } })

      await run(['update', 'sec-1', '--set', 'TOKEN=abc', '--yes'])

      expect(confirm).not.toHaveBeenCalled()
      expect(graphqlRequest.mock.calls[1]?.[1]).toMatchObject({
        input: { keyValuePairs: [{ key: 'TOKEN', value: 'abc' }] },
      })
    })

    it('fails without --yes when there is no terminal to confirm', async () => {
      isInteractive.mockReturnValue(false)
      graphqlRequest.mockResolvedValueOnce(existingKeys)

      await expect(run(['update', 'sec-1', '--set', 'TOKEN=abc'])).rejects.toThrow(ExitError)

      expect(confirm).not.toHaveBeenCalled()
      expect(graphqlRequest).toHaveBeenCalledTimes(1)
      expect(printedErrors()).toContain('would remove: DB_PASS, API_KEY')
      expect(printedErrors()).toContain('--yes')
    })

    it('does not prompt when every existing key is kept', async () => {
      isInteractive.mockReturnValue(false)
      graphqlRequest
        .mockResolvedValueOnce({ secret: { id: 'sec-1', keys: ['TOKEN'] } })
        .mockResolvedValueOnce({ updateSecret: { success: true } })

      await run(['update', 'sec-1', '--set', 'TOKEN=abc', '--set', 'NEW=1'])

      expect(confirm).not.toHaveBeenCalled()
      expect(graphqlRequest).toHaveBeenCalledTimes(2)
    })

    it('rejects an empty value set instead of reporting success', async () => {
      readFileSync.mockReturnValueOnce('# only comments\n\n')

      await expect(run(['update', 'sec-1', '--from-file', 'empty.env'])).rejects.toThrow(ExitError)

      expect(printedErrors()).toContain('No secret values provided.')
      expect(graphqlRequest).not.toHaveBeenCalled()
    })

    it('fails when the secret does not exist', async () => {
      graphqlRequest.mockResolvedValueOnce({ secret: null })

      await expect(run(['update', 'sec-1', '--set', 'TOKEN=abc'])).rejects.toThrow(ExitError)

      expect(printedErrors()).toContain('Secret not found.')
      expect(graphqlRequest).toHaveBeenCalledTimes(1)
    })
  })

  describe('--from-file parsing', () => {
    async function parsedPairs(content: string): Promise<unknown> {
      readFileSync.mockReturnValueOnce(content)
      graphqlRequest.mockResolvedValueOnce({
        createSecret: {
          success: true,
          secret: { id: 'sec-1', name: 'app', cloudAccountId: 'cloud-1', createdAt: '' },
        },
      })
      await run([
        'create',
        '--cloud',
        'c',
        '--name',
        'app',
        '--description',
        'd',
        '--from-file',
        'x.env',
      ])
      return (graphqlRequest.mock.calls[0]?.[1] as { input: { keyValuePairs: unknown } }).input
        .keyValuePairs
    }

    it('accepts CRLF line endings without keeping a trailing carriage return', async () => {
      expect(await parsedPairs('A=1\r\nB=two words\r\n')).toEqual([
        { key: 'A', value: '1' },
        { key: 'B', value: 'two words' },
      ])
    })

    it('strips a leading UTF-8 byte order mark from the first key', async () => {
      expect(await parsedPairs('\uFEFFA=1\nB=2\n')).toEqual([
        { key: 'A', value: '1' },
        { key: 'B', value: '2' },
      ])
    })

    it('strips a leading export from keys', async () => {
      expect(await parsedPairs('export A=1\nexport\tB=2\nexported=3\n')).toEqual([
        { key: 'A', value: '1' },
        { key: 'B', value: '2' },
        { key: 'exported', value: '3' },
      ])
    })

    it('skips indented comments and blank lines', async () => {
      expect(await parsedPairs('  # indented comment\n\t# tabbed\n   \nA=1\n')).toEqual([
        { key: 'A', value: '1' },
      ])
    })

    it('keeps quotes and everything after the first = literally', async () => {
      expect(await parsedPairs('A="quoted"\nB=\'single\'\nC=x=y # not a comment\n')).toEqual([
        { key: 'A', value: '"quoted"' },
        { key: 'B', value: "'single'" },
        { key: 'C', value: 'x=y # not a comment' },
      ])
    })

    it('counts CRLF line endings when numbering parse errors', async () => {
      readFileSync.mockReturnValueOnce('A=1\r\n\r\nhunter2\r\n')

      await expect(run(['update', 'sec-1', '--from-file', 'prod.env'])).rejects.toThrow(ExitError)

      expect(printedErrors()).toContain('Invalid entry at prod.env line 3.')
      expect(printedErrors()).not.toContain('hunter2')
    })
  })

  describe('list', () => {
    it('prints a table of secrets filtered by cloud', async () => {
      graphqlRequest.mockResolvedValueOnce({
        secrets: [
          {
            id: 'sec-1',
            name: 'app',
            cloudAccountId: 'cloud-1',
            createdAt: '2026-01-01T00:00:00Z',
          },
          {
            id: 'sec-2',
            name: 'db',
            description: 'Database',
            cloudAccountId: 'cloud-1',
            createdAt: '2026-01-02T00:00:00Z',
          },
        ],
      })

      await run(['list', '--cloud', 'cloud-1'])

      expect(graphqlRequest.mock.calls[0]?.[1]).toEqual({ cloudAccountId: 'cloud-1' })
      const output = String(vi.mocked(console.log).mock.calls[0]?.[0])
      expect(output).toContain('sec-1')
      expect(output).toContain('Database')
    })

    it('says so when there are no secrets', async () => {
      graphqlRequest.mockResolvedValueOnce({ secrets: [] })

      await run(['list'])

      expect(graphqlRequest.mock.calls[0]?.[1]).toEqual({})
      expect(console.log).toHaveBeenCalledWith('No secrets found.')
    })

    it('reports an API failure', async () => {
      graphqlRequest.mockRejectedValueOnce(new Error('list failed'))

      await expect(run(['list'])).rejects.toThrow(ExitError)

      expect(printedErrors()).toContain('list failed')
    })
  })

  describe('show', () => {
    it('fails when the secret does not exist', async () => {
      graphqlRequest.mockResolvedValueOnce({ secret: null })

      await expect(run(['show', 'sec-9'])).rejects.toThrow(ExitError)

      expect(printedErrors()).toContain('Secret not found: sec-9')
    })

    it('prints a dash for a missing description', async () => {
      graphqlRequest.mockResolvedValueOnce({
        secret: {
          id: 'sec-1',
          name: 'app',
          cloudAccountId: 'c',
          createdAt: '2026-01-01T00:00:00Z',
        },
      })

      await run(['show', 'sec-1'])

      expect(console.log).toHaveBeenCalledWith('  Description:   -')
    })

    it('reports an API failure', async () => {
      graphqlRequest.mockRejectedValueOnce(new Error('show failed'))

      await expect(run(['show', 'sec-1'])).rejects.toThrow(ExitError)

      expect(printedErrors()).toContain('show failed')
    })
  })

  describe('create', () => {
    it('prompts for the cloud, name and description when not given', async () => {
      selectCloud.mockResolvedValueOnce('cloud-p')
      input.mockResolvedValueOnce('prompted-name').mockResolvedValueOnce('')
      graphqlRequest.mockResolvedValueOnce({
        createSecret: {
          success: true,
          secret: { id: 'sec-1', name: 'prompted-name', cloudAccountId: 'cloud-p', createdAt: '' },
        },
      })

      await run(['create', '--set', 'A=1'])

      const nameValidate = (input.mock.calls[0]?.[0] as { validate: (v: string) => unknown })
        .validate
      expect(nameValidate('  ')).toBe('Name is required')
      expect(nameValidate('ok')).toBe(true)
      expect(graphqlRequest.mock.calls[0]?.[1]).toEqual({
        input: {
          cloudAccountId: 'cloud-p',
          name: 'prompted-name',
          description: undefined,
          keyValuePairs: [{ key: 'A', value: '1' }],
        },
      })
      expect(console.log).toHaveBeenCalledWith('  ID: sec-1')
    })

    it('masks submitted values in an unsuccessful result message', async () => {
      graphqlRequest.mockResolvedValueOnce({
        createSecret: { success: false, message: 'rejected correct horse battery' },
      })

      await expect(
        run([
          'create',
          '--cloud',
          'c',
          '--name',
          'n',
          '--description',
          'd',
          '--set',
          'P=correct horse battery',
        ])
      ).rejects.toThrow(ExitError)

      expect(printedErrors()).toContain('rejected [redacted]')
      expect(printedErrors()).not.toContain('horse')
    })

    it('uses a generic message when an unsuccessful result has none', async () => {
      graphqlRequest.mockResolvedValueOnce({ createSecret: { success: true } })

      await expect(
        run(['create', '--cloud', 'c', '--name', 'n', '--description', 'd'])
      ).rejects.toThrow(ExitError)

      expect(printedErrors()).toContain('Failed to create secret')
    })

    it('passes submitted values to formatApiError when the request throws', async () => {
      const failure = new Error('boom')
      graphqlRequest.mockRejectedValueOnce(failure)

      await expect(
        run([
          'create',
          '--cloud',
          'c',
          '--name',
          'n',
          '--description',
          'd',
          '--set',
          'K=s3cret-val',
        ])
      ).rejects.toThrow(ExitError)

      expect(formatApiError).toHaveBeenCalledWith(failure, ['s3cret-val'])
    })
  })

  describe('update', () => {
    it('prompts for the secret when no ID is given', async () => {
      selectSecret.mockResolvedValueOnce('sec-p')
      graphqlRequest.mockResolvedValueOnce({ updateSecret: { success: true } })

      await run(['update', '--description', 'x'])

      expect(graphqlRequest.mock.calls[0]?.[1]).toEqual({
        input: { id: 'sec-p', description: 'x', keyValuePairs: undefined },
      })
    })

    it('uses a generic message when an unsuccessful result has none', async () => {
      graphqlRequest.mockResolvedValueOnce({ updateSecret: { success: false } })

      await expect(run(['update', 'sec-1', '--description', 'x'])).rejects.toThrow(ExitError)

      expect(printedErrors()).toContain('Failed to update secret')
    })
  })

  describe('delete', () => {
    it('deletes the given secret', async () => {
      graphqlRequest.mockResolvedValueOnce({ deleteSecret: { success: true } })

      await run(['delete', 'sec-1'])

      expect(graphqlRequest.mock.calls[0]?.[1]).toEqual({ id: 'sec-1' })
      expect(String(vi.mocked(console.log).mock.calls[0]?.[0])).toContain(
        'Secret deleted successfully'
      )
    })

    it('prompts for the secret when no ID is given', async () => {
      selectSecret.mockResolvedValueOnce('sec-p')
      graphqlRequest.mockResolvedValueOnce({ deleteSecret: { success: true } })

      await run(['delete'])

      expect(graphqlRequest.mock.calls[0]?.[1]).toEqual({ id: 'sec-p' })
    })

    it('reports an unsuccessful result', async () => {
      graphqlRequest.mockResolvedValueOnce({ deleteSecret: { success: false, message: 'in use' } })

      await expect(run(['delete', 'sec-1'])).rejects.toThrow(ExitError)

      expect(printedErrors()).toContain('in use')
    })

    it('uses a generic message when an unsuccessful result has none', async () => {
      graphqlRequest.mockResolvedValueOnce({ deleteSecret: { success: false } })

      await expect(run(['delete', 'sec-1'])).rejects.toThrow(ExitError)

      expect(printedErrors()).toContain('Failed to delete secret')
    })

    it('reports an API failure', async () => {
      graphqlRequest.mockRejectedValueOnce(new Error('delete failed'))

      await expect(run(['delete', 'sec-1'])).rejects.toThrow(ExitError)

      expect(printedErrors()).toContain('delete failed')
    })
  })

  it('show strips terminal control sequences from server fields', async () => {
    graphqlRequest.mockResolvedValueOnce({
      secret: {
        id: 'sec-1',
        name: 'app\x1b]0;pwned\x07',
        description: 'desc\x1b[2J',
        cloudAccountId: 'cloud-1',
        createdAt: '2026-01-01T00:00:00Z',
      },
    })

    await run(['show', 'sec-1'])

    const output = vi
      .mocked(console.log)
      .mock.calls.map((call) => String(call[0]))
      .join('\n')
    expect(output).toContain('Secret: app')
    expect(output).toContain('Description:   desc')
    expect(output).not.toContain('\x1b')
  })
})
