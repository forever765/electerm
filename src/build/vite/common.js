import { config as conf } from 'dotenv'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { createBuildId } = require('../build-id.js')

conf()

export const cwd = process.cwd()
export const env = process.env
export const isProd = env.NODE_ENV === 'production'
const packPath = resolve(cwd, '../../../package.json')
export const pack = JSON.parse(readFileSync(packPath).toString())
export const version = pack.version
// Must be computed after pack is read: a diagnostic build sets
// ELECTERM_BUILD_ID so its asset URLs differ from a normal release build,
// otherwise the version-only names collide and a stale cached bundle wins.
export const buildId = createBuildId(pack.version)
export const viewPath = resolve(cwd, '../../../src/client/views')
export const staticPaths = [
  {
    dir: resolve(cwd, '../../../node_modules/electerm-icons/icons'),
    path: '/icons'
  },
  {
    dir: resolve(cwd, '../../../node_modules/@electerm/electerm-resource/tray-icons'),
    path: '/images'
  },
  {
    dir: resolve(cwd, '../../../node_modules/@electerm/electerm-resource/res/imgs'),
    path: '/images'
  },
  {
    dir: resolve(cwd, '../../../src/client/entry'),
    path: '/'
  }
]
