import { Readable } from 'stream'

import { describe, expect, it } from 'vitest'

import { readStdin } from './stdin'

describe('readStdin', () => {
  it('concatenates every chunk until the stream ends', async () => {
    const stream = Readable.from([Buffer.from('gpat_'), 'abc', Buffer.from('\n')])

    await expect(readStdin(stream)).resolves.toBe('gpat_abc\n')
  })

  it('returns an empty string for an empty stream', async () => {
    await expect(readStdin(Readable.from([]))).resolves.toBe('')
  })
})
