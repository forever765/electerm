const { describe, test } = require('node:test')
const assert = require('node:assert/strict')

const loadModule = () => import('../../client/components/terminal/terminal-render-recovery.mjs')

describe('terminal render recovery', () => {
  test('refreshes all rows after the window regains focus', async () => {
    const { refreshTerminalAfterWindowFocus } = await loadModule()
    const calls = []
    const term = {
      rows: 24,
      focus: () => calls.push('focus'),
      refresh: (...args) => calls.push(['refresh', ...args])
    }

    refreshTerminalAfterWindowFocus(term)

    assert.deepEqual(calls, [
      'focus',
      ['refresh', 0, 23]
    ])
  })

  test('coalesces concurrent renderer reloads into one operation', async () => {
    const { createSingleFlight } = await loadModule()
    let release
    const gate = new Promise(resolve => {
      release = resolve
    })
    let calls = 0
    const reload = createSingleFlight(async () => {
      calls++
      await gate
      return calls
    })

    const first = reload()
    const second = reload()

    assert.strictEqual(first, second)
    assert.equal(calls, 1)

    release()
    assert.equal(await first, 1)
  })
})
