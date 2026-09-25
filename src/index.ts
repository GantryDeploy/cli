import { assertSupportedNodeVersion } from './lib/node-version'

// Static imports would load every dependency before this check, so an old Node could crash first.
assertSupportedNodeVersion()
await import('./main')
