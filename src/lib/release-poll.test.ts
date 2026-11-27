import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const graphqlRequest = vi.hoisted(() => vi.fn())
vi.mock('./client', () => ({ graphqlRequest }))

const { RELEASE_OUTPUT_QUERY } = await import('./release-output')
const { ReleaseOutcomeError, waitForRelease } = await import('./release-poll')

const DEPLOYMENT_ID = 'dep_7Hq2'
const VERSION_ID = 'ver_8kQ2'

function deployment(status: string, postDeployStatus?: string, lastMessage?: string) {
  return {
    deployment: {
      id: DEPLOYMENT_ID,
      status,
      lastMessage: lastMessage ?? null,
      versionId: VERSION_ID,
      steps: postDeployStatus ? [{ stepType: 'post-deploy', status: postDeployStatus }] : [],
    },
  }
}

function output(lines: [string, string][], cursor: string) {
  return {
    releaseOutput: {
      lines: lines.map(([deploymentId, message]) => ({ deploymentId, message })),
      cursor,
    },
  }
}

/** Answers each deployment poll in turn, and each output read from `pages`. */
function respond(polls: unknown[], pages: unknown[]) {
  graphqlRequest.mockImplementation((query: string) => {
    if (query === RELEASE_OUTPUT_QUERY) return Promise.resolve(pages.shift() ?? output([], 'c9'))
    return Promise.resolve(polls.shift())
  })
}

async function wait() {
  const lines: string[] = []
  const titles: string[] = []
  const run = waitForRelease(
    DEPLOYMENT_ID,
    (title) => titles.push(title),
    (line) => lines.push(line)
  )
  const settled = run.then(
    () => undefined,
    (error: unknown) => error
  )
  await vi.runAllTimersAsync()
  return { error: await settled, lines, titles }
}

describe('waitForRelease', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    graphqlRequest.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("prints the post-deploy output of the cutover's own deployment, then reports it applied", async () => {
    respond(
      [
        deployment('RUNNING', 'PROCESSING', 'Running post-deploy commands'),
        deployment('COMPLETE', 'COMPLETE', 'Post-deploy commands finished'),
      ],
      [
        output(
          [
            [DEPLOYMENT_ID, 'Warming the route cache.'],
            ['dep_6Gp1', 'Running migrations.'],
          ],
          'c1'
        ),
        output([[DEPLOYMENT_ID, 'Cache warmed.']], 'c2'),
      ]
    )

    const { error, lines, titles } = await wait()

    expect(error).toBeUndefined()
    expect(lines).toEqual(['Warming the route cache.', 'Cache warmed.'])
    expect(titles.at(-1)).toBe('Applied: Post-deploy commands finished')
  })

  it('names a post-deploy failure and says the version is live', async () => {
    respond([deployment('FAILED', 'FAILED', 'php artisan cache:warm exited with 1')], [])

    const { error } = await wait()

    expect(error).toBeInstanceOf(ReleaseOutcomeError)
    expect((error as Error).message).toBe(
      'Post-deploy commands failed, and the new version is live: php artisan cache:warm exited with 1'
    )
  })

  it('reports a failure without post-deploy commands as failed', async () => {
    respond([deployment('FAILED', undefined, 'There was an error while applying the release.')], [])

    const { error } = await wait()

    expect((error as Error).message).toBe('Failed: There was an error while applying the release.')
    expect(graphqlRequest).not.toHaveBeenCalledWith(
      RELEASE_OUTPUT_QUERY,
      expect.anything(),
      expect.anything()
    )
  })
})
