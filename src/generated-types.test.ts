import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'

import { describe, expect, it } from 'vitest'

const SRC = new URL('.', import.meta.url).pathname

const generated = readFileSync(join(SRC, 'generated/graphql.ts'), 'utf-8')
const generatedTypes = new Set(
  [...generated.matchAll(/^export type (\w+) =/gm)].map((match) => match[1])
)

const sources = readdirSync(SRC, { recursive: true, encoding: 'utf-8' })
  .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
  .filter((file) => !file.startsWith('generated'))
  .map((file) => ({ file, text: readFileSync(join(SRC, file), 'utf-8') }))

const CALL = /(?<!function )graphqlRequest\s*(<[^(]*?>|)\s*\(/g

function callSites() {
  return sources.flatMap(({ file, text }) =>
    [...text.matchAll(CALL)].map((match) => ({
      file,
      line: text.slice(0, match.index).split('\n').length,
      typeArgs: match[1]
        .slice(1, -1)
        .split(',')
        .map((arg) => arg.trim())
        .filter(Boolean),
    }))
  )
}

describe('graphqlRequest call sites', () => {
  it('finds call sites to check', () => {
    expect(callSites().length).toBeGreaterThan(100)
  })

  it('type every response and variables object with generated operation types', () => {
    const violations = callSites()
      .filter(({ typeArgs }) => {
        const [data, variables] = typeArgs
        return (
          typeArgs.length !== 2 ||
          !/(Query|Mutation)$/.test(data) ||
          variables !== `${data}Variables` ||
          !generatedTypes.has(data) ||
          !generatedTypes.has(variables)
        )
      })
      .map(({ file, line, typeArgs }) => `${file}:${String(line)} <${typeArgs.join(', ')}>`)

    expect(violations).toEqual([])
  })
})
