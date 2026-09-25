import * as path from 'path'
import * as readline from 'readline'

import chalk from 'chalk'
import type { Command } from 'commander'
import ora from 'ora'

import type {
  StartTeardownMutation,
  StartTeardownMutationVariables,
  TeardownPreviewQuery,
  TeardownPreviewQueryVariables,
} from '../generated/graphql'
import { formatApiError, graphqlRequest } from '../lib/client'
import { printError } from '../lib/output'
import { loadProjectIdentity, resolveEnvironmentSlug } from '../lib/project-identity'
import { sanitizeTerminal } from '../lib/sanitize'

// Must match the phrases the API accepts.
const CONFIRMATION_PHRASES = [
  'I understand this is permanent',
  'goodbye infrastructure',
  'yeet my servers',
  'I have backups... right?',
  'delete everything forever',
  'hasta la vista servers',
]

interface TeardownOptions {
  cwd?: string
}

const TEARDOWN_PREVIEW_QUERY = /* GraphQL */ `
  query TeardownPreview($projectId: String!, $environmentSlug: String!) {
    teardownPreview(projectId: $projectId, environmentSlug: $environmentSlug) {
      environmentId
      environmentName
      resources {
        id
        resourceType
        resourceId
        status
      }
      totalResources
      teardownToken
      expiresAt
    }
  }
`

const START_TEARDOWN_MUTATION = /* GraphQL */ `
  mutation StartTeardown($input: StartTeardownInput!) {
    startTeardown(input: $input) {
      success
      message
      teardownId
    }
  }
`

function formatResourceType(resourceType: string): string {
  const nameMap: Record<string, string> = {
    's3-bucket': 'S3 Bucket',
    's3-bucket-policy': 'S3 Bucket Policy',
    's3-public-policy': 'S3 Public Policy',
    'cloudfront-distribution': 'CloudFront Distribution',
    'cloudfront-oac': 'CloudFront OAC',
    'acm-certificate': 'ACM Certificate',
  }

  return (
    nameMap[resourceType] ||
    resourceType
      .split('-')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ')
  )
}

/** Resolves with the typed phrase, or null once the teardown token expires. */
async function promptForPhraseWithTimeout(phrase: string, expiresAt: Date): Promise<string | null> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  return new Promise((resolve) => {
    const timeUntilExpiry = expiresAt.getTime() - Date.now()
    const minutesLeft = Math.ceil(timeUntilExpiry / 60000)

    const expiryTimeout = setTimeout(() => {
      rl.close()
      console.log('')
      console.log(chalk.red('⏰ Confirmation timeout. The teardown session has expired.'))
      console.log(chalk.gray('Run the command again to start a new session.'))
      resolve(null)
    }, timeUntilExpiry)

    console.log(chalk.gray(`  You have ${String(minutesLeft)} minute(s) to confirm.`))
    console.log('')

    console.log(chalk.magentaBright(`Once confirmed this action cannot be cancelled or stopped.`))
    console.log('')
    rl.question(
      chalk.yellow(`If you are absolutely sure, type "${phrase}" to confirm: `),
      (answer) => {
        clearTimeout(expiryTimeout)
        rl.close()
        resolve(answer)
      }
    )
  })
}

export function registerTeardownCommand(program: Command): void {
  program
    .command('teardown')
    .description('Tear down all infrastructure for an environment')
    .argument('<environment>', 'Environment name to tear down (e.g., "staging")')
    .option('--cwd <path>', 'Working directory containing gantry.yml')
    .action(async (environment: string, options: TeardownOptions) => {
      const workingDir = options.cwd ? path.resolve(options.cwd) : process.cwd()

      const identity = loadProjectIdentity(workingDir)
      const envSlug = resolveEnvironmentSlug(identity, environment)
      const projectId = identity.id

      const spinner = ora('Fetching infrastructure details...').start()

      let preview: TeardownPreviewQuery['teardownPreview']
      try {
        const result = await graphqlRequest<TeardownPreviewQuery, TeardownPreviewQueryVariables>(
          TEARDOWN_PREVIEW_QUERY,
          { projectId, environmentSlug: envSlug }
        )
        preview = result.teardownPreview
        spinner.stop()
      } catch (error) {
        spinner.fail('Failed to fetch infrastructure details')
        printError(formatApiError(error))
        process.exit(1)
      }

      if (preview.totalResources === 0) {
        console.log(chalk.yellow('\nNo infrastructure found for this environment.'))
        process.exit(0)
      }

      console.log('')
      console.log(chalk.red.bold('⚠️  WARNING: This will permanently destroy all infrastructure!'))
      console.log('')
      console.log(chalk.white.bold('  Environment:'), sanitizeTerminal(preview.environmentName))
      console.log('')
      console.log(chalk.white.bold('  Resources to be destroyed:'))

      for (const resource of preview.resources) {
        // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty resourceId should fall back to the resource id
        const resourceName = resource.resourceId || resource.id
        console.log(
          chalk.red(
            `    - ${sanitizeTerminal(formatResourceType(resource.resourceType))}: ${sanitizeTerminal(resourceName)}`
          )
        )
      }

      console.log('')
      console.log(chalk.gray(`  Total: ${String(preview.totalResources)} resource(s)`))
      console.log('')

      const expiresAt = new Date(preview.expiresAt)

      const phraseIndex = Math.floor(Math.random() * CONFIRMATION_PHRASES.length)
      const selectedPhrase = CONFIRMATION_PHRASES[phraseIndex]

      const typedPhrase = await promptForPhraseWithTimeout(selectedPhrase, expiresAt)

      if (typedPhrase === null) {
        process.exit(1)
      }

      if (typedPhrase.toLowerCase().trim() !== selectedPhrase.toLowerCase().trim()) {
        console.log(chalk.yellow('\nConfirmation phrase did not match. Teardown cancelled.'))
        process.exit(0)
      }

      console.log('')
      const teardownSpinner = ora('Starting teardown...').start()

      try {
        const result = await graphqlRequest<StartTeardownMutation, StartTeardownMutationVariables>(
          START_TEARDOWN_MUTATION,
          {
            input: {
              projectId,
              environmentSlug: envSlug,
              teardownToken: preview.teardownToken,
              confirmationPhrase: selectedPhrase,
            },
          }
        )

        if (!result.startTeardown.success) {
          // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- an empty message should fall back to the default failure text
          teardownSpinner.fail(result.startTeardown.message || 'Teardown failed')
          process.exit(1)
        }

        teardownSpinner.succeed('Teardown started successfully')
        console.log('')
        console.log(chalk.gray('  Infrastructure is being destroyed in the background.'))
        console.log(chalk.gray('  Check the Gantry console for progress.'))
        console.log('')
      } catch (error) {
        teardownSpinner.fail('Failed to start teardown')
        printError(formatApiError(error))
        process.exit(1)
      }
    })
}
