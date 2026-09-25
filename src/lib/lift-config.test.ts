import { describe, expect, it } from 'vitest'

import { readLiftConfig } from './lift-config'

describe('readLiftConfig', () => {
  it('reads environments and a full setup block', () => {
    const config = readLiftConfig({
      type: 'project',
      environments: { production: {} },
      setup: {
        commands: ['npm ci', 'npm run build'],
        working_dir: 'app',
        use_gitignore: false,
        builds: {
          api: {
            dockerfile: 'Dockerfile',
            working_dir: 'svc',
            args: { NODE_ENV: 'production' },
            docker_target: 'prod',
            depends_on: 'base',
          },
        },
      },
    })

    expect(config).toEqual({
      environments: { production: {} },
      setup: {
        commands: ['npm ci', 'npm run build'],
        working_dir: 'app',
        use_gitignore: false,
        builds: {
          api: {
            dockerfile: 'Dockerfile',
            working_dir: 'svc',
            args: { NODE_ENV: 'production' },
            docker_target: 'prod',
            depends_on: 'base',
          },
        },
      },
    })
  })

  it('accepts a config with no setup block', () => {
    expect(readLiftConfig({ environments: { staging: {} } })).toEqual({
      environments: { staging: {} },
      setup: undefined,
    })
  })

  it.each([
    ['environments', { environments: [] }],
    ['setup', { environments: {}, setup: 'npm run build' }],
    ['setup.commands', { environments: {}, setup: { commands: [1] } }],
    ['setup.working_dir', { environments: {}, setup: { working_dir: 3 } }],
    ['setup.use_gitignore', { environments: {}, setup: { use_gitignore: 'yes' } }],
    ['setup.builds', { environments: {}, setup: { builds: [] } }],
    ['setup.builds.api', { environments: {}, setup: { builds: { api: { args: {} } } } }],
    [
      'setup.builds.api.args.PORT',
      { environments: {}, setup: { builds: { api: { dockerfile: 'D', args: { PORT: 80 } } } } },
    ],
  ])('names the invalid field "%s"', (path, config) => {
    expect(() => readLiftConfig(config)).toThrow(
      `The resolved project config has an invalid "${path}".`
    )
  })
})
