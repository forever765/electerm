const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { createBuildId } = require('../../../src/build/build-id')

test('uses a safe explicit diagnostic build ID', () => {
  assert.equal(
    createBuildId('5.5.15', 'webgl visible/1+abc123'),
    'webgl-visible-1-abc123'
  )
})

test('falls back to the package version for normal releases', () => {
  assert.equal(createBuildId('5.5.15'), '5.5.15')
})

test('rejects an explicit ID that becomes empty', () => {
  assert.throws(() => createBuildId('5.5.15', '///'), /build ID/i)
})

test('production HTML and its preload hints share the explicit build ID', () => {
  const repoRoot = path.resolve(__dirname, '../../..')
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-build-id-'))
  const version = '9.9.9'
  const buildId = 'webgl-visible-1-abc123'
  try {
    for (const file of [
      'src/build/build-id.js',
      'src/build/bin/pug.js',
      'src/client/views/index.pug'
    ]) {
      const dest = path.join(tmpRoot, file)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(path.join(repoRoot, file), dest)
    }
    fs.writeFileSync(
      path.join(tmpRoot, 'package.json'),
      JSON.stringify({ name: 'electerm', version })
    )
    const entryDir = path.join(tmpRoot, 'work/app/assets/js')
    fs.mkdirSync(entryDir, { recursive: true })
    fs.writeFileSync(
      path.join(entryDir, `electerm-${buildId}.js`),
      'import{a}from"../chunk/xterm-' + buildId + '-AbCd1234.js";' +
        'const lazy=["../chunk/lazy-' + buildId + '.js"];'
    )
    const run = spawnSync(process.execPath, [path.join(tmpRoot, 'src/build/bin/pug.js')], {
      cwd: tmpRoot,
      env: {
        ...process.env,
        ELECTERM_BUILD_ID: buildId,
        NODE_PATH: path.join(repoRoot, 'node_modules')
      },
      encoding: 'utf-8'
    })
    assert.equal(run.status, 0, run.stderr)
    const html = fs.readFileSync(path.join(tmpRoot, 'work/app/assets/index.html'), 'utf-8')
    assert.match(html, new RegExp(`href="css/style-${buildId}\\.css"`))
    assert.match(html, new RegExp(`href="js/electerm-${buildId}\\.js"`))
    assert.match(html, new RegExp(`src="/js/basic-${buildId}\\.js"`))
    assert.match(html, new RegExp(`href="chunk/xterm-${buildId}-AbCd1234\\.js"`))
    assert.doesNotMatch(html, new RegExp(`electerm-${version}\\.js`))
    assert.doesNotMatch(html, new RegExp(`style-${version}\\.css`))
    assert.doesNotMatch(html, /lazy-/)
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
})
