import type { Command } from 'commander'

import type {
  GetCertificatesQuery,
  GetCertificatesQueryVariables,
  TriggerCertificateValidationMutation,
  TriggerCertificateValidationMutationVariables,
} from '../generated/graphql'
import { formatApiError, graphqlRequest } from '../lib/client'
import { addExamples } from '../lib/examples'
import { createTable, printError, printSuccess } from '../lib/output'
import { sanitizeTerminal } from '../lib/sanitize'

type Certificate = GetCertificatesQuery['certificates'][number]

const CERTIFICATES_QUERY = /* GraphQL */ `
  query GetCertificates($cloudAccountId: String, $domainId: String) {
    certificates(cloudAccountId: $cloudAccountId, domainId: $domainId) {
      id
      primaryDomain
      additionalDomains
      status
      lastCheckedAt
      regionalCertificates {
        region
        status
        lastValidatedAt
        validationAttempts
        dnsRecords {
          name
          type
          value
        }
      }
    }
  }
`

const TRIGGER_VALIDATION_MUTATION = /* GraphQL */ `
  mutation TriggerCertificateValidation($id: String!, $region: String) {
    triggerCertificateValidation(id: $id, region: $region) {
      success
      message
    }
  }
`

const WAITING = new Set(['PENDING', 'VALIDATING', 'FAILED'])

async function fetchCertificates(
  variables: GetCertificatesQueryVariables = {}
): Promise<Certificate[]> {
  const { certificates } = await graphqlRequest<
    GetCertificatesQuery,
    GetCertificatesQueryVariables
  >(CERTIFICATES_QUERY, variables)
  return certificates
}

async function requireCertificate(id: string): Promise<Certificate> {
  const certificate = (await fetchCertificates()).find((c) => c.id === id)
  if (!certificate) {
    printError('Certificate not found.')
    process.exit(1)
  }
  return certificate
}

function regionsOf(certificate: Certificate): string {
  return (certificate.regionalCertificates ?? []).map((r) => r.region).join(', ') || '-'
}

function since(timestamp: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(timestamp).getTime()) / 60_000))
  if (minutes < 60) return `${String(minutes)} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  return `${String(hours)} hour${hours === 1 ? '' : 's'} ago`
}

function printCertificate(certificate: Certificate): void {
  const also = certificate.additionalDomains?.length
    ? ` (also: ${certificate.additionalDomains.join(', ')})`
    : ''
  console.log(sanitizeTerminal(`${certificate.primaryDomain}${also}  ${certificate.status}`))
  for (const regional of certificate.regionalCertificates ?? []) {
    const checked = regional.lastValidatedAt
      ? `checked ${since(regional.lastValidatedAt)}, attempt ${String(regional.validationAttempts)}`
      : 'not checked yet'
    console.log(
      sanitizeTerminal(`  ${regional.region}  ${regional.status.toLowerCase()}  ${checked}`)
    )
    if (!WAITING.has(regional.status)) continue
    for (const record of regional.dnsRecords ?? []) {
      console.log(sanitizeTerminal(`    Create: ${record.type} ${record.name} -> ${record.value}`))
    }
  }
}

export function registerCertificatesCommand(program: Command): void {
  const certificatesCmd = program
    .command('certificates')
    .alias('certs')
    .description('List certificates and check their validation')

  const listCmd = certificatesCmd
    .command('list')
    .description("List the team's certificates")
    .option('--cloud <id>', 'Only certificates in this cloud account')
    .option('--domain <id>', 'Only certificates for this domain')
    .option('--json', 'Print the certificates as JSON')
    .action(async (options: { cloud?: string; domain?: string; json?: boolean }) => {
      try {
        const certificates = await fetchCertificates({
          ...(options.cloud ? { cloudAccountId: options.cloud } : {}),
          ...(options.domain ? { domainId: options.domain } : {}),
        })
        if (options.json) {
          console.log(JSON.stringify(certificates, null, 2))
          return
        }
        if (certificates.length === 0) {
          console.log('No certificates found.')
          return
        }
        const table = createTable({ head: ['ID', 'Domain', 'Status', 'Regions'] })
        for (const certificate of certificates) {
          table.push([
            certificate.id,
            certificate.primaryDomain,
            certificate.status,
            regionsOf(certificate),
          ])
        }
        console.log(sanitizeTerminal(table.toString()))
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })

  const showCmd = certificatesCmd
    .command('show')
    .description('Show a certificate in each region, with the DNS records validation still needs')
    .argument('<id>', 'Certificate id')
    .option('--json', 'Print the certificate as JSON')
    .action(async (id: string, options: { json?: boolean }) => {
      try {
        const certificate = await requireCertificate(id)
        if (options.json) {
          console.log(JSON.stringify(certificate, null, 2))
          return
        }
        printCertificate(certificate)
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })

  const validateCmd = certificatesCmd
    .command('validate')
    .description('Check validation again in every region still waiting, or in one region')
    .argument('<id>', 'Certificate id')
    .option('--region <region>', 'Only check the copy in this region')
    .action(async (id: string, options: { region?: string }) => {
      try {
        const certificate = await requireCertificate(id)
        if (certificate.status === 'ACTIVE') {
          printSuccess(`${certificate.primaryDomain} is already active.`)
          return
        }
        const { triggerCertificateValidation: result } = await graphqlRequest<
          TriggerCertificateValidationMutation,
          TriggerCertificateValidationMutationVariables
        >(TRIGGER_VALIDATION_MUTATION, {
          id,
          ...(options.region ? { region: options.region } : {}),
        })
        if (!result.success) {
          printError(result.message ?? 'There was an error while validating the certificate.')
          process.exit(1)
        }
        printSuccess(result.message ?? 'Checking validation again.')
        console.log(`  Check progress: gantry certificates show ${id}`)
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })

  addExamples(listCmd, [
    { command: 'gantry certificates list', description: "List the team's certificates" },
  ])
  addExamples(showCmd, [
    {
      command: 'gantry certificates show Tn4kZp9L',
      description: 'See which DNS records a certificate still waits on',
    },
  ])
  addExamples(certificatesCmd, [
    { command: 'gantry certificates list', description: "List the team's certificates" },
    {
      command: 'gantry certificates validate Tn4kZp9L',
      description: 'Check a waiting certificate again',
    },
  ])
  addExamples(validateCmd, [
    {
      command: 'gantry certificates validate Tn4kZp9L',
      description: 'Check every waiting region again',
    },
    {
      command: 'gantry certificates validate Tn4kZp9L --region us-east-1',
      description: 'Check one region again',
    },
  ])
}
