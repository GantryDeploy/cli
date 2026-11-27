import { readFileSync } from 'fs'

import { confirm, select } from '@inquirer/prompts'
import type { Command } from 'commander'

import type {
  CloudProviderEnum,
  CreateFirewallMutation,
  CreateFirewallMutationVariables,
  DeleteFirewallMutation,
  DeleteFirewallMutationVariables,
  FirewallPlacementStatus,
  GetFirewallsQuery,
  GetFirewallsQueryVariables,
  SetFirewallRulesMutation,
  SetFirewallRulesMutationVariables,
  UpdateFirewallMutation,
  UpdateFirewallMutationVariables,
} from '../generated/graphql'
import { formatApiError, graphqlRequest } from '../lib/client'
import { CLOUD_PROVIDER_LABELS, invalidConfiguration, isAws, toCloudProvider } from '../lib/clouds'
import {
  awsFirewallRuleRows,
  awsFirewallStoredRules,
  parseAwsFirewallRules,
} from '../lib/clouds/aws'
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
      }
    }
  }
`

const SET_FIREWALL_RULES_MUTATION = /* GraphQL */ `
  mutation SetFirewallRules($input: SetFirewallRulesInput!) {
    setFirewallRules(input: $input) {
      success
      message
      firewall {
        id
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

function printRules(firewall: Firewall): void {
  if (!isAws(firewall.provider)) {
    for (const line of JSON.stringify(firewall.rules, null, 2).split('\n')) {
      console.log(`  ${sanitizeTerminal(line)}`)
    }
    return
  }
  const rows = awsFirewallRuleRows(firewall.rules)
  if (rows.length === 0) {
    console.log('  No rules. The firewall lets every request through.')
    return
  }
  const table = createTable({ head: ['#', 'Name', 'Kind', 'Enabled', 'Summary'] })
  rows.forEach((row, index) => {
    table.push([
      String(index + 1),
      sanitizeTerminal(row.name),
      row.kind,
      row.enabled ? 'yes' : 'no',
      sanitizeTerminal(row.summary),
    ])
  })
  console.log(table.toString())
}

function storedRules(firewall: Firewall): unknown {
  return isAws(firewall.provider) ? awsFirewallStoredRules(firewall.rules) : firewall.rules
}

function readRulesFile(path: string): unknown {
  let content: string
  try {
    content = readFileSync(path, 'utf-8')
  } catch {
    printError(`There was an error while reading ${path}.`)
    process.exit(1)
  }
  try {
    return JSON.parse(content)
  } catch {
    printError(`${path} is not valid JSON.`)
    process.exit(1)
  }
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
        printRules(firewall)

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
    .description('Create a firewall with no rules. Add them with "gantry firewalls rules set".')
    .option('--name <name>', 'Firewall name')
    .option(
      '--provider <provider>',
      `Cloud the rules are written for (${Object.keys(CLOUD_PROVIDER_LABELS)
        .map((p) => p.toLowerCase())
        .join(', ')})`
    )
    .action(async (slug: string, options: { name?: string; provider?: string }) => {
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
        const name = options.name ?? (await promptName('Firewall'))

        const { createFirewall: result } = await graphqlRequest<
          CreateFirewallMutation,
          CreateFirewallMutationVariables
        >(CREATE_FIREWALL_MUTATION, { input: { name, slug, provider } })
        const firewall = result.firewall
        if (!result.success || !firewall) {
          printError(result.message ?? 'There was an error while creating the firewall.')
          process.exit(1)
        }

        printSuccess(`Firewall created: ${firewall.name} (${firewall.slug})`)
        console.log(`  ID: ${sanitizeTerminal(firewall.id)}`)
        console.log(
          `  It has no rules yet. Add them with "gantry firewalls rules set ${sanitizeTerminal(firewall.slug)} --file rules.json".`
        )
        console.log(
          '  It deploys to a cloud account when a route there first puts it in front of a hostname.'
        )
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })

  const updateCmd = firewallsCmd
    .command('update')
    .argument('<slugOrId>', 'Firewall slug or ID')
    .description('Rename a firewall. Change its rules with "gantry firewalls rules set".')
    .requiredOption('--name <name>', 'New firewall name')
    .action(async (slugOrId: string, options: { name: string }) => {
      try {
        const current = await findFirewall(slugOrId)

        const { updateFirewall: result } = await graphqlRequest<
          UpdateFirewallMutation,
          UpdateFirewallMutationVariables
        >(UPDATE_FIREWALL_MUTATION, { input: { id: current.id, name: options.name } })
        const firewall = result.firewall
        if (!result.success || !firewall) {
          printError(result.message ?? 'There was an error while updating the firewall.')
          process.exit(1)
        }

        printSuccess(`Firewall renamed: ${firewall.name} (${firewall.slug})`)
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })

  const rulesCmd = firewallsCmd
    .command('rules')
    .argument('<slugOrId>', 'Firewall slug or ID')
    .description(
      'List a firewall\'s rules in the order they are evaluated. To edit them, save "rules --json" to a file, change it, then pass it to "rules set --file".'
    )
    .option('--json', 'Print the rule list as JSON, in the shape "rules set" reads')
    .action(async (slugOrId: string, options: { json?: boolean }) => {
      try {
        const firewall = await findFirewall(slugOrId)
        if (options.json) {
          console.log(JSON.stringify(storedRules(firewall), null, 2))
          return
        }
        console.log(`\nRules of ${sanitizeTerminal(firewall.slug)}, in evaluation order:`)
        printRules(firewall)
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })

  const rulesSetCmd = rulesCmd
    .command('set')
    .argument('<slugOrId>', 'Firewall slug or ID')
    .description(
      'Replace a firewall\'s rules with the JSON list in a file. Keep a rule\'s "id" to update it; leave it out for a new rule.'
    )
    .requiredOption('--file <path>', 'JSON file with the rule list, as "rules --json" prints it')
    .action(async (slugOrId: string, options: { file: string }) => {
      try {
        const current = await findFirewall(slugOrId)
        if (!isAws(current.provider)) {
          printError(invalidConfiguration('firewall'))
          process.exit(1)
        }

        const rules = parseAwsFirewallRules(readRulesFile(options.file))
        if (!rules.ok) {
          printError(`${options.file} is not a valid rules file. ${rules.message}`)
          process.exit(1)
        }

        const { setFirewallRules: result } = await graphqlRequest<
          SetFirewallRulesMutation,
          SetFirewallRulesMutationVariables
        >(SET_FIREWALL_RULES_MUTATION, {
          input: { id: current.id, aws: { rules: rules.value } },
        })
        const firewall = result.firewall
        if (!result.success || !firewall) {
          printError(result.message ?? 'There was an error while updating the firewall.')
          process.exit(1)
        }

        printSuccess(
          `Firewall rules replaced: ${firewall.slug} (${String(rules.value.length)} rule${rules.value.length === 1 ? '' : 's'})`
        )
        console.log(
          firewall.placements.some(isDeployed)
            ? '  The new rules roll out to every cloud account the firewall is deployed in.'
            : '  The new rules apply when the firewall first deploys to a cloud account.'
        )
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

  const editLoop = [
    {
      command: 'gantry firewalls rules edge-waf --json > rules.json',
      description: 'Save the rules to a file to edit them',
    },
    {
      command: 'gantry firewalls rules set edge-waf --file rules.json',
      description: 'Replace the rules with the edited file',
    },
  ]

  addExamples(firewallsCmd, [
    { command: 'gantry firewalls list', description: "List the team's firewalls" },
    {
      command: 'gantry firewalls create edge-waf --name "Edge WAF" --provider aws',
      description: 'Create a firewall with no rules',
    },
    ...editLoop,
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
      command: 'gantry firewalls create edge-waf --name "Edge WAF" --provider aws',
      description: 'Create a firewall with no rules',
    },
  ])
  addExamples(updateCmd, [
    {
      command: 'gantry firewalls update edge-waf --name "Edge firewall"',
      description: 'Rename a firewall',
    },
  ])
  addExamples(rulesCmd, [
    { command: 'gantry firewalls rules edge-waf', description: 'List the rules in order' },
    ...editLoop,
  ])
  addExamples(rulesSetCmd, editLoop)
  addExamples(deleteCmd, [
    { command: 'gantry firewalls delete edge-waf', description: 'Delete a firewall' },
    {
      command: 'gantry firewalls delete edge-waf --yes',
      description: 'Delete it without the prompt, such as in CI',
    },
  ])
}
