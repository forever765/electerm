const noCache = 'no-cache, no-store, must-revalidate'
const immutable = 'public, max-age=31536000, immutable'

function cacheControlForPath (url = '') {
  const path = url.split('?')[0]
  if (
    path === '/' ||
    path.endsWith('/index.html') ||
    /^\/js\/(basic|electerm|worker)-[^/]+\.js$/.test(path) ||
    /^\/css\/style-[^/]+\.css$/.test(path)
  ) {
    return noCache
  }
  return immutable
}

module.exports = { cacheControlForPath, noCache, immutable }
