const noCache = 'no-cache, no-store, must-revalidate'
const immutable = 'public, max-age=31536000, immutable'

// Vite only content-hashes names in these two build namespaces:
// chunk/[name]-[hash].js and assets/[name]-[hash][extname]. Everything else
// (icons/, images/, unknown statics, and unhashed files in those namespaces)
// keeps its name across builds, so it must be revalidated.
const FINGERPRINTED_CHUNK = /^\/chunk\/[^/]+-[A-Za-z0-9_-]{8}\.js$/
const FINGERPRINTED_ASSET = /^\/assets\/[^/]+-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/

function cacheControlForPath (url = '') {
  const path = url.split('?')[0]
  if (
    FINGERPRINTED_CHUNK.test(path) ||
    FINGERPRINTED_ASSET.test(path)
  ) {
    return immutable
  }
  return noCache
}

module.exports = { cacheControlForPath, noCache, immutable }
