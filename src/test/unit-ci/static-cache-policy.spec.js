const { test } = require('node:test')
const assert = require('node:assert/strict')
const { cacheControlForPath } = require('../../app/lib/static-cache-policy')

const noCache = 'no-cache, no-store, must-revalidate'
const immutable = 'public, max-age=31536000, immutable'

test('never gives HTML or executable entry files a stale immutable cache', () => {
  assert.equal(cacheControlForPath('/'), noCache)
  assert.equal(cacheControlForPath('/index.html'), noCache)
  assert.equal(cacheControlForPath('/js/basic-build-a.js'), noCache)
  assert.equal(cacheControlForPath('/js/electerm-build-a.js'), noCache)
  assert.equal(cacheControlForPath('/js/worker-build-a.js'), noCache)
  assert.equal(cacheControlForPath('/css/style-build-a.css'), noCache)
})

test('revalidates unhashed icons, images, and unknown static files', () => {
  assert.equal(cacheControlForPath('/icons/default_file.svg'), noCache)
  assert.equal(cacheControlForPath('/images/electerm.png'), noCache)
  assert.equal(cacheControlForPath('/images/electerm-watermark.png'), noCache)
  assert.equal(cacheControlForPath('/favicon.ico'), noCache)
  assert.equal(cacheControlForPath('/robots.txt'), noCache)
})

test('revalidates build namespaces whose names carry no content hash', () => {
  assert.equal(cacheControlForPath('/chunk/name.js'), noCache)
  assert.equal(cacheControlForPath('/chunk/name-abc.js'), noCache)
  assert.equal(cacheControlForPath('/assets/font.woff2'), noCache)
  assert.equal(cacheControlForPath('/assets/rdp_client_bg.wasm'), noCache)
})

test('keeps fingerprinted chunks and asset-namespace files immutable', () => {
  assert.equal(cacheControlForPath('/chunk/xterm-build-a-AbCd1234.js'), immutable)
  assert.equal(cacheControlForPath('/chunk/xterm-build-a-AbCd1234.js?v=2'), immutable)
  assert.equal(cacheControlForPath('/assets/maple-mono-latin-400-normal-OcfaEJ46.woff2'), immutable)
  assert.equal(cacheControlForPath('/assets/rdp_client_bg-BxVYKtLA.wasm'), immutable)
})
