const { cacheControlForPath, noCache } = require('./static-cache-policy')

module.exports = (app) => {
  const express = require('express')
  const path = require('path')

  return new Promise((resolve) => {
    const assetsPath = path.resolve(__dirname, '../assets')
    // Asset names carry either a build ID or a content hash, so content-hashed
    // chunks stay immutable while the HTML and the unhashed entry bundles
    // (index.html, js/basic-*, js/electerm-*, js/worker-*, css/style-*) must be
    // revalidated -- a one-year maxAge on those is what served a stale build.
    const conf = {
      setHeaders: (res, filePath) => {
        const relative = '/' + path.relative(assetsPath, filePath).split(path.sep).join('/')
        res.setHeader('Cache-Control', cacheControlForPath(relative))
      }
    }

    // Handle _temp_*.css files - return empty CSS to prevent MIME type errors
    app.use((req, res, next) => {
      if (req.url.startsWith('/css/_temp_') && req.url.endsWith('.css')) {
        res.setHeader('Content-Type', 'text/css')
        res.setHeader('Cache-Control', noCache)
        res.send('')
        return
      }
      next()
    })

    app.use(
      express.static(assetsPath, conf)
    )
  })
}
