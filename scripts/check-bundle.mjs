import { readdirSync, readFileSync } from 'node:fs'

const distDir = new URL('../dist/', import.meta.url)
const moduleMarker = /^\/\/ \S+\.(?:[cm]?[jt]sx?|json)$/

let files
try {
  files = readdirSync(distDir).filter((name) => name.endsWith('.js'))
} catch (error) {
  console.error(`check:bundle: cannot read ${distDir.pathname}. Run \`npm run build\` first.`)
  console.error(error)
  process.exit(1)
}

if (!files.includes('index.js')) {
  console.error('check:bundle: dist/index.js is missing. Run `npm run build` first.')
  process.exit(1)
}

const inlined = files.flatMap((name) =>
  readFileSync(new URL(name, distDir), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => moduleMarker.test(line) && !line.startsWith('// src/'))
    .map((line) => `${name}: ${line.slice('// '.length)}`)
)

if (inlined.length > 0) {
  console.error('check:bundle: third-party code is inlined into dist:')
  for (const entry of inlined) console.error(`  ${entry}`)
  console.error('Declare the package in "dependencies" so tsup keeps it external.')
  process.exit(1)
}

console.log(`check:bundle: no third-party code inlined into dist (${files.length} files)`)
