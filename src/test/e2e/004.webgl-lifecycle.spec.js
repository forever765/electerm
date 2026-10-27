/**
 * Opt-in local E2E: the real Electron WebGL lifecycle on a real GPU.
 *
 * Everything else in this suite launches Electron with `--disable-gpu`
 * (see ./app-options.js), which means xterm's addon-webgl can never create a
 * real WebGL2 context — so the renderer lifecycle added for the macOS
 * fullscreen black-terminal bug has no dynamic coverage at all. This spec
 * launches the app with GPU enabled (./app-options-webgl.js) and drives the
 * lifecycle through the same public surfaces a user would:
 *
 *   1. a terminal that becomes visible holds exactly one live WebGL context,
 *      and a terminal that was holding WebGL releases it when it is hidden;
 *   2. a real `webglcontextlost` falls the page back to the DOM renderer,
 *      trips the breaker, never rebuilds, and keeps the session alive;
 *   3. a webgl addon that can not be loaded (aborted chunk request) leaves the
 *      terminal on the DOM renderer without tripping the breaker.
 *
 * Opt-in only: it needs a real GPU-backed WebGL2 context and a real window, so
 * it runs only with LOCAL_WEBGL_TEST=1 on macOS. Everywhere else — CI included
 * — it must SKIP, never fail.
 *
 * Run it from the repository root, on a build of work/app:
 *
 *   # once, if playwright/electron are not installed yet. The registry prefix
 *   # matters: the default mirror here does not carry every pinned dependency.
 *   npm_config_registry=https://registry.npmjs.org \
 *     PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm run prepare-test
 *   npm run b     # clean + vite build + prepare work/app
 *   npm run pb    # electron build prep
 *   LOCAL_WEBGL_TEST=1 npx playwright test \
 *     src/test/e2e/004.webgl-lifecycle.spec.js --workers=1
 *
 * Both launches go through ./common/webgl-test-isolation.js, which gives each
 * of them its own throwaway root: DATA_PATH (electerm's own config, history
 * and database) and --user-data-dir (Chromium's profile) both live inside a
 * fresh temp dir and are removed once that app has closed. A run therefore
 * never reads or writes the developer's real electerm data, and the two tests
 * sharing one worker never share a profile or a database.
 *
 * NOTE: this file has never been executed against a live Electron window. Both
 * local attempts so far were blocked before the window appeared: the app could
 * not start its local backend while the developer's own electerm held
 * 127.0.0.1:30975, so none of the renderer assertions below has run yet. The
 * lifecycle ordering they assert — and the errata recorded against that
 * ordering — were reviewed against the lifecycle design, and the order
 * asserted below is the one the implementation produces (see the loss-episode
 * comment). Everything here is written to fail loudly (never silently pass)
 * when its premise does not hold, but it is unverified at runtime.
 */
const { _electron: electron, test, expect } = require('@playwright/test')
const delay = require('./common/wait')
const {
  createWebglLaunchOptions,
  cleanupWebglLaunchOptions
} = require('./common/webgl-test-isolation')

const enabled = process.env.LOCAL_WEBGL_TEST === '1' && process.platform === 'darwin'
test.skip(!enabled, 'requires a local macOS GPU/WebGL (set LOCAL_WEBGL_TEST=1)')

/**
 * Per-step retry budgets, in milliseconds. Every wait below uses one of these
 * instead of a literal so the test-level timeout can be derived from them.
 */
const STEP = {
  boot: 45000, // window.store exists (Electron cold start)
  terminal: 45000, // xterm mounted and actually on screen
  activation: 30000, // DOM -> WebGL activation settles
  churn: 30000, // five extra tabs settle
  transition: 20000, // one tab switch settles
  state: 20000, // one renderer-state-change converges
  loss: 25000, // context loss -> DOM fallback + breaker trip
  text: 25000 // shell text appears / a marker round-trips
}

/**
 * Worst-case sequence of step budgets in test 1 (the longer of the two), in
 * order. test 2 spends a subset of these.
 *
 * The test-level timeout must exceed the sum of the individual retry budgets:
 * if it fires first, a step that never converges is cut off by the test timeout
 * instead of by `waitForProbe`, which (a) loses the last-snapshot diagnostics
 * `waitForProbe` exists to provide and (b) can stop the `finally` block from
 * running — leaving `rendererType: 'webGL'` written into the developer's real
 * config. Keep this list in step with the waits in the tests.
 */
const STEP_SEQUENCE = [
  STEP.boot, STEP.terminal, // waitForTerminal
  STEP.activation, // visible terminal settles on WEBGL_ACTIVE
  STEP.state, // the WEBGL_ACTIVE record is observed
  STEP.churn, // five extra tabs settle
  STEP.transition, // switch to a background tab
  STEP.state, // the hidden terminal settles on DOM_HIDDEN
  STEP.transition, // switch back
  STEP.loss, // context loss -> DOM fallback + breaker trip
  STEP.text, STEP.text // pre-loss marker, then the post-loss marker
]
const TEST_TIMEOUT = STEP_SEQUENCE.reduce((sum, ms) => sum + ms, 0) +
  // margin for the non-retrying work: probes, evaluate round trips, typing
  60000
test.setTimeout(TEST_TIMEOUT)

const RENDER_MARKER = '[terminal-render] '
const POLL_INTERVAL = 200

/**
 * `.session-current` tracks store.activeTabId while `.session-batch-active`
 * tracks the current tab *of each pane* (session.styl:50-60); the two only
 * coincide in a single-pane layout. So no lookup below keys off either class:
 * every "the terminal the user can actually see" read goes through this one
 * predicate, which is the app's own visibility test (clientWidth/clientHeight
 * > 0, mixins/term-resize.js isElementVisible()). A multi-pane layout can then
 * never make two lookups disagree about which terminal is visible.
 */
const VISIBLE_WRAP_SRC = "[...document.querySelectorAll('.term-wrap')]" +
  '.find(el => el.clientWidth > 0 && el.clientHeight > 0) || null'

/** Collect every `[terminal-render] {json}` line the renderer logs. */
function collectRenderRecords (page) {
  const records = []
  page.on('console', msg => {
    const text = msg.text()
    const at = text.indexOf(RENDER_MARKER)
    if (at === -1) {
      return
    }
    try {
      records.push(JSON.parse(text.slice(at + RENDER_MARKER.length)))
    } catch (_) {
      records.push({ seq: -1, event: 'unparsable-log-line', raw: text.slice(at) })
    }
  })
  return records
}

/** Parsed records in emission order (unparsable lines dropped). */
function sortedRecords (records) {
  return records
    .filter(r => typeof r.seq === 'number' && r.seq > 0)
    .sort((a, b) => a.seq - b.seq)
}

/** One line per record, so a failing comparison is readable in the report. */
function describeRecords (records) {
  if (!records.length) {
    return '(no [terminal-render] records captured)'
  }
  return sortedRecords(records)
    .map(r => `#${r.seq} ${r.event} reason=${r.reason ?? '-'} ` +
      `rendererState=${r.state?.rendererState} visible=${r.state?.visible} ` +
      `webgl=${r.state?.webgl} contextLost=${r.state?.contextLost} ` +
      `circuit=${r.state?.circuitState} intentionalRelease=${r.intentionalRelease}`)
    .join('\n')
}

/**
 * Gate: the log-based assertions below are all "no such record exists" checks,
 * so without this they would pass vacuously if the browser console were never
 * captured (or every line failed to parse). Fail loudly instead.
 */
function assertRecordsCaptured (records, { minRecords, minStateChanges }) {
  const parsed = sortedRecords(records)
  const unparsable = records.filter(r => r.event === 'unparsable-log-line')
  expect(
    unparsable,
    'a [terminal-render] line was captured but could not be parsed — the log-based ' +
    `assertions in this test would be meaningless.\n${JSON.stringify(unparsable.slice(0, 3))}`
  ).toEqual([])
  expect(
    parsed.length,
    `only ${parsed.length} [terminal-render] record(s) were captured from the page console; ` +
    'the lifecycle never ran far enough to be asserted on.\n' +
    `(records: ${JSON.stringify(records).slice(0, 500)})`
  ).toBeGreaterThanOrEqual(minRecords)
  const stateChanges = parsed.filter(r => r.event === 'renderer-state-change')
  expect(
    stateChanges.length,
    `only ${stateChanges.length} 'renderer-state-change' record(s) were captured; ` +
    'the lifecycle state machine never reported its decisions.\n' +
    `All records:\n${describeRecords(records)}`
  ).toBeGreaterThanOrEqual(minStateChanges)
}

/** The terminal that is currently settled on WEBGL_ACTIVE while visible. */
function visibleWebglTerminalId (records) {
  const active = sortedRecords(records).filter(r =>
    r.event === 'renderer-state-change' &&
    r.state?.rendererState === 'WEBGL_ACTIVE' &&
    r.state?.visible === true
  )
  return active.length ? active[active.length - 1].terminal : null
}

/** The renderer state a terminal last settled on. */
function latestRendererState (records, terminalId) {
  const own = sortedRecords(records)
    .filter(r => r.terminal === terminalId && r.event === 'renderer-state-change')
  return own.length ? own[own.length - 1].state?.rendererState ?? null : null
}

/** First occurrence seq of an event, at or after an exclusive lower bound. */
function firstSeqAfter (records, event, afterSeq = -1) {
  const match = sortedRecords(records).find(r => r.event === event && r.seq > afterSeq)
  return match ? match.seq : null
}

/**
 * Retry a read until `predicate` accepts it, and — unlike `expect.poll`, whose
 * `message` option is a plain string evaluated once at call time — build the
 * failure message from a snapshot taken during the *last* attempt, so a timeout
 * reports the real state instead of a stale `null`.
 */
async function waitForProbe (label, read, predicate, {
  timeout = 30000,
  describe = value => JSON.stringify(value)
} = {}) {
  const deadline = Date.now() + timeout
  let last = null
  let readError = null
  for (;;) {
    try {
      last = await read()
      readError = null
      if (predicate(last)) {
        return last
      }
    } catch (error) {
      readError = error
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `${label}\nLast snapshot: ${describe(last)}` +
        (readError ? `\nLast read error: ${readError.message}` : '')
      )
    }
    await delay(POLL_INTERVAL)
  }
}

/** Sample repeatedly for `duration` and fail on the first bad sample. */
async function assertStable (label, read, predicate, {
  duration = 2000,
  interval = 250,
  describe = value => JSON.stringify(value)
} = {}) {
  const deadline = Date.now() + duration
  for (;;) {
    const value = await read()
    if (!predicate(value)) {
      throw new Error(`${label}\nUnstable snapshot: ${describe(value)}`)
    }
    if (Date.now() >= deadline) {
      return value
    }
    await delay(interval)
  }
}

/**
 * Single read-only snapshot of everything the assertions need. Kept as one
 * evaluate so a poll waits for a settled state instead of for one counter at a
 * time (two counters read in separate round trips can disagree).
 *
 * `liveWebglCanvases` is deliberately NOT "canvases found in the DOM":
 * canvas.getContext('webgl2') keeps returning the context object after the
 * context is lost, so a canvas that is still attached but dead would be counted
 * as WebGL. isContextLost() is what separates "the renderer still holds a
 * usable GL context" from "a dead canvas is still in the tree"; both numbers
 * are reported separately.
 */
function probe (page) {
  return page.evaluate(() => {
    const isVisible = el => el.clientWidth > 0 && el.clientHeight > 0
    const liveCanvasesIn = root => {
      let n = 0
      for (const canvas of root.querySelectorAll('.xterm-screen canvas')) {
        let gl = null
        try {
          gl = canvas.getContext('webgl2')
        } catch (_) {}
        if (gl && !gl.isContextLost()) {
          n += 1
        }
      }
      return n
    }
    const wraps = [...document.querySelectorAll('.term-wrap')]
    const hiddenWraps = wraps.filter(el => !isVisible(el))
    const visibleWraps = wraps.filter(isVisible)
    return {
      hasStore: !!window.store,
      tabs: window.store?.tabs?.length ?? -1,
      rendererType: window.store?.config?.rendererType ?? null,
      circuit: window.__terminalWebglDiagnostic?.circuitState ?? null,
      wraps: wraps.length,
      visibleWraps: visibleWraps.length,
      hiddenWraps: hiddenWraps.length,
      canvasesInDom: document.querySelectorAll('.xterm-screen canvas').length,
      liveWebglCanvases: liveCanvasesIn(document),
      // The invariant that matters: a terminal which is not on screen must not
      // still be holding a usable GL context.
      hiddenWrapsHoldingLiveWebgl: hiddenWraps.filter(el => liveCanvasesIn(el) > 0).length
    }
  })
}

/** Resolve once xterm is mounted and actually on screen (no fixed sleep). */
async function waitForTerminal (page) {
  await page.waitForFunction(
    () => !!(window.store && Array.isArray(window.store.tabs)),
    null,
    { timeout: STEP.boot }
  )
  const hasTab = await page.evaluate(() => window.store.tabs.length > 0)
  if (!hasTab) {
    // Open it exactly the way the UI does; no test-only hook.
    await page.evaluate(() => window.store.addTab())
  }
  await page.waitForFunction(
    () => [...document.querySelectorAll('.term-wrap')].some(el =>
      el.clientWidth > 0 && el.clientHeight > 0 && el.querySelector('.xterm-screen')
    ),
    null,
    { timeout: STEP.terminal }
  )
}

/**
 * Activate a tab the way the UI does — store/tab.js:412-413 assigns exactly
 * these two fields when a tab is activated. No React event is synthesised and
 * no app code is patched; the component tree reacts on its own.
 */
function activateTab (page, tabId) {
  return page.evaluate(id => {
    const tab = window.store.tabs.find(t => t.id === id)
    if (!tab) {
      throw new Error('cannot activate unknown tab ' + id)
    }
    window.store.activeTabId = id
    window.store[`activeTabId${tab.batch}`] = id
  }, tabId)
}

/** The visible terminal's rendered text (DOM renderer paints the whole buffer). */
function readVisibleTerminalText (page) {
  return page.evaluate(`(() => {
    const wrap = ${VISIBLE_WRAP_SRC}
    const rows = wrap && wrap.querySelector('.xterm-rows')
    return rows ? rows.innerText : null
  })()`)
}

/** Strips whitespace: a wrapped row would otherwise split the marker. */
function squeeze (text) {
  return (text || '').replace(/\s+/g, '')
}

function focusVisibleTerminal (page) {
  return page.evaluate(`(() => {
    const wrap = ${VISIBLE_WRAP_SRC}
    wrap && wrap.querySelector('.xterm-helper-textarea')?.focus?.()
  })()`)
}

/**
 * Drop the WebGL context of the visible terminal through the standard
 * WEBGL_lose_context extension — the same unexpected loss a driver reset or a
 * GPU switch produces. Nothing is patched or reset afterwards.
 */
function loseVisibleContext (page) {
  return page.evaluate(`(() => {
    const wrap = ${VISIBLE_WRAP_SRC}
    const canvas = wrap && wrap.querySelector('.xterm-screen canvas')
    if (!canvas) {
      throw new Error('no xterm canvas found in the visible terminal')
    }
    const gl = canvas.getContext('webgl2')
    const ext = gl && gl.getExtension('WEBGL_lose_context')
    if (!ext) {
      throw new Error('WEBGL_lose_context extension unavailable')
    }
    ext.loseContext()
    return true
  })()`)
}

/** Put the renderer config back so a run does not leak into the next launch. */
async function restoreRendererType (page, rendererType) {
  await page.evaluate(t => window.store.updateConfig({ rendererType: t }), rendererType)
  // saveUserConfig is debounced by 100ms; give the write a chance to land
  // before the app is closed.
  await delay(400)
}

test('keeps WebGL only on visible terminals and releases it when a terminal is hidden', async () => {
  // One private data root and profile per launch, not per module load: the
  // second test in this worker must never inherit this run's database, its
  // chunk cache, or a profile a failed close left behind.
  const appOptions = createWebglLaunchOptions()
  const app = await electron.launch(appOptions)
  let page = null
  let originalRendererType = null
  try {
    page = await app.firstWindow()
    const records = collectRenderRecords(page)
    await waitForTerminal(page)

    originalRendererType = (await probe(page)).rendererType
    test.info().annotations.push({
      type: 'initialRendererType',
      description: String(originalRendererType)
    })

    // Precondition, checked before anything is changed: the counts below are
    // all written for the default single-pane layout (store.layout = c1, see
    // init-state.js). A persisted multi-pane layout would make "exactly one
    // visible terminal" mean something else, so fail here with a message that
    // says so instead of failing later with a confusing count mismatch.
    const startState = await probe(page)
    expect(
      { layout: await page.evaluate(() => window.store.layout), visibleWraps: startState.visibleWraps },
      'this spec drives the default single-pane layout (1 visible terminal). This ' +
      'app instance is in a different layout, so the canvas-cap assertions below ' +
      'would not mean what they claim — use a single pane (layout c1) or extend this spec.'
    ).toEqual({ layout: 'c1', visibleWraps: 1 })

    // The tab we will come back to. Captured before the extra tabs exist so it
    // is unambiguous.
    const originalTabId = await page.evaluate(() => window.store.activeTabId)
    expect(originalTabId, 'the app has no active tab').toBeTruthy()

    // DOM -> WebGL is the only runtime path that resets the breaker, so this
    // is the public switch the lifecycle is driven through.
    await page.evaluate(() => window.store.updateConfig({ rendererType: 'webGL' }))

    // Wait for a real transition into WEBGL_ACTIVE, not just for a canvas to
    // appear: the record is what proves the state machine (and not some
    // leftover from an earlier renderer) is what put a context on screen.
    await waitForProbe(
      'the visible terminal must activate exactly one live WebGL context',
      () => probe(page),
      p => p.visibleWraps === 1 && p.liveWebglCanvases === 1,
      { timeout: STEP.activation }
    )
    const webglTerminalId = await waitForProbe(
      'no terminal ever reported settling on WEBGL_ACTIVE while visible, so the ' +
      'release-on-hide assertion below would have nothing to release',
      () => visibleWebglTerminalId(records),
      id => id !== null,
      { timeout: STEP.state, describe: id => String(id) + '\nAll records:\n' + describeRecords(records) }
    )

    const beforeTabCount = (await probe(page)).tabs
    const beforeWrapCount = (await probe(page)).wraps

    // Five background tabs, created exactly like the UI creates them. addTab()
    // intentionally selects each new tab, so re-activate the original tab at
    // the end; that only fixes which tab is *active* again — the five new tabs
    // mounted hidden and never activate WebGL, which is exactly why the tab
    // switch further down (the release proof) is needed.
    await page.evaluate(() => {
      for (let i = 0; i < 5; i++) {
        window.store.addTab({
          id: `webgl-test-${i}`,
          type: 'local',
          title: `webgl-test-${i}`,
          pane: 'terminal',
          batch: 0,
          status: 'processing'
        })
      }
    })
    await activateTab(page, originalTabId)

    await waitForProbe(
      '1 visible + 5 hidden terminals must settle to exactly one live WebGL context, ' +
      'and no hidden terminal may hold one',
      () => probe(page),
      p => p.tabs === beforeTabCount + 5 &&
        p.wraps === beforeWrapCount + 5 &&
        p.visibleWraps === 1 &&
        p.hiddenWraps === beforeWrapCount + 4 &&
        p.liveWebglCanvases === 1 &&
        p.hiddenWrapsHoldingLiveWebgl === 0,
      { timeout: STEP.churn, describe: value => JSON.stringify(value, null, 2) }
    )

    // --- the release proof --------------------------------------------------
    // Everything above only ever exercised terminals that mounted *hidden*, so
    // a completely broken deactivateWebglRenderer() would still pass it. Now
    // make the terminal that is actually holding WebGL go from visible to
    // hidden, and require that it let the context go.
    const switchWatermark = Math.max(...sortedRecords(records).map(r => r.seq), 0)
    await activateTab(page, 'webgl-test-0')

    // LAYER 1 of 3 — the only assertion that proves the GPU context was really
    // let go. `liveWebglCanvases` counts canvases whose context is still live
    // (isContextLost() === false) and `hiddenWrapsHoldingLiveWebgl` counts
    // hidden terminals still holding one, so an emptied disposeWebglAddon() or
    // a leaked addon reference shows up here and nowhere else.
    //
    // Do not fold this into layer 2 or 3 below (or delete it as "redundant"):
    // both of those check that a *function ran* — they stay green while the
    // context itself leaks. This one is what catches the leak.
    await waitForProbe(
      'after switching tabs the newly visible terminal must hold the one live ' +
      'WebGL context and no hidden terminal may still hold one',
      () => probe(page),
      p => p.visibleWraps === 1 &&
        p.liveWebglCanvases === 1 &&
        p.hiddenWrapsHoldingLiveWebgl === 0,
      { timeout: STEP.transition, describe: value => JSON.stringify(value, null, 2) }
    )

    // LAYER 2 of 3 — the state machine made the decision. An emptied
    // deactivateWebglRenderer() still passes this, which is why layer 1 exists.
    await waitForProbe(
      `the terminal that was holding WebGL (#${webglTerminalId}) went hidden and must ` +
      'settle on DOM_HIDDEN',
      () => latestRendererState(records, webglTerminalId),
      state => state === 'DOM_HIDDEN',
      { timeout: STEP.state, describe: state => String(state) + '\nAll records:\n' + describeRecords(records) }
    )

    // LAYER 3 of 3 — the release path itself ran, for that terminal, in response
    // to the hide. This pins the wiring (the log lives inside
    // deactivateWebglRenderer) but says nothing about the context being freed —
    // that claim belongs to layer 1.
    const releaseRecord = sortedRecords(records).find(r =>
      r.seq > switchWatermark &&
      r.terminal === webglTerminalId &&
      r.event === 'renderer-dispose'
    )
    expect(
      releaseRecord,
      `hiding terminal #${webglTerminalId} logged no 'renderer-dispose' at all — the ` +
      `release path never ran for it.\nAll records:\n${describeRecords(records)}`
    ).toBeTruthy()
    expect(
      releaseRecord?.intentionalRelease,
      'the release caused by hiding a terminal must be reported as deliberate.\n' +
      `Record: ${JSON.stringify(releaseRecord)}`
    ).toBe(true)

    // Switch back so the marker and the loss below happen in the original
    // terminal; this also proves a hidden terminal re-acquires WebGL.
    await activateTab(page, originalTabId)
    await waitForProbe(
      'switching back must re-activate WebGL on the original terminal and release ' +
      'the one we switched to',
      () => probe(page),
      p => p.visibleWraps === 1 &&
        p.liveWebglCanvases === 1 &&
        p.hiddenWrapsHoldingLiveWebgl === 0,
      { timeout: STEP.transition, describe: value => JSON.stringify(value, null, 2) }
    )

    // --- requirement 1, off the diagnostics stream ---------------------------
    assertRecordsCaptured(records, { minRecords: 4, minStateChanges: 2 })

    // No `renderer-state-change` record may show a hidden terminal settled on
    // WEBGL_ACTIVE. This is sound rather than a smoke check: the lifecycle only
    // enters WEBGL_ACTIVE from a frame callback that verified
    // getTarget() === webgl, getTarget() returns webgl only when
    // isElementVisible() is true, and the record's `visible` field is read in
    // the same synchronous tick.
    const hiddenActiveStates = sortedRecords(records).filter(r =>
      r.event === 'renderer-state-change' &&
      r.state?.rendererState === 'WEBGL_ACTIVE' &&
      r.state?.visible === false
    )
    expect(
      hiddenActiveStates,
      'a hidden terminal settled on WEBGL_ACTIVE — the visibility gate in ' +
      `getRendererTarget() is not being honoured.\nAll records:\n${describeRecords(records)}`
    ).toEqual([])

    // Broader net over every record: a hidden terminal must not be logged while
    // still holding the addon. `state.webgl` is `!!owner.webglAddon._renderer`,
    // and deactivateWebglRenderer() clears that reference *before* it logs
    // 'renderer-dispose', so the release path is not flagged by this.
    const hiddenWithAddon = sortedRecords(records).filter(r =>
      r.state?.visible === false && r.state?.webgl === true
    )
    expect(
      hiddenWithAddon,
      `a hidden terminal was logged while still holding the WebGL addon.\nAll records:\n${describeRecords(records)}`
    ).toEqual([])

    // Requirement 2, second half: with 1 visible + 5 hidden terminals the DOM
    // canvas count is capped at 1 (and, being alive, it is counted by both
    // `canvasesInDom` and `liveWebglCanvases` above).
    const beforeLoss = await probe(page)
    expect(beforeLoss.canvasesInDom).toBe(1)

    // --- real context loss --------------------------------------------------
    focusVisibleTerminal(page)
    await page.keyboard.type("printf 'before-loss-marker\\n'")
    await page.keyboard.press('Enter')

    const watermark = Math.max(...sortedRecords(records).map(r => r.seq), 0)
    await loseVisibleContext(page)

    await waitForProbe(
      'after a real context loss the visible terminal must release WebGL, trip the ' +
      'breaker and fall back to DOM',
      () => probe(page),
      p => p.visibleWraps === 1 &&
        p.liveWebglCanvases === 0 &&
        p.canvasesInDom === 0 &&
        p.circuit === 'TRIPPED',
      { timeout: STEP.loss, describe: value => JSON.stringify(value, null, 2) }
    )

    // The app and the terminal DOM are still there: the loss tears down the
    // renderer, not the session.
    const afterLoss = await probe(page)
    expect(afterLoss.wraps).toBe(beforeWrapCount + 5)
    expect(afterLoss.tabs).toBe(beforeTabCount + 5)

    // Loss episode order. This asserts the order the implementation actually
    // produces — `context-lost` -> `renderer-dispose` -> `dom-fallback-activated`
    // -> `webgl-circuit-tripped` — and deliberately NOT an earlier design
    // sketch (`... webgl-circuit-tripped -> renderer-dispose ->
    // dom-fallback-activated`), which the lifecycle design superseded.
    //
    // Do not "fix" this assertion back to the sketch's order, and do not move
    // the trip earlier in mixins/term-theme.js to match it. fallback(...,
    // { releaseContext: false }) must complete first: the breaker broadcasts
    // synchronously, so tripping earlier triggers this very terminal's own
    // circuit subscription (terminal.jsx subscribeWebglCircuit) ->
    // reconcileRenderer('circuit tripped') -> target becomes domFallback ->
    // deactivateTo(..., releaseContext: true) -> loseContext() on an already
    // lost context, which is exactly what releaseContext: false exists to
    // avoid.
    const episode = sortedRecords(records).filter(r => r.seq > watermark)
    const lostSeq = firstSeqAfter(episode, 'context-lost')
    expect(
      lostSeq,
      '\'context-lost\' was never logged during the loss episode ' +
      `(seq > ${watermark}).\n${describeRecords(episode)}`
    ).not.toBeNull()
    // Anchor on the loss itself: a release from just before the loss (a
    // throttled resize finishing late, say) must not be mistaken for part of
    // it, so only records at or after `context-lost` are ordered.
    const afterLossRecords = episode.filter(r => r.seq >= lostSeq)
    const order = {
      'context-lost': lostSeq,
      'renderer-dispose': firstSeqAfter(afterLossRecords, 'renderer-dispose'),
      'dom-fallback-activated': firstSeqAfter(afterLossRecords, 'dom-fallback-activated'),
      'webgl-circuit-tripped': firstSeqAfter(afterLossRecords, 'webgl-circuit-tripped')
    }
    const episodeDescription = `Loss episode (seq > ${watermark}). Order: ` +
      `${JSON.stringify(order)}\n${describeRecords(episode)}`
    for (const [event, seq] of Object.entries(order)) {
      expect(seq, `'${event}' was never logged during the loss episode.\n${episodeDescription}`)
        .not.toBeNull()
    }
    expect(order['context-lost'], `'context-lost' must come first.\n${episodeDescription}`)
      .toBeLessThan(order['renderer-dispose'])
    expect(order['renderer-dispose'], `'renderer-dispose' must precede the DOM fallback.\n${episodeDescription}`)
      .toBeLessThan(order['dom-fallback-activated'])
    expect(order['dom-fallback-activated'], `'dom-fallback-activated' must precede the breaker trip.\n${episodeDescription}`)
      .toBeLessThan(order['webgl-circuit-tripped'])

    const disposeRecord = afterLossRecords.find(r => r.event === 'renderer-dispose')
    expect(
      disposeRecord?.intentionalRelease,
      `the release caused by an unexpected loss must not be reported as deliberate.\n${episodeDescription}`
    ).toBe(false)

    // No rebuild storm: the breaker must stop every terminal from re-activating
    // WebGL after the loss, so neither the diagnostics nor a 2s sample window
    // may show a context coming back.
    expect(
      afterLossRecords.filter(r => r.event === 'renderer-activated'),
      `a terminal re-activated WebGL after the loss instead of staying on DOM.\n${episodeDescription}`
    ).toEqual([])
    await assertStable(
      'the visible terminal must stay on the DOM renderer after the loss',
      () => probe(page),
      p => p.liveWebglCanvases === 0 && p.canvasesInDom === 0 && p.circuit === 'TRIPPED',
      { duration: 2000, describe: value => JSON.stringify(value, null, 2) }
    )

    // --- session continuity ------------------------------------------------
    // The DOM renderer paints the whole buffer into `.xterm-rows`, so after the
    // fallback the marker typed before the loss is directly readable. Polled
    // rather than slept on: if the shell had not consumed the command the marker
    // never shows up and this fails loudly instead of passing. Whitespace is
    // squeezed because a narrow terminal can wrap the line across two rows.
    await waitForProbe(
      'the pre-loss marker must still be in the same terminal viewport',
      () => readVisibleTerminalText(page),
      text => squeeze(text).includes('before-loss-marker'),
      { timeout: STEP.text, describe: text => JSON.stringify((text || '').slice(-400)) }
    )

    focusVisibleTerminal(page)
    await page.keyboard.type("printf 'after-loss-marker\\n'")
    await page.keyboard.press('Enter')
    await waitForProbe(
      'the terminal must still accept input after falling back to DOM',
      () => readVisibleTerminalText(page),
      text => squeeze(text).includes('after-loss-marker'),
      { timeout: STEP.text, describe: text => JSON.stringify((text || '').slice(-400)) }
    )
  } finally {
    // Restore first, and inside `finally`, so the lifecycle converges on the
    // original renderer before shutdown instead of being torn down mid-switch.
    // (The data root is throwaway, so this is about a clean teardown, not
    // about protecting a developer's config.)
    if (page && originalRendererType !== null) {
      await restoreRendererType(page, originalRendererType).catch(() => {})
    }
    // Always tear the app down, including on assertion failure, so a failing
    // run cannot leave a zombie Electron behind. The private data root is only
    // removed once the app that owns it has actually exited; a failed close
    // leaves it in place for inspection rather than deleting files a live app
    // still has open.
    await app.close()
      .then(() => cleanupWebglLaunchOptions(appOptions))
      .catch(() => {})
  }
})

test('falls back to DOM when the webgl addon can not be loaded, without tripping the breaker', async () => {
  // Same factory as the test above: a separate data root and profile keep the
  // first test's addon chunk out of this one's module cache and keep its
  // database from leaking in. This also holds when the first app's close failed
  // and its profile is still locked.
  const appOptions = createWebglLaunchOptions()
  const app = await electron.launch(appOptions)
  let page = null
  let originalRendererType = null
  try {
    page = await app.firstWindow()
    const records = collectRenderRecords(page)

    // The addon is a lazily imported chunk served over http from the app's own
    // local server, so aborting the request makes the dynamic import reject —
    // the same failure a broken chunk fetch produces. This must be installed
    // before anything asks for the chunk, hence before the renderer switch.
    //
    // Pinned to the addon chunk with a regex, NOT a `**/*webgl*` glob: Playwright
    // globs only require the *last* path segment to match, so any build whose
    // entry script or stylesheet name happens to contain "webgl" (a webgl-named
    // build id does exactly that) would be aborted too — the app would never
    // boot, and `waitForTerminal` would time out instead of exercising the
    // failed-activation path. On the current build the only match is
    // `chunk/addon-webgl-<version>-<hash>.js` (verified against work/app/assets),
    // so this rule cannot hit an entry script, a stylesheet, or any other chunk.
    const abortedRequests = []
    await page.route(/\/chunk\/addon-webgl-/, route => {
      abortedRequests.push(route.request().url())
      return route.abort()
    })

    await waitForTerminal(page)
    originalRendererType = (await probe(page)).rendererType

    // The chunk must not already be in the module cache, otherwise aborting the
    // request proves nothing. The default config is 'dom' and both tests
    // restore it on the way out, so this only guards a hand-edited config file.
    expect(
      originalRendererType,
      'this test needs the app to start in DOM mode so the webgl chunk has not been ' +
      `fetched yet, but it started with rendererType=${originalRendererType}`
    ).toBe('dom')

    await page.evaluate(() => window.store.updateConfig({ rendererType: 'webGL' }))

    const failure = await waitForProbe(
      'a failed activation must be reported by the terminal that failed, and the ' +
      'aborted chunk request is the only reason it can have failed',
      () => sortedRecords(records).find(r => r.event === 'webgl-activation-failed') || null,
      record => record !== null,
      {
        timeout: STEP.activation,
        describe: record => `${JSON.stringify(record)}\n(aborted ${abortedRequests.length} request(s) so far)\n` +
          `All records:\n${describeRecords(records)}`
      }
    )

    // Proves the abort actually intercepted the chunk instead of the import
    // succeeding from cache and the failure coming from somewhere else.
    //
    // Scoped to the addon chunk on purpose: the diagnostics build id puts the
    // substring 'webgl' in *every* asset name (the entry scripts and
    // css/style-webgl-….css included), so a bare "was anything webgl-ish
    // aborted" count could be satisfied by a stylesheet request and would be
    // false evidence. Only `chunk/addon-webgl-*` requests count.
    const abortedAddonChunkRequests = abortedRequests
      .filter(url => url.includes('/chunk/addon-webgl-'))
    expect(
      abortedAddonChunkRequests.length,
      'the webgl addon chunk request was never intercepted — the abort rule or the ' +
      `chunk name changed. Aborted URLs: ${JSON.stringify(abortedRequests)}`
    ).toBeGreaterThan(0)

    // DOM_FALLBACK now lands when the activation promise settles (the lifecycle
    // converges on the current target on failure), so poll rather than reading
    // the state once.
    await waitForProbe(
      'the terminal that failed to activate must settle on DOM_FALLBACK',
      () => latestRendererState(records, failure.terminal),
      state => state === 'DOM_FALLBACK',
      {
        timeout: STEP.state,
        describe: state => `${String(state)}\nAll records:\n${describeRecords(records)}`
      }
    )

    assertRecordsCaptured(records, { minRecords: 2, minStateChanges: 1 })

    const settled = await probe(page)
    expect(settled.circuit, 'a failed activation is not a context loss and must not trip the breaker')
      .toBe('HEALTHY')
    expect(settled.liveWebglCanvases).toBe(0)
    expect(settled.canvasesInDom).toBe(0)
    expect(settled.wraps).toBeGreaterThan(0)
    expect(settled.visibleWraps).toBeGreaterThanOrEqual(1)

    // Behavioural, not just a state name: the terminal has to actually still
    // work as a DOM terminal after the addon failed to load.
    await waitForProbe(
      'the terminal must keep rendering text in DOM mode after the addon failed to load',
      () => readVisibleTerminalText(page),
      text => squeeze(text).length > 0,
      { timeout: STEP.text, describe: text => JSON.stringify((text || '').slice(-400)) }
    )

    // webglActivationFailed must stop every later commit from re-running the
    // failing activation. Force real React commits (triggerResize flips an
    // observable store flag and fires a window resize) and check the request
    // count does not grow.
    const requestsBefore = sortedRecords(records)
      .filter(r => r.event === 'webgl-activation-request').length
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.store.triggerResize())
      await delay(500)
    }
    const requestsAfter = sortedRecords(records)
      .filter(r => r.event === 'webgl-activation-request').length
    expect(
      requestsAfter,
      'a terminal whose activation already failed must not retry on every commit ' +
      `(${requestsBefore} request(s) before the extra commits, ${requestsAfter} after).\n` +
      describeRecords(records)
    ).toBe(requestsBefore)
    expect(
      await probe(page),
      'the failed terminal must still be on the DOM renderer after further commits'
    ).toMatchObject({ circuit: 'HEALTHY', liveWebglCanvases: 0, canvasesInDom: 0 })
  } finally {
    if (page && originalRendererType !== null) {
      await restoreRendererType(page, originalRendererType).catch(() => {})
    }
    await app.close()
      .then(() => cleanupWebglLaunchOptions(appOptions))
      .catch(() => {})
  }
})
