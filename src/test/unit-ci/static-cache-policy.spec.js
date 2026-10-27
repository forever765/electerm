const { test } = require('node:test')
const assert = require('node:assert/strict')
const { cacheControlForPath } = require('../../app/lib/static-cache-policy')

const noCache = 'no-cache, no-store, must-revalidate'
const immutable = 'public, max-age=31536000, immutable'

test('never gives HTML or executable entry files a stale immutable cache', () => {
  assert.equal(cacheControlForPath('/index.html'), noCache)
  assert.equal(cacheControlForPath('/js/basic-build-a.js'), noCache)
  assert.equal(cacheControlForPath('/js/electerm-build-a.js'), noCache)
  assert.equal(cacheControlForPath('/js/worker-build-a.js'), noCache)
})

test('keeps content-hashed chunks and static images immutable', () => {
  assert.equal(cacheControlForPath('/chunk/xterm-build-a-AbCd1234.js'), immutable)
  assert.equal(cacheControlForPath('/images/electerm.png'), immutable)
})
