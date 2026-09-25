import { input, select } from '@inquirer/prompts'
import type { Command } from 'commander'

import type {
  CreateCertificateInput,
  CreateCertificateMutation,
  CreateCertificateMutationVariables,
  CreateDomainMutation,
  CreateDomainMutationVariables,
  GetDomainsQuery,
  GetDomainsQueryVariables,
} from '../generated/graphql'
import { formatApiError, graphqlRequest } from '../lib/client'
import {
  isValidCertificateDomain,
  parseAdditionalDomains,
  rootDomainErrorMessage,
  validateRootDomain,
} from '../lib/domain-validation'
import { selectCloud, selectDomain, selectRegions } from '../lib/interactive-prompts'
import { createTable, formatDate, printError, printSuccess } from '../lib/output'
import { sanitizeTerminal } from '../lib/sanitize'

const DOMAINS_QUERY = /* GraphQL */ `
  query GetDomains {
    domains {
      id
      name
      createdAt
      updatedAt
    }
  }
`

const CREATE_DOMAIN_MUTATION = /* GraphQL */ `
  mutation CreateDomain($input: CreateDomainInput!) {
    createDomain(input: $input) {
      success
      message
      domain {
        id
        name
        createdAt
      }
    }
  }
`

const CREATE_CERTIFICATE_MUTATION = /* GraphQL */ `
  mutation CreateCertificate($input: CreateCertificateInput!) {
    createCertificate(input: $input) {
      success
      message
      certificate {
        id
        primaryDomain
        status
        createdAt
      }
    }
  }
`

function validateDomainName(value: string): string | true {
  const trimmed = value.trim()
  if (!trimmed) return 'Domain name is required'
  const result = validateRootDomain(trimmed)
  if (!result.ok) {
    return rootDomainErrorMessage(trimmed, result)
  }
  return true
}

function validateCertDomain(value: string): string | true {
  const trimmed = value.trim()
  if (!trimmed) return 'Primary domain is required'
  if (!isValidCertificateDomain(trimmed)) {
    return 'Please enter a valid domain name (e.g., example.com or *.example.com).'
  }
  return true
}

function exitIfInvalidCertDomain(value: string): void {
  const validation = validateCertDomain(value)
  if (validation !== true) {
    printError(validation)
    process.exit(1)
  }
}

export function registerDomainsCommand(program: Command): void {
  const domainsCmd = program.command('domains').description('Manage domains and certificates')

  domainsCmd
    .command('list')
    .description('List all domains')
    .action(async () => {
      try {
        const data = await graphqlRequest<GetDomainsQuery, GetDomainsQueryVariables>(DOMAINS_QUERY)
        const { domains } = data

        if (domains.length === 0) {
          console.log('No domains found.')
          return
        }

        const table = createTable({
          head: ['ID', 'Name', 'Created'],
        })

        for (const domain of domains) {
          table.push([domain.id, domain.name, formatDate(domain.createdAt)])
        }

        console.log(table.toString())
      } catch (error) {
        printError(formatApiError(error))
        process.exit(1)
      }
    })

  domainsCmd
    .command('create')
    .description('Create a new domain')
    .option('--name <fqdn>', 'Domain name (e.g., example.com)')
    .option('--request-cert', 'Also request a certificate for this domain')
    .option('--cloud <id>', 'Cloud account ID (required with --request-cert)')
    .option(
      '--regions <regions>',
      'Comma-separated AWS regions for certificate (required with --request-cert)'
    )
    .option('--primary-domain <fqdn>', 'Primary domain for certificate (defaults to domain name)')
    .option('--additional-domains <domains>', 'Comma-separated additional domains for certificate')
    .action(
      async (options: {
        name?: string
        requestCert?: boolean
        cloud?: string
        regions?: string
        primaryDomain?: string
        additionalDomains?: string
      }) => {
        try {
          const name =
            options.name ??
            (await input({
              message: 'Domain name (e.g., example.com):',
              validate: validateDomainName,
            }))

          const trimmedName = name.trim().toLowerCase()
          const nameValidation = validateDomainName(trimmedName)
          if (nameValidation !== true) {
            printError(nameValidation)
            process.exit(1)
          }

          const domainData = await graphqlRequest<
            CreateDomainMutation,
            CreateDomainMutationVariables
          >(CREATE_DOMAIN_MUTATION, { input: { name: trimmedName } })

          const domainResult = domainData.createDomain
          const createdDomain = domainResult.domain
          if (!domainResult.success || !createdDomain) {
            printError(domainResult.message ?? 'Failed to create domain')
            process.exit(1)
          }

          printSuccess(`Domain created: ${createdDomain.name}`)
          console.log(`  ID: ${sanitizeTerminal(createdDomain.id)}`)

          let requestCert = options.requestCert
          requestCert ??= await select({
            message: 'Request a certificate for this domain?',
            choices: [
              { name: 'No', value: false },
              { name: 'Yes', value: true },
            ],
          })

          if (requestCert) {
            const cloudAccountId = options.cloud ?? (await selectCloud())

            const primaryDomain =
              options.primaryDomain ??
              (await input({
                message: 'Primary domain for certificate:',
                default: trimmedName,
                validate: validateCertDomain,
              }))
            exitIfInvalidCertDomain(primaryDomain)

            let additionalDomains: string[] = []
            if (options.additionalDomains) {
              additionalDomains = parseAdditionalDomains(options.additionalDomains)
            } else {
              const additionalInput = await input({
                message: 'Additional domains (comma-separated, optional):',
              })
              if (additionalInput.trim()) {
                additionalDomains = parseAdditionalDomains(additionalInput)
              }
            }

            for (const domain of additionalDomains) {
              if (!isValidCertificateDomain(domain)) {
                printError(`Invalid domain: ${domain}`)
                process.exit(1)
              }
            }

            let regions: string[]
            if (options.regions) {
              regions = options.regions.split(',').map((r) => r.trim())
            } else {
              regions = await selectRegions()
            }

            const certInput: CreateCertificateInput = {
              cloudAccountId,
              domainId: createdDomain.id,
              primaryDomain,
              regions,
            }
            if (additionalDomains.length > 0) {
              certInput.additionalDomains = additionalDomains
            }

            const certData = await graphqlRequest<
              CreateCertificateMutation,
              CreateCertificateMutationVariables
            >(CREATE_CERTIFICATE_MUTATION, { input: certInput })

            const certResult = certData.createCertificate
            const certificate = certResult.certificate
            if (!certResult.success || !certificate) {
              printError(certResult.message ?? 'Failed to request certificate')
              process.exit(1)
            }

            printSuccess(`Certificate requested: ${certificate.primaryDomain}`)
            console.log(`  Certificate ID: ${sanitizeTerminal(certificate.id)}`)
            console.log(`  Status: ${sanitizeTerminal(certificate.status.toUpperCase())}`)
          }
        } catch (error) {
          printError(formatApiError(error))
          process.exit(1)
        }
      }
    )

  domainsCmd
    .command('request-cert [domainId]')
    .description('Request a certificate for an existing domain')
    .option('--cloud <id>', 'Cloud account ID')
    .option('--regions <regions>', 'Comma-separated AWS regions (e.g., us-east-1,us-west-2)')
    .option('--primary-domain <fqdn>', 'Primary domain name (defaults to domain name)')
    .option('--additional-domains <domains>', 'Comma-separated additional domains for certificate')
    .action(
      async (
        domainId: string | undefined,
        options: {
          cloud?: string
          regions?: string
          primaryDomain?: string
          additionalDomains?: string
        }
      ) => {
        try {
          let selectedDomainId: string
          let domainName: string

          if (domainId) {
            selectedDomainId = domainId
            const domainData = await graphqlRequest<GetDomainsQuery, GetDomainsQueryVariables>(
              DOMAINS_QUERY
            )
            const domain = domainData.domains.find((d) => d.id === domainId)
            if (!domain) {
              printError(`Domain not found: ${domainId}`)
              process.exit(1)
            }
            domainName = domain.name
          } else {
            const selected = await selectDomain()
            selectedDomainId = selected.id
            domainName = selected.name
          }

          const cloudAccountId = options.cloud ?? (await selectCloud())

          const primaryDomain =
            options.primaryDomain ??
            (await input({
              message: 'Primary domain for certificate:',
              default: domainName,
              validate: validateCertDomain,
            }))
          exitIfInvalidCertDomain(primaryDomain)

          let additionalDomains: string[] = []
          if (options.additionalDomains) {
            additionalDomains = parseAdditionalDomains(options.additionalDomains)
          } else {
            const additionalInput = await input({
              message: 'Additional domains (comma-separated, optional):',
            })
            if (additionalInput.trim()) {
              additionalDomains = parseAdditionalDomains(additionalInput)
            }
          }

          for (const domain of additionalDomains) {
            if (!isValidCertificateDomain(domain)) {
              printError(`Invalid domain: ${domain}`)
              process.exit(1)
            }
          }

          let regions: string[]
          if (options.regions) {
            regions = options.regions.split(',').map((r) => r.trim())
          } else {
            regions = await selectRegions()
          }

          const certInput: CreateCertificateInput = {
            cloudAccountId,
            domainId: selectedDomainId,
            primaryDomain,
            regions,
          }
          if (additionalDomains.length > 0) {
            certInput.additionalDomains = additionalDomains
          }

          const data = await graphqlRequest<
            CreateCertificateMutation,
            CreateCertificateMutationVariables
          >(CREATE_CERTIFICATE_MUTATION, { input: certInput })

          const result = data.createCertificate
          const certificate = result.certificate
          if (!result.success || !certificate) {
            printError(result.message ?? 'Failed to request certificate')
            process.exit(1)
          }

          printSuccess(`Certificate requested: ${certificate.primaryDomain}`)
          console.log(`  Certificate ID: ${sanitizeTerminal(certificate.id)}`)
          console.log(`  Status: ${sanitizeTerminal(certificate.status.toUpperCase())}`)
        } catch (error) {
          printError(formatApiError(error))
          process.exit(1)
        }
      }
    )
}
