import { confirm, select } from '@inquirer/prompts'
import type { Command } from 'commander'

import type {
  AwsFirewallSettingsInput,
  CloudProviderEnum,
  CreateFirewallMutation,
  CreateFirewallMutationVariables,
  DeleteFirewallMutation,
  DeleteFirewallMutationVariables,
  FirewallPlacementStatus,
  GetFirewallsQuery,
  GetFirewallsQueryVariables,
  UpdateFirewallMutation,
  UpdateFirewallMutationVariables,
} from '../generated/graphql'
import { formatApiError, graphqlRequest } from '../lib/client'
import {
  CLOUD_PROVIDER_LABELS,
  foreignAwsFlagsMessage,
  isAws,
  toCloudProvider,
} from '../lib/clouds'
import {
  AWS_FIREWALL_GROUP_LIST,
  AWS_FIREWALL_PRESET_LIST,
  awsFirewallCreateSettings,
  awsFirewallRuleLines,
  awsOption,
  buildAwsFirewallSettings,
} from '../lib/clouds/aws'
import type { AwsFirewallFlags } from '../lib/clouds/aws'
import { addExamples } from '../lib/examples'
import { promptName } from '../lib/interactive-prompts'
import { createTable, printError, printHeading, printSuccess } from '../lib/output'
import { sanitizeTerminal } from '../lib/sanitize'
import { isInteractive } from '../lib/terminal'

type Firewall = GetFirewallsQuery['firewalls'][number]

const FIREWALLS_QUERY = /* GraphQL */ `
  query GetFirewalls {
    firewalls {
      id
      name
      slug
      provider
      rules
      placements {
        id
        cloudAccountId
        status
      }
      uses {
        hostname
        projectId
        projectName
      }
    }
  }
`

const CREATE_FIREWALL_MUTATION = /* GraphQL */ `
  mutation CreateFirewall($input: CreateFirewallInput!) {
    createFirewall(input: $input) {
      success
      message
      firewall {
        id
        name
        slug
      }
    }
  }
`

const UPDATE_FIREWALL_MUTATION = /* GraphQL */ `
  mutation UpdateFirewall($input: UpdateFirewallInput!) {
    updateFirewall(input: $input) {
      success
      message
      firewall {
        id
        name
        slug
        placements {
          status
        }
      }
    }
  }
`

const DELETE_FIREWALL_MUTATION = /* GraphQL */ `
  mutation DeleteFirewall($id: String!) {
    deleteFirewall(id: $id) {
      success
      message
    }
  }
`

const AWS_GROUPS_FLAG_HELP = `Managed rule groups to turn on, comma-separated (${AWS_FIREWALL_GROUP_LIST})`
const AWS_PRESET_FLAG_HELP = `Turn on a preset's managed rule groups (${AWS_FIREWALL_PRESET_LIST}); combines with --aws-managed-groups`

async function findFirewall(slugOrId: string): Promise<Firewall> {
  const { firewalls } = await graphqlRequest<GetFirewallsQuery, GetFirewallsQueryVariables>(
    FIREWALLS_QUERY
  )
  const firewall =
    firewalls.find((f) => f.id === slugOrId) ?? firewalls.find((f) => f.slug === slugOrId)
  if (!firewall) {
    printError('Firewall not found.')
    process.exit(1)
  }
  return firewall
}

function isDeployed(placement: { status: FirewallPlacementStatus }): boolean {
  return placement.status !== 'RELEASED'
}

function ruleLines(firewall: Firewall): string[] {
  if (isAws(firewall.provider)) return awsFirewallRuleLines(firewall.rules)
  return JSON.stringify(firewall.rules, null, 2).split('\n')
}

async function confirmDelete(slug: string, yes: boolean): Promise<boolean> {
  if (yes) return true
  if (!isInteractive()) {
    printError(`Deleting firewall "${slug}" is permanent. Re-run with --yes to confirm.`)
    process.exit(1)
  }
  return confirm({ message: `Delete firewall "${slug}"?`, default: false })
}

export function registerFirewallsCommand(program: Command): void {
  const firewallsCmd = program.command('firewalls').description('Manage firewalls')

  const listCmd = firewallsCmd
    .command('list')
    .description('List all firewalls')
    .action(async () => {
      try {
        const { firewalls } = await graphqlRequest<GetFirewallsQuery, GetFirewallsQueryVariables>(
          FIREWALLS_QUERY
        )

        if (firewalls.length === 0) {
          console.log('No firewalls found.')
          return
        }

        const table = createTable({
          head: ['Slug', 'Name', 'Provider', 'Hostnames', 'Cloud accounts'],
        })
        for (const firewall of firewalls) {
          const hostnames = [...new Set(firewall.uses.map((u) => u.hostname))]
          const accounts = firewall.placements.filter(isDeployed).map((p) => p.cloudAccountId)
          table.push([
            firewall.slug,
            firewall.name,
            firewall.provider.toUpperCase(),
            hostnames.length > 0 ? hostnames.join(', ') : '-',
            accounts.length > 0 ? accounts.join(', ') : '-',
          ])
        }
        console.log(table.toString())
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })

  const showCmd = firewallsCmd
    .command('show')
    .argument('<slugOrId>', 'Firewall slug or ID')
    .description('Show a firewall, the hostnames behind it and where it is deployed')
    .action(async (slugOrId: string) => {
      try {
        const firewall = await findFirewall(slugOrId)

        console.log(`\nFirewall: ${sanitizeTerminal(firewall.name)}`)
        console.log(`  ID:       ${sanitizeTerminal(firewall.id)}`)
        console.log(`  Slug:     ${sanitizeTerminal(firewall.slug)}`)
        console.log(`  Provider: ${firewall.provider.toUpperCase()}`)

        printHeading('Rules')
        for (const line of ruleLines(firewall)) console.log(`  ${sanitizeTerminal(line)}`)

        printHeading('Used by')
        if (firewall.uses.length === 0) {
          console.log('  No live version routes through this firewall.')
        } else {
          const table = createTable({ head: ['Hostname', 'Project'] })
          for (const use of firewall.uses) table.push([use.hostname, use.projectName])
          console.log(table.toString())
        }

        printHeading('Deployments')
        if (firewall.placements.length === 0) {
          console.log(
            '  Not deployed yet. It deploys to a cloud account when a route there first uses it.'
          )
        } else {
          const table = createTable({ head: ['Cloud account', 'Status'] })
          for (const placement of firewall.placements) {
            table.push([placement.cloudAccountId, placement.status])
          }
          console.log(table.toString())
        }
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })

  const createCmd = firewallsCmd
    .command('create')
    .argument('<slug>', 'Slug that gantry.yml routes use to name the firewall')
    .description('Create a firewall')
    .option('--name <name>', 'Firewall name')
    .option(
      '--provider <provider>',
      `Cloud the rules are written for (${Object.keys(CLOUD_PROVIDER_LABELS)
        .map((p) => p.toLowerCase())
        .join(', ')})`
    )
    .addOption(awsOption('--aws-managed-groups <groups>', AWS_GROUPS_FLAG_HELP))
    .addOption(awsOption('--aws-preset <preset>', AWS_PRESET_FLAG_HELP))
    .action(
      async (slug: string, options: { name?: string; provider?: string } & AwsFirewallFlags) => {
        try {
          const provider = options.provider
            ? toCloudProvider(options.provider)
            : await select<CloudProviderEnum>({
                message: 'Cloud the rules are written for:',
                choices: Object.entries(CLOUD_PROVIDER_LABELS).map(([value, name]) => ({
                  name,
                  value: toCloudProvider(value),
                })),
              })
          const foreign = foreignAwsFlagsMessage(provider, options)
          if (foreign) {
            printError(foreign)
            process.exit(1)
          }

          const name = options.name ?? (await promptName('Firewall'))

          let aws: AwsFirewallSettingsInput | undefined
          if (isAws(provider)) {
            const settings = await awsFirewallCreateSettings(options)
            if (!settings.ok) {
              printError(settings.message)
              process.exit(1)
            }
            aws = settings.value
          }

          const { createFirewall: result } = await graphqlRequest<
            CreateFirewallMutation,
            CreateFirewallMutationVariables
          >(CREATE_FIREWALL_MUTATION, {
            input: { name, slug, provider, ...(aws ? { aws } : {}) },
          })
          const firewall = result.firewall
          if (!result.success || !firewall) {
            printError(result.message ?? 'There was an error while creating the firewall.')
            process.exit(1)
          }

          printSuccess(`Firewall created: ${firewall.name} (${firewall.slug})`)
          console.log(`  ID: ${sanitizeTerminal(firewall.id)}`)
          console.log(
            '  It deploys to a cloud account when a route there first puts it in front of a hostname.'
          )
        } catch (error) {
          printError(formatApiError(error))
          process.exit(1)
        }
      }
    )

  const updateCmd = firewallsCmd
    .command('update')
    .argument('<slugOrId>', 'Firewall slug or ID')
    .description('Rename a firewall or replace its rules')
    .option('--name <name>', 'New firewall name')
    .addOption(
      awsOption(
        '--aws-managed-groups <groups>',
        `${AWS_GROUPS_FLAG_HELP}; replaces the current groups`
      )
    )
    .addOption(awsOption('--aws-preset <preset>', AWS_PRESET_FLAG_HELP))
    .action(async (slugOrId: string, options: { name?: string } & AwsFirewallFlags) => {
      try {
        const current = await findFirewall(slugOrId)
        const foreign = foreignAwsFlagsMessage(current.provider, options)
        if (foreign) {
          printError(foreign)
          process.exit(1)
        }

        const aws = buildAwsFirewallSettings(options)
        if (!aws.ok) {
          printError(aws.message)
          process.exit(1)
        }
        if (options.name === undefined && !aws.value) {
          printError('Nothing to update. Pass --name or new rules.')
          process.exit(1)
        }

        const { updateFirewall: result } = await graphqlRequest<
          UpdateFirewallMutation,
          UpdateFirewallMutationVariables
        >(UPDATE_FIREWALL_MUTATION, {
          input: {
            id: current.id,
            ...(options.name !== undefined ? { name: options.name } : {}),
            ...(aws.value ? { aws: aws.value } : {}),
          },
        })
        const firewall = result.firewall
        if (!result.success || !firewall) {
          printError(result.message ?? 'There was an error while updating the firewall.')
          process.exit(1)
        }

        printSuccess(`Firewall updated: ${firewall.name} (${firewall.slug})`)
        if (aws.value) {
          const accounts = firewall.placements.filter(isDeployed).length
          console.log(
            accounts === 0
              ? '  The new rules apply when the firewall first deploys to a cloud account.'
              : `  The new rules roll out to every cloud account the firewall is deployed in (${String(accounts)}).`
          )
        }
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })

  const deleteCmd = firewallsCmd
    .command('delete')
    .argument('<slugOrId>', 'Firewall slug or ID')
    .description('Delete a firewall no live version routes through')
    .option('-y, --yes', 'Skip the confirmation prompt')
    .action(async (slugOrId: string, options: { yes?: boolean }) => {
      try {
        const firewall = await findFirewall(slugOrId)
        if (!(await confirmDelete(firewall.slug, options.yes ?? false))) return

        const { deleteFirewall: result } = await graphqlRequest<
          DeleteFirewallMutation,
          DeleteFirewallMutationVariables
        >(DELETE_FIREWALL_MUTATION, { id: firewall.id })
        if (!result.success) {
          printError(result.message ?? 'There was an error while deleting the firewall.')
          process.exit(1)
        }

        printSuccess(`Firewall deleted: ${firewall.slug}`)
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })

  addExamples(firewallsCmd, [
    { command: 'gantry firewalls list', description: "List the team's firewalls" },
    {
      command:
        'gantry firewalls create edge-waf --name "Edge WAF" --provider aws --aws-preset wordpress',
      description: 'Create a firewall with the WordPress rules',
    },
  ])
  addExamples(listCmd, [
    { command: 'gantry firewalls list', description: "List the team's firewalls" },
  ])
  addExamples(showCmd, [
    {
      command: 'gantry firewalls show edge-waf',
      description: 'Show its rules, the hostnames behind it and where it is deployed',
    },
  ])
  addExamples(createCmd, [
    {
      command:
        'gantry firewalls create edge-waf --name "Edge WAF" --provider aws --aws-managed-groups common,php,wordpress',
      description: 'Create a firewall with chosen managed rule groups',
    },
    {
      command:
        'gantry firewalls create shop-waf --name "Shop WAF" --provider aws --aws-preset wordpress --aws-managed-groups linux',
      description: 'Start from the WordPress preset and add a group',
    },
  ])
  addExamples(updateCmd, [
    {
      command: 'gantry firewalls update edge-waf --aws-managed-groups ip-reputation,common,sql',
      description: 'Replace the managed rule groups',
    },
    {
      command: 'gantry firewalls update edge-waf --name "Edge firewall"',
      description: 'Rename a firewall',
    },
  ])
  addExamples(deleteCmd, [
    { command: 'gantry firewalls delete edge-waf', description: 'Delete a firewall' },
    {
      command: 'gantry firewalls delete edge-waf --yes',
      description: 'Delete it without the prompt, such as in CI',
    },
  ])
}
