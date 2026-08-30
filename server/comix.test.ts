import assert from 'node:assert/strict'
import test from 'node:test'
import { buildComixSearchParams } from './comix.js'

test('Comix search mirrors the public browse defaults', () => {
  assert.deepEqual(buildComixSearchParams('  one piece  ', 2), {
    keyword: 'one piece',
    page: 2,
    limit: 28,
    content_rating: ['safe', 'suggestive'],
    order: { relevance: 'desc' },
  })
})
