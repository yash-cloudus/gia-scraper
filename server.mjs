/**
 * GIA lookup service - opens GIA's Report Check in a real Google Chrome and
 * hands back the report JSON that page loads from rdwb.gia.edu. GIA's Akamai
 * bot check blocks plain fetch, headless Chrome and calling rdwb directly, so
 * this needs a machine with Chrome installed AND a desktop session (Windows
 * with a logged-in user, or Linux under `xvfb-run`) - never Vercel/Hostinger.
 * The ERP's `/api/gia` (src/app/api/gia/route.ts) calls it.
 *
 *   cd gia-scraper && npm install && npm start
 *   GET /gia?reportNo=6202161437   (Authorization: Bearer <GIA_SCRAPER_TOKEN>)
 *   -> 200 GIA's JSON minus "labels" | 400 | 401 | 404 / 504 / 502 { error }
 *
 * Env: PORT (4100), HOST (127.0.0.1 - set 0.0.0.0 to serve other machines,
 * which then requires GIA_SCRAPER_TOKEN).
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { chromium, errors } from 'playwright'

const PORT = Number(process.env.PORT ?? 4100)
const HOST = process.env.HOST ?? '127.0.0.1'
const TOKEN = process.env.GIA_SCRAPER_TOKEN ?? ''
const MAX_AT_ONCE = 2
const TIMEOUT_MS = 60_000
/** Once GIA blocks us, it isn't asked again for this long - retries during a block may only stretch it. */
const COOLDOWN_MS = 10 * 60_000
let blockedUntil = 0
/**
 * Report number -> GIA's JSON. A searched-again number answers instantly and
 * costs GIA nothing. ponytail: in memory, oldest out past CACHE_MAX, gone on
 * restart; a re-graded report shows its old grades until then.
 */
const cache = new Map()
const CACHE_MAX = 1000

if (HOST !== '127.0.0.1' && HOST !== 'localhost' && !TOKEN) {
  throw new Error('Set GIA_SCRAPER_TOKEN before serving other machines (HOST is not 127.0.0.1).')
}

/**
 * One Chrome for every lookup (a Promise, so two first requests don't launch
 * two); relaunched once it closes or crashes. It keeps one lasting profile
 * (gia-scraper/.chrome-profile) so GIA's cookies carry over like a person's
 * browser, and runs without Playwright's automation flags: a fresh,
 * automation-flagged Chrome per lookup got a 403 after a few lookups while
 * a normal Chrome on the same IP still opened the report (2026-10-22).
 */
const PROFILE_DIR = fileURLToPath(new URL('./.chrome-profile', import.meta.url))
let chrome = null
function getChrome() {
  chrome ??= chromium
    .launchPersistentContext(PROFILE_DIR, {
      channel: 'chrome',
      // Headless is blocked by GIA; the window sits off-screen instead.
      headless: false,
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--disable-blink-features=AutomationControlled',
        '--window-position=-32000,-32000',
        '--window-size=1280,900',
        // Containers give Chrome a tiny /dev/shm, which crashes its pages; no effect on Windows.
        '--disable-dev-shm-usage',
      ],
      viewport: null,
    })
    .then(async (ctx) => {
      ctx.on('close', () => (chrome = null))
      // Only GIA's own documents, scripts and data load - no images, fonts,
      // styles or third-party scripts (analytics, cookie banner). The token then
      // comes in ~1s, and every page load is lighter.
      await ctx.route('**/*', (route) => {
        const req = route.request()
        const skip =
          ['image', 'font', 'media', 'stylesheet'].includes(req.resourceType()) ||
          !/(^|\.)gia\.edu$/.test(new URL(req.url()).hostname)
        return skip ? route.abort() : route.continue()
      })
      return ctx
    })
    .catch((e) => {
      chrome = null
      throw e
    })
  return chrome
}

// At most MAX_AT_ONCE lookups at a time; the rest wait in line. A finishing
// lookup hands its slot straight to the next one, so a new arrival can't slip in between.
let running = 0
const waiting = []
async function limited(fn) {
  if (running < MAX_AT_ONCE) running++
  else await new Promise((resolve) => waiting.push(resolve))
  try {
    return await fn()
  } finally {
    const next = waiting.shift()
    if (next) next()
    else running--
  }
}

// GIA answers a report only for a browser holding its `rdwb-token` cookie (403
// or a bounce to the landing page without it), and its Report Check landing
// page hands that out. Asking rdwb directly from inside a GIA page was tried
// too: refused (302), so every lookup still loads the report page.
const hasToken = async (ctx) => (await ctx.cookies('https://www.gia.edu')).some((c) => c.name === 'rdwb-token')
async function getToken(ctx, page) {
  await ctx.clearCookies({ name: 'rdwb-token' })
  await page.goto('https://www.gia.edu/report-check-landing?locale=en_US', {
    waitUntil: 'domcontentloaded',
    timeout: TIMEOUT_MS,
  })
  const until = Date.now() + 30_000
  while (!(await hasToken(ctx)) && Date.now() < until) await page.waitForTimeout(250)
}

/**
 * GIA's report JSON for a number, null when GIA has none, or 'blocked' when
 * GIA refuses us (Akamai 403 - seen after ~6 quick lookups, 2026-10-22).
 * Throws Playwright's TimeoutError after 60s.
 */
async function lookup(reportNo) {
  const ctx = await getChrome()
  const page = await ctx.newPage()
  // The report's XHR, or 'landing' when GIA sends us to its Report Check search page instead.
  // Listening starts before the page loads, so neither can be missed.
  const open = () =>
    Promise.all([
      Promise.race([
        page.waitForResponse((r) => r.url().includes('rdwb.gia.edu'), { timeout: TIMEOUT_MS }),
        page
          .waitForEvent('framenavigated', {
            predicate: (f) => f.url().includes('report-check-landing'),
            timeout: TIMEOUT_MS,
          })
          .then(() => 'landing'),
      ]),
      page.goto(`https://www.gia.edu/report-check?locale=en_US&reportno=${reportNo}`, {
        waitUntil: 'domcontentloaded',
        timeout: TIMEOUT_MS,
      }),
    ]).then(([res]) => res)
  try {
    // A token first, and a fresh one if GIA refuses the one we have (expired).
    if (!(await hasToken(ctx))) await getToken(ctx, page)
    let res = await open()
    if (res === 'landing' || res.status() === 403) {
      await getToken(ctx, page)
      res = await open()
    }
    if (res === 'landing' || res.status() === 403) {
      console.warn(`GIA blocked ${reportNo}: ${res === 'landing' ? 'sent to the landing page twice' : 'HTTP 403'}`)
      return 'blocked'
    }
    const body = res.ok() ? await res.json().catch(() => null) : null
    if (!body?.REPORT_NUMBER) return null
    delete body.labels
    return body
  } finally {
    await page.close()
  }
}

const sha = (s) => createHash('sha256').update(s).digest()
const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (req.method !== 'GET' || url.pathname !== '/gia') return send(res, 404, { error: 'Not found.' })
  if (TOKEN && !timingSafeEqual(sha(req.headers.authorization ?? ''), sha(`Bearer ${TOKEN}`))) {
    return send(res, 401, { error: 'Wrong or missing token.' })
  }
  const reportNo = url.searchParams.get('reportNo') ?? ''
  if (!/^\d{5,12}$/.test(reportNo)) return send(res, 400, { error: 'GIA number must be 5-12 digits.' })
  if (cache.has(reportNo)) return send(res, 200, cache.get(reportNo))
  const blocked = () => {
    const minutes = Math.ceil((blockedUntil - Date.now()) / 60_000)
    send(res, 503, { error: `GIA is busy. Try again in ${minutes} min.` })
  }
  if (Date.now() < blockedUntil) return blocked()
  try {
    const report = await limited(() => lookup(reportNo))
    if (report === 'blocked') {
      blockedUntil = Date.now() + COOLDOWN_MS
      return blocked()
    }
    if (!report) return send(res, 404, { error: 'No GIA report found. Check the number.' })
    cache.set(reportNo, report)
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
    send(res, 200, report)
  } catch (e) {
    if (e instanceof errors.TimeoutError) {
      return send(res, 504, { error: 'GIA is slow right now. Try again.' })
    }
    console.error(e)
    send(res, 502, { error: 'GIA search failed. Try again.' })
  }
}).listen(PORT, HOST, () => console.log(`GIA lookup service on http://${HOST}:${PORT}/gia?reportNo=`))

// Chrome open and GIA's token in hand before the first search, not during it.
getChrome()
  .then(async (ctx) => {
    if (await hasToken(ctx)) return
    const page = await ctx.newPage()
    await getToken(ctx, page).finally(() => page.close())
  })
  .catch((e) => console.error('Warm-up failed (the first search will retry):', e.message))
