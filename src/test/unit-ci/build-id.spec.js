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
    const serialized = JSON.parse(html.match(/window\.et = (\{.*?\})<\/script>/s)[1])
    // basic.js picks its worker and entry URLs from window.et.buildId with a
    // version fallback, so a mismatch here would request a URL that does not
    // exist in the build.
    assert.equal(serialized.buildId, buildId)
    assert.match(html, new RegExp(`href="css/style-${serialized.buildId}\\.css"`))
    assert.match(html, new RegExp(`href="js/electerm-${serialized.buildId}\\.js"`))
    assert.match(html, new RegExp(`src="/js/basic-${serialized.buildId}\\.js"`))
    assert.match(html, new RegExp(`href="chunk/xterm-${buildId}-AbCd1234\\.js"`))
    assert.doesNotMatch(html, new RegExp(`electerm-${version}\\.js`))
    assert.doesNotMatch(html, new RegExp(`style-${version}\\.css`))
    assert.doesNotMatch(html, /lazy-/)
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
})

// pug 在真实构建目录外的临时树里跑一遍，模拟 Vite 写好的产物，返回生成的 HTML。
// 入口文件名按期望的 build ID 生成：如果 pug 用了别的 ID，preload 会找不到入口。
function renderProductionHtml ({ shellBuildId, dotenvBuildId, assetId }) {
  const repoRoot = path.resolve(__dirname, '../../..')
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'electerm-build-id-'))
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
      JSON.stringify({ name: 'electerm', version: '9.9.9' })
    )
    if (dotenvBuildId) {
      const envPath = path.join(tmpRoot, 'src/build/vite/.env')
      fs.mkdirSync(path.dirname(envPath), { recursive: true })
      fs.writeFileSync(envPath, `ELECTERM_BUILD_ID=${dotenvBuildId}\n`)
    }
    const entryDir = path.join(tmpRoot, 'work/app/assets/js')
    fs.mkdirSync(entryDir, { recursive: true })
    fs.writeFileSync(
      path.join(entryDir, `electerm-${assetId}.js`),
      'import{a}from"../chunk/xterm-' + assetId + '-AbCd1234.js";'
    )
    const env = { ...process.env, NODE_PATH: path.join(repoRoot, 'node_modules') }
    delete env.ELECTERM_BUILD_ID
    if (shellBuildId) env.ELECTERM_BUILD_ID = shellBuildId
    const run = spawnSync(process.execPath, [path.join(tmpRoot, 'src/build/bin/pug.js')], {
      cwd: tmpRoot,
      env,
      encoding: 'utf-8'
    })
    if (run.status !== 0) throw new Error(`pug failed: ${run.stderr}`)
    return fs.readFileSync(path.join(tmpRoot, 'work/app/assets/index.html'), 'utf-8')
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
}

test('HTML uses a build ID that only src/build/vite/.env provides', () => {
  const dotenvBuildId = 'dotenv-only-build-1'
  const html = renderProductionHtml({
    dotenvBuildId,
    assetId: dotenvBuildId
  })
  const serialized = JSON.parse(html.match(/window\.et = (\{.*?\})<\/script>/s)[1])
  assert.equal(serialized.buildId, dotenvBuildId)
  assert.match(html, new RegExp(`href="css/style-${dotenvBuildId}\\.css"`))
  assert.match(html, new RegExp(`href="js/electerm-${dotenvBuildId}\\.js"`))
  assert.match(html, new RegExp(`src="/js/basic-${dotenvBuildId}\\.js"`))
  assert.match(html, new RegExp(`href="chunk/xterm-${dotenvBuildId}-AbCd1234\\.js"`))
  assert.doesNotMatch(html, /style-9\.9\.9\.css/)
})

test('an explicit shell build ID wins over the .env value', () => {
  const shellBuildId = 'shell-wins-1'
  const dotenvBuildId = 'dotenv-only-build-1'
  const html = renderProductionHtml({
    shellBuildId,
    dotenvBuildId,
    assetId: shellBuildId
  })
  const serialized = JSON.parse(html.match(/window\.et = (\{.*?\})<\/script>/s)[1])
  assert.equal(serialized.buildId, shellBuildId)
  assert.match(html, new RegExp(`href="js/electerm-${shellBuildId}\\.js"`))
  assert.match(html, new RegExp(`href="chunk/xterm-${shellBuildId}-AbCd1234\\.js"`))
  assert.doesNotMatch(html, new RegExp(dotenvBuildId))
})
