import type { Command } from 'commander'

import type {
  CreateDnsRecordMutation,
  CreateDnsRecordMutationVariables,
  DnsRecordSource,
  GetDnsDomainsQuery,
  GetDnsDomainsQueryVariables,
  GetDnsRecordsQuery,
  GetDnsRecordsQueryVariables,
  UpdateDnsRecordMutation,
  UpdateDnsRecordMutationVariables,
  VerifyDnsRecordMutation,
  VerifyDnsRecordMutationVariables,
} from '../generated/graphql'
import { formatApiError, graphqlRequest } from '../lib/client'
import { awsOption } from '../lib/clouds/aws'
import { cloudflareOption } from '../lib/clouds/cloudflare'
import { buildDnsRecordFields, type DnsRecordFlags } from '../lib/dns-record-input'
import { addExamples } from '../lib/examples'
import { createTable, printError, printSuccess } from '../lib/output'
import { sanitizeTerminal } from '../lib/sanitize'

const DOMAINS_QUERY = /* GraphQL */ `
  query GetDnsDomains {
    domains {
      id
      name
    }
  }
`

const DNS_RECORDS_QUERY = /* GraphQL */ `
  query GetDnsRecords($domainId: String!, $source: DnsRecordSource) {
    dnsRecords(domainId: $domainId, source: $source) {
      id
      recordType
      name
      value
      valueData
      provider
      providerData
      source
      verified
      syncStatus
      syncError
      conflict
    }
  }
`

const CREATE_DNS_RECORD_MUTATION = /* GraphQL */ `
  mutation CreateDnsRecord($input: CreateDnsRecordInput!) {
    createDnsRecord(input: $input) {
      success
      message
      record {
        id
      }
    }
  }
`

const UPDATE_DNS_RECORD_MUTATION = /* GraphQL */ `
  mutation UpdateDnsRecord($id: String!, $input: UpdateDnsRecordInput!) {
    updateDnsRecord(id: $id, input: $input) {
      success
      message
    }
  }
`

const VERIFY_DNS_RECORD_MUTATION = /* GraphQL */ `
  mutation VerifyDnsRecord($id: String!) {
    verifyDnsRecord(id: $id) {
      success
      message
    }
  }
`

const SOURCES: Record<string, DnsRecordSource> = {
  manual: 'MANUAL',
  route: 'ROUTE',
  certificate: 'CERTIFICATE',
}

type DnsRecord = GetDnsRecordsQuery['dnsRecords'][number]

async function requireDomainId(nameOrId: string): Promise<string> {
  const { domains } = await graphqlRequest<GetDnsDomainsQuery, GetDnsDomainsQueryVariables>(
    DOMAINS_QUERY
  )
  const wanted = nameOrId.toLowerCase()
  const domain = domains.find((d) => d.id === nameOrId) ?? domains.find((d) => d.name === wanted)
  if (!domain) {
    printError('Domain not found.')
    process.exit(1)
  }
  return domain.id
}

/** The value as a person reads it: an MX record's priority goes first. */
function shownValue(record: DnsRecord): string {
  const data = record.valueData ?? {}
  if (record.recordType === 'MX' && typeof data.priority === 'number') {
    return `${String(data.priority)} ${record.value}`
  }
  return record.value
}

function fail(message: string): never {
  printError(message)
  process.exit(1)
}

export function registerDnsCommand(program: Command): void {
  const dnsCmd = program
    .command('dns')
    .description('Manage DNS records on domains with managed DNS')
  const recordsCmd = dnsCmd.command('records').description("Manage a domain's DNS records")

  const listCmd = recordsCmd
    .command('list')
    .description('List the DNS records Gantry tracks for a domain, including its own')
    .argument('<domain>', 'Domain name or id')
    .option('--source <source>', 'Only records from manual, route or certificate')
    .option('--json', 'Print the records as JSON')
    .action(async (domain: string, options: { source?: string; json?: boolean }) => {
      try {
        const source = options.source === undefined ? undefined : SOURCES[options.source]
        if (options.source !== undefined && !source) {
          fail('--source must be manual, route or certificate.')
        }
        const domainId = await requireDomainId(domain)
        const { dnsRecords } = await graphqlRequest<
          GetDnsRecordsQuery,
          GetDnsRecordsQueryVariables
        >(DNS_RECORDS_QUERY, { domainId, ...(source ? { source } : {}) })
        if (options.json) {
          console.log(JSON.stringify(dnsRecords, null, 2))
          return
        }
        if (dnsRecords.length === 0) {
          console.log('No DNS records found.')
          return
        }
        const table = createTable({ head: ['ID', 'Type', 'Name', 'Value', 'Source', 'Status'] })
        for (const record of dnsRecords) {
          table.push([
            record.id,
            record.recordType,
            record.name,
            shownValue(record),
            record.source.toLowerCase(),
            record.syncStatus.toLowerCase(),
          ])
        }
        console.log(sanitizeTerminal(table.toString()))
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })

  const withRecordFlags = (command: Command): Command =>
    command
      .option('--priority <n>', 'MX and SRV records')
      .option('--weight <n>', 'SRV records')
      .option('--port <n>', 'SRV records')
      .option('--caa-flags <n>', 'CAA records, 0 to 255')
      .option('--caa-tag <tag>', 'CAA records: issue, issuewild or iodef')
      .addOption(awsOption('--aws-alias-zone <id>', 'Alias target: hosted zone id'))
      .addOption(awsOption('--aws-alias-target <dns>', 'Alias target: DNS name'))
      .addOption(awsOption('--aws-alias-evaluate-health', "Alias: follow the target's health"))
      .addOption(cloudflareOption('--cloudflare-proxied', 'Route traffic through the proxy'))

  const createCmd = withRecordFlags(
    recordsCmd
      .command('create')
      .description('Create a DNS record on a domain with managed DNS')
      .argument('<domain>', 'Domain name or id')
      .requiredOption('--type <type>', 'Record type, such as A, CNAME, MX or TXT')
      .requiredOption('--name <name>', 'Record name, such as www or the domain itself')
      .requiredOption('--value <value>', 'Record value')
  ).action(async (domain: string, options: DnsRecordFlags) => {
    try {
      const fields = buildDnsRecordFields(options)
      if (!fields.ok) fail(fields.message)
      const domainId = await requireDomainId(domain)
      const { recordType, name, value } = fields.input
      if (!recordType || !name || !value) fail('Pass --type, --name and --value.')
      const { createDnsRecord: result } = await graphqlRequest<
        CreateDnsRecordMutation,
        CreateDnsRecordMutationVariables
      >(CREATE_DNS_RECORD_MUTATION, {
        input: { ...fields.input, domainId, recordType, name, value },
      })
      if (!result.success)
        fail(result.message ?? 'There was an error while creating the DNS record.')
      printSuccess(result.message ?? 'DNS record created.')
      if (result.record) console.log(`  ID: ${sanitizeTerminal(result.record.id)}`)
    } catch (error) {
      printError(formatApiError(error))
      process.exit(1)
    }
  })

  const updateCmd = withRecordFlags(
    recordsCmd
      .command('update')
      .description("Change a DNS record you created. Records Gantry created can't be changed.")
      .argument('<record>', 'Record id, as "gantry dns records list" shows it')
      .option('--type <type>', 'Record type')
      .option('--name <name>', 'Record name')
      .option('--value <value>', 'Record value')
  )
    .addOption(
      cloudflareOption('--cloudflare-no-proxied', 'Stop routing traffic through the proxy')
    )
    .action(async (record: string, options: DnsRecordFlags) => {
      try {
        const fields = buildDnsRecordFields(options)
        if (!fields.ok) fail(fields.message)
        if (Object.keys(fields.input).length === 0) {
          fail('Nothing to change. Pass at least one setting.')
        }
        const { updateDnsRecord: result } = await graphqlRequest<
          UpdateDnsRecordMutation,
          UpdateDnsRecordMutationVariables
        >(UPDATE_DNS_RECORD_MUTATION, { id: record, input: fields.input })
        if (!result.success)
          fail(result.message ?? 'There was an error while updating the DNS record.')
        printSuccess(result.message ?? 'DNS record updated.')
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })

  const verifyCmd = recordsCmd
    .command('verify')
    .description('Check a DNS record again, pushing it to the DNS provider first on managed DNS')
    .argument('<record>', 'Record id')
    .action(async (record: string) => {
      try {
        const { verifyDnsRecord: result } = await graphqlRequest<
          VerifyDnsRecordMutation,
          VerifyDnsRecordMutationVariables
        >(VERIFY_DNS_RECORD_MUTATION, { id: record })
        if (!result.success)
          fail(result.message ?? 'There was an error while checking the DNS record.')
        printSuccess(result.message ?? 'Checking the DNS record again.')
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })

  addExamples(dnsCmd, [
    { command: 'gantry dns records list acme.com', description: "List a domain's DNS records" },
  ])
  addExamples(recordsCmd, [
    { command: 'gantry dns records list acme.com', description: "List a domain's DNS records" },
    {
      command:
        'gantry dns records create acme.com --type TXT --name _github-challenge --value 8f2c91ab4e',
      description: 'Add a verification record',
    },
  ])
  addExamples(listCmd, [
    {
      command: 'gantry dns records list acme.com --source manual',
      description: 'List only the records you created',
    },
  ])
  addExamples(createCmd, [
    {
      command:
        'gantry dns records create acme.com --type MX --name acme.com --value mail.acme.com --priority 10',
      description: 'Add a mail server',
    },
    {
      command:
        'gantry dns records create acme.com --type A --name status --value 203.0.113.24 --cloudflare-proxied',
      description: 'On Cloudflare, add a proxied record',
    },
  ])
  addExamples(updateCmd, [
    {
      command: 'gantry dns records update Re3mQx7T --value mx2.acme.com',
      description: 'Point a record somewhere else',
    },
  ])
  addExamples(verifyCmd, [
    { command: 'gantry dns records verify Re3mQx7T', description: 'Check a record again' },
  ])
}
