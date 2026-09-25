/**
 * Refresh `schema/public-api.graphql` over HTTP from a running API, never from a local checkout,
 * so contributors and maintainers run the same command.
 *
 *   npm run schema:pull
 *   npm run schema:pull -- --url https://api.gantrydeploy.com/public/graphql/schema.graphql
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const destination = join(__dirname, '..', 'schema', 'public-api.graphql')

const DEFAULT_URL = 'https://api.gantrydeploy.com/public/graphql/schema.graphql'

function resolveUrl(argv) {
  const flagIndex = argv.indexOf('--url')
  if (flagIndex !== -1) {
    const value = argv[flagIndex + 1]
    if (!value || value.startsWith('-')) {
      throw new Error(`--url needs a value, e.g. --url ${DEFAULT_URL}`)
    }
    return value
  }
  return process.env.GANTRY_SCHEMA_URL ?? DEFAULT_URL
}

async function previousContents() {
  try {
    return await readFile(destination, 'utf-8')
  } catch {
    return null
  }
}

const url = resolveUrl(process.argv.slice(2))

const response = await fetch(url)
if (!response.ok) {
  throw new Error(`${url} returned ${String(response.status)}`)
}

const schema = await response.text()
// A misrouted request lands on an HTML page. Writing that would break codegen
// with a parse error a long way from its cause.
if (!schema.includes('type Query')) {
  throw new Error(`${url} did not return a GraphQL schema`)
}

const before = await previousContents()
await mkdir(dirname(destination), { recursive: true })
await writeFile(destination, schema, 'utf-8')

console.log(`Schema source: ${url}`)
if (before === schema) {
  console.log('No change: schema/public-api.graphql is already current.')
} else if (before === null) {
  console.log('Wrote schema/public-api.graphql. Run `npm run codegen` next.')
} else {
  console.log('Schema changed. Run `npm run codegen` and commit both files.')
}
