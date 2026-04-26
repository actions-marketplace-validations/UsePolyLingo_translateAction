#!/usr/bin/env node
/**
 * Regenerate marketing locale files from messages/en.json using PolyLingo's JSON API.
 *
 * Usage:
 *   Unix/macOS: POLYLINGO_API_KEY=pl_xxx npm run i18n:polylingo
 *   PowerShell: $env:POLYLINGO_API_KEY = 'your-key'; npm run i18n:polylingo
 *   Or put POLYLINGO_API_KEY=... in frontend/.env.local (loaded automatically; no export).
 *
 * Prelaunch: if the API has INTERNAL_TRANSLATE_BYPASS_SECRET set, use that value as
 * POLYLINGO_API_KEY instead of a real pl_ key (translate/batch only).
 *
 * Optional:
 *   POLYLINGO_API_URL=https://api.usepolylingo.com/v1   (fallback; else NEXT_PUBLIC_API_URL)
 *   POLYLINGO_LOCALES=es,fr,de                         (override target list)
 *   POLYLINGO_CONCURRENCY=5                            (parallel /translate calls per wave; default 5)
 *   POLYLINGO_LOCALE_CONCURRENCY=3                     (locales translated in parallel; default 1)
 *   POLYLINGO_DELAY_MS=150                             (pause between waves; default 0)
 *   POLYLINGO_DELTA=1                                  (only translate namespaces / home batches that
 *                                                       changed vs .polylingo-en-baseline.json — saves
 *                                                       tokens; merge into existing locale files)
 *   POLYLINGO_FULL=1                                   (ignore delta; full run — also refreshes baseline)
 *
 * Baseline: messages/.polylingo-en-baseline.json is a snapshot of en.json from the last successful run.
 * Commit it with locale files so the team shares the same diff reference.
 *
 * The site locales (see i18n.ts) minus English.
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import PolyLingo, { PolyLingoError } from 'polylingo'
import {
  appendStepSummary,
  applyConfigApiUrl,
  envTruthy,
  loadPolylingoEnvFromRepo,
  loadPolylingoJson,
  parseRootFromArgv,
  resolveMessagesPaths,
  resolveTargetLocales,
} from './i18n-config.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const { repoRoot, configPath } = parseRootFromArgv(process.argv, __dirname)
loadPolylingoEnvFromRepo(repoRoot)
const fileConfig = loadPolylingoJson(repoRoot, configPath)
applyConfigApiUrl(fileConfig)
const { messagesDir: MESSAGES_DIR, enPath: EN_PATH, baselinePath: EN_BASELINE_PATH } =
  resolveMessagesPaths(repoRoot, fileConfig)

/** All marketing locales except English (must match `frontend/i18n.ts`). */
const DEFAULT_LOCALES = [
  'ar',
  'bn',
  'cs',
  'da',
  'de',
  'el',
  'es',
  'fa',
  'fi',
  'fr',
  'he',
  'hi',
  'id',
  'it',
  'ja',
  'ko',
  'ms',
  'nl',
  'no',
  'pl',
  'pt',
  'ru',
  'sv',
  'sw',
  'th',
  'tr',
  'uk',
  'vi',
  'zh',
]

const API_BASE = (
  process.env.POLYLINGO_API_URL ||
  process.env.NEXT_PUBLIC_API_URL ||
  'https://api.usepolylingo.com/v1'
).replace(/\/$/, '')

const API_KEY = (process.env.POLYLINGO_API_KEY || '').trim()
const DELAY_MS = parseInt(process.env.POLYLINGO_DELAY_MS || '0', 10)
const CONCURRENCY = Math.max(1, parseInt(process.env.POLYLINGO_CONCURRENCY || '5', 10))
const LOCALE_CONCURRENCY = Math.max(1, parseInt(process.env.POLYLINGO_LOCALE_CONCURRENCY || '1', 10))

const TARGET_LOCALES = resolveTargetLocales(fileConfig, DEFAULT_LOCALES)

/** In GitHub Actions, continue other locales when one fails unless explicitly disabled. */
const CONTINUE_ON_LOCALE_ERROR =
  envTruthy('POLYLINGO_CONTINUE_ON_LOCALE_ERROR') ||
  (process.env.POLYLINGO_CONTINUE_ON_LOCALE_ERROR === undefined &&
    process.env.GITHUB_ACTIONS === 'true')

let usageAccumulator = { total_tokens: 0, input_tokens: 0, output_tokens: 0, apiCalls: 0 }

function addUsageFromResponse(data) {
  if (!data?.usage || typeof data.usage !== 'object') return
  const u = data.usage
  if (typeof u.total_tokens === 'number') usageAccumulator.total_tokens += u.total_tokens
  if (typeof u.input_tokens === 'number') usageAccumulator.input_tokens += u.input_tokens
  if (typeof u.output_tokens === 'number') usageAccumulator.output_tokens += u.output_tokens
  usageAccumulator.apiCalls++
}

/** Whole { topKey: subtree } must stay under this to avoid model output limits. */
const MAX_WHOLE_CHUNK = 12_000

/** When splitting `home`, max ~JSON size per batch (smaller = fewer 502/timeouts on slow hosts). */
const HOME_BATCH = 4_000

/**
 * When a top-level namespace is a flat string record (e.g. translateJson), split it so each
 * /translate call stays smaller — avoids 500s from huge JSON-in-string fields and model limits.
 */
const NS_BATCH = Math.max(800, parseInt(process.env.POLYLINGO_NS_BATCH || '2200', 10))

const TRANSLATE_RETRIES = Math.max(1, parseInt(process.env.POLYLINGO_RETRIES || '4', 10))
const RETRY_DELAY_MS = parseInt(process.env.POLYLINGO_RETRY_MS || '1500', 10)

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

let polyClient = null
function getPolyClient() {
  if (!polyClient) {
    polyClient = new PolyLingo({ apiKey: API_KEY, baseURL: API_BASE })
  }
  return polyClient
}

function writeGithubOutputs(fields) {
  if (process.env.POLYLINGO_SUPPRESS_ACTION_OUTPUT === '1') return
  const out = process.env.GITHUB_OUTPUT
  if (!out) return
  for (const [k, v] of Object.entries(fields)) {
    const val = v == null ? '' : String(v)
    if (val.includes('\n')) {
      appendFileSync(out, `${k}<<PL_OUT\n${val}\nPL_OUT\n`)
    } else {
      appendFileSync(out, `${k}=${val}\n`)
    }
  }
}

function isFlatStringRecord(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false
  const vals = Object.values(obj)
  return vals.length > 0 && vals.every((v) => typeof v === 'string')
}

async function translateChunk(content, targets) {
  let lastErr
  for (let attempt = 1; attempt <= TRANSLATE_RETRIES; attempt++) {
    try {
      const data = await getPolyClient().translate({
        content,
        format: 'json',
        targets,
        source: 'en',
        model: 'standard',
      })
      addUsageFromResponse(data)
      return data
    } catch (e) {
      const status = e instanceof PolyLingoError ? e.status : 0
      const retryable = status === 500 || status === 502 || status === 503 || status === 504
      lastErr = e instanceof Error ? e : new Error(String(e))
      if (retryable && attempt < TRANSLATE_RETRIES) {
        const wait = RETRY_DELAY_MS * attempt
        console.warn(`    (retry ${attempt}/${TRANSLATE_RETRIES} after ${status} in ${wait}ms)`)
        await sleep(wait)
        continue
      }
      if (status === 429) {
        throw new Error(
          `${lastErr.message}\n\n→ Rate limited or monthly cap. Try fewer locales or upgrade your plan.`,
        )
      }
      throw lastErr
    }
  }
  throw lastErr
}

function unwrapTranslated(value) {
  if (value == null) throw new Error('Missing translation value from API')
  if (typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value === 'string') {
    try {
      return JSON.parse(value.trim())
    } catch (e) {
      throw new Error(`Could not parse translated JSON string: ${e.message}`)
    }
  }
  throw new Error(`Unexpected translation type: ${typeof value}`)
}

/**
 * Models sometimes rename or omit the top-level JSON key; accept single-key payloads
 * or case-insensitive matches so one flaky locale doesn't abort the whole run.
 *
 * @param {string[] | null} fragmentKeys — when chunking a flat namespace, the model may return
 *   the partial `{ key: string, ... }` at the **top level** without a `{ [topKey]: ... }` wrapper;
 *   if `fragmentKeys` is set and keys match, accept `parsed` as the subtree.
 */
function pickNamespaceSubtree(parsed, topKey, label, fragmentKeys = null) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid parsed response for "${topKey}" (${label})`)
  }
  if (Object.prototype.hasOwnProperty.call(parsed, topKey)) {
    return parsed[topKey]
  }
  const keys = Object.keys(parsed)
  const lower = topKey.toLowerCase()
  const ci = keys.find((k) => k.toLowerCase() === lower)
  if (ci) {
    console.warn(`    (warn ${label}: model used key "${ci}"; matched "${topKey}")`)
    return parsed[ci]
  }
  if (keys.length === 1 && typeof parsed[keys[0]] === 'object' && !Array.isArray(parsed[keys[0]])) {
    console.warn(`    (warn ${label}: model used key "${keys[0]}" instead of "${topKey}"; accepting)`)
    return parsed[keys[0]]
  }
  // Chunked flat namespace: model returns fragment keys only (no wrapper object)
  if (fragmentKeys && fragmentKeys.length > 0) {
    const expected = new Set(fragmentKeys)
    const got = new Set(keys)
    if (expected.size === got.size && [...expected].every((k) => got.has(k))) {
      console.warn(`    (warn ${label}: fragment without "${topKey}" wrapper; accepting)`)
      return parsed
    }
  }
  // Final fallback: model returned namespace content directly without the wrapper key.
  // This happens when the API omits the top-level namespace envelope. Accept as-is so
  // one flaky locale doesn't abort the whole run.
  if (keys.length > 0) {
    console.warn(
      `    (warn ${label}: response missing "${topKey}" wrapper (got ${keys.length} key(s): ${keys.slice(0, 5).join(', ')}${keys.length > 5 ? '…' : ''}); accepting content directly)`,
    )
    return parsed
  }
  throw new Error(
    `Response for "${topKey}" missing top-level key; got: ${keys.slice(0, 12).join(', ') || '(empty)'}`,
  )
}

function pickHomeFragment(parsed, partIdx) {
  if (parsed?.home && typeof parsed.home === 'object' && !Array.isArray(parsed.home)) {
    return parsed.home
  }
  const keys = Object.keys(parsed || {})
  if (keys.length === 1 && typeof parsed[keys[0]] === 'object' && !Array.isArray(parsed[keys[0]])) {
    console.warn(`    (warn home part ${partIdx + 1}: model used key "${keys[0]}"; accepting as home)`)
    return parsed[keys[0]]
  }
  throw new Error(`Invalid home partial response (${partIdx + 1})`)
}

/**
 * Split a flat string-record object into batches by approximate JSON size.
 * @param {Record<string, string>} obj
 */
function batchFlatObject(obj, maxApprox) {
  const keys = Object.keys(obj)
  const batches = []
  let batch = {}
  let size = 0

  for (const k of keys) {
    const bit = JSON.stringify({ [k]: obj[k] })
    if (size + bit.length > maxApprox && Object.keys(batch).length) {
      batches.push(batch)
      batch = {}
      size = 0
    }
    batch[k] = obj[k]
    size += bit.length
  }
  if (Object.keys(batch).length) batches.push(batch)
  return batches
}

/**
 * Deep diff for message trees. Paths use dot notation (e.g. home.subTagline).
 */
function diffMessageTrees(oldObj, newObj, prefix = '') {
  const changed = new Set()
  const removed = new Set()

  if (oldObj === newObj) return { changed, removed }

  if (oldObj === undefined || oldObj === null) {
    if (newObj !== undefined && newObj !== null) changed.add(prefix || '(root)')
    return { changed, removed }
  }
  if (newObj === undefined || newObj === null) {
    removed.add(prefix || '(root)')
    return { changed, removed }
  }

  if (typeof oldObj !== typeof newObj || Array.isArray(oldObj) !== Array.isArray(newObj)) {
    changed.add(prefix || '(root)')
    return { changed, removed }
  }

  if (typeof oldObj !== 'object') {
    if (JSON.stringify(oldObj) !== JSON.stringify(newObj)) changed.add(prefix || '(root)')
    return { changed, removed }
  }

  if (Array.isArray(oldObj)) {
    const max = Math.max(oldObj.length, newObj.length)
    for (let i = 0; i < max; i++) {
      const p = prefix ? `${prefix}.${i}` : String(i)
      if (i >= oldObj.length) changed.add(p)
      else if (i >= newObj.length) removed.add(p)
      else {
        const sub = diffMessageTrees(oldObj[i], newObj[i], p)
        sub.changed.forEach((c) => changed.add(c))
        sub.removed.forEach((r) => removed.add(r))
      }
    }
    return { changed, removed }
  }

  const keys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)])
  for (const k of keys) {
    const p = prefix ? `${prefix}.${k}` : k
    if (!(k in oldObj)) changed.add(p)
    else if (!(k in newObj)) removed.add(p)
    else {
      const sub = diffMessageTrees(oldObj[k], newObj[k], p)
      sub.changed.forEach((c) => changed.add(c))
      sub.removed.forEach((r) => removed.add(r))
    }
  }
  return { changed, removed }
}

/** Top-level namespaces that have at least one *changed* path (not removal-only). */
function dirtyTopForTranslate(changed) {
  const s = new Set()
  for (const p of changed) {
    const top = p.split('.')[0]
    if (top && top !== '(root)') s.add(top)
  }
  return s
}

/** First-level keys under `home` that appear in *changed* paths (for partial home batches). */
function dirtyHomeFirstLevelFromChanged(changed) {
  const s = new Set()
  for (const p of changed) {
    if (!p.startsWith('home.')) continue
    const rest = p.slice(5)
    const first = rest.split('.')[0]
    if (first) s.add(first)
  }
  return s
}

/**
 * Keep only keys that exist in `template` (recursively). Drops removed keys from locale files.
 */
function pruneToEnStructure(template, merged) {
  if (template === null || typeof template !== 'object' || Array.isArray(template)) return merged
  if (merged === null || typeof merged !== 'object' || Array.isArray(merged)) return merged
  const out = {}
  for (const k of Object.keys(template)) {
    if (!(k in merged)) continue
    if (typeof template[k] === 'object' && template[k] !== null && !Array.isArray(template[k])) {
      out[k] = pruneToEnStructure(template[k], merged[k] || {})
    } else {
      out[k] = merged[k]
    }
  }
  return out
}

/**
 * Recursively merge `updates` into `base`, preserving any keys in `base` that
 * are absent from `updates` (guards against model truncation dropping sub-namespaces).
 */
function deepMergeObjects(base, updates) {
  const result = { ...base }
  for (const k of Object.keys(updates)) {
    if (
      updates[k] &&
      typeof updates[k] === 'object' &&
      !Array.isArray(updates[k]) &&
      result[k] &&
      typeof result[k] === 'object' &&
      !Array.isArray(result[k])
    ) {
      result[k] = deepMergeObjects(result[k], updates[k])
    } else {
      result[k] = updates[k]
    }
  }
  return result
}

function mergeDeltaIntoExisting(existing, fromJobs) {
  const out = { ...existing }
  for (const k of Object.keys(fromJobs)) {
    const incoming = fromJobs[k]
    const current  = existing[k]
    if (
      incoming &&
      typeof incoming === 'object' &&
      !Array.isArray(incoming) &&
      current &&
      typeof current === 'object' &&
      !Array.isArray(current)
    ) {
      // Deep-merge so model truncation can't silently drop sub-namespaces (e.g. app.keys)
      out[k] = deepMergeObjects(current, incoming)
    } else {
      out[k] = incoming
    }
  }
  return out
}

/**
 * Build independent translation jobs for one target locale (order preserved for merge).
 * @param {object} [options]
 * @param {Set<string>|null} [options.topKeyFilter] — only these top-level keys; null = all
 * @param {'all'|'skip'|'partial'} [options.homeMode]
 * @param {Set<string>|null} [options.homeFirstKeys] — when homeMode is 'partial', only batches that touch these first-level keys under `home`
 * @returns {{ label: string, run: () => Promise<{ kind: 'home', fragment: object } | { kind: 'ns', key: string, value: unknown }> }[]}
 */
function buildJobs(en, locale, topKeys, options = {}) {
  const { topKeyFilter = null, homeMode = 'all', homeFirstKeys = null } = options

  const keysToIterate = topKeyFilter ? topKeys.filter((k) => topKeyFilter.has(k)) : topKeys

  /** @type {{ label: string, run: () => Promise<{ kind: 'home', fragment: object } | { kind: 'ns', key: string, value: unknown }> }[]} */
  const jobs = []

  for (const topKey of keysToIterate) {
    const value = en[topKey]
    const wrapped = { [topKey]: value }
    const sz = JSON.stringify(wrapped).length

    if (topKey === 'home' && value && typeof value === 'object' && !Array.isArray(value)) {
      if (homeMode === 'skip') continue

      const parts = batchFlatObject(value, HOME_BATCH)
      parts.forEach((part, partIdx) => {
        if (homeMode === 'partial' && homeFirstKeys && homeFirstKeys.size > 0) {
          const partKeys = Object.keys(part)
          const intersects = partKeys.some((k) => homeFirstKeys.has(k))
          if (!intersects) return
        }
        jobs.push({
          label: `home part ${partIdx + 1}/${parts.length} (${Object.keys(part).length} keys)`,
          run: async () => {
            const data = await translateChunk(JSON.stringify({ home: part }), [locale])
            const parsed = unwrapTranslated(data.translations[locale])
            const fragment = pickHomeFragment(parsed, partIdx)
            return { kind: 'home', fragment }
          },
        })
      })
    } else if (sz <= MAX_WHOLE_CHUNK) {
      const flatChunk =
        topKey !== 'home' &&
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        isFlatStringRecord(value)
      const nsParts = flatChunk ? batchFlatObject(value, NS_BATCH) : null

      if (flatChunk && nsParts && nsParts.length > 1) {
        nsParts.forEach((part, partIdx) => {
          jobs.push({
            label: `${topKey} part ${partIdx + 1}/${nsParts.length} (${Object.keys(part).length} keys)`,
            run: async () => {
              const data = await translateChunk(JSON.stringify({ [topKey]: part }), [locale])
              const parsed = unwrapTranslated(data.translations[locale])
              const fragment = pickNamespaceSubtree(
                parsed,
                topKey,
                `${topKey} part ${partIdx + 1}`,
                Object.keys(part),
              )
              return { kind: 'ns', key: topKey, value: fragment }
            },
          })
        })
      } else {
        jobs.push({
          label: `${topKey} (${sz}B)`,
          run: async () => {
            const data = await translateChunk(JSON.stringify(wrapped), [locale])
            const parsed = unwrapTranslated(data.translations[locale])
            const flatKeys = isFlatStringRecord(value) ? Object.keys(value) : null
            const subtree = pickNamespaceSubtree(parsed, topKey, topKey, flatKeys)
            return { kind: 'ns', key: topKey, value: subtree }
          },
        })
      }
    } else {
      throw new Error(
        `Namespace "${topKey}" is ${sz} bytes — larger than MAX_WHOLE_CHUNK (${MAX_WHOLE_CHUNK}). Extend the script to chunk this namespace.`,
      )
    }
  }

  return jobs
}

/**
 * Merge job results in stable order (same order as jobs array).
 */
function mergeJobResults(results) {
  /** @type {Record<string, unknown>} */
  const merged = {}
  for (const r of results) {
    if (r.kind === 'home') {
      if (!merged.home) merged.home = {}
      Object.assign(merged.home, r.fragment)
    } else {
      const k = r.key
      const v = r.value
      if (
        merged[k] &&
        typeof merged[k] === 'object' &&
        !Array.isArray(merged[k]) &&
        v &&
        typeof v === 'object' &&
        !Array.isArray(v)
      ) {
        Object.assign(merged[k], v)
      } else {
        merged[k] = v
      }
    }
  }
  return merged
}

/**
 * Run jobs in waves of CONCURRENCY parallel requests (faster than sequential).
 */
async function runJobsInWaves(jobs) {
  const results = []
  const total = jobs.length

  for (let i = 0; i < total; i += CONCURRENCY) {
    const wave = jobs.slice(i, i + CONCURRENCY)
    const waveIdx = i
    const waveResults = await Promise.all(
      wave.map(async (job, j) => {
        const n = waveIdx + j + 1
        try {
          const out = await job.run()
          console.log(`    [${n}/${total}] ${job.label} ok`)
          return out
        } catch (e) {
          console.error(`    [${n}/${total}] ${job.label} FAILED`)
          throw e
        }
      }),
    )
    results.push(...waveResults)
    if (DELAY_MS > 0 && i + CONCURRENCY < total) {
      await sleep(DELAY_MS)
    }
  }

  return results
}

function readLocaleJson(locale) {
  const p = join(MESSAGES_DIR, `${locale}.json`)
  if (!existsSync(p)) return {}
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return {}
  }
}

function writeBaseline(en) {
  writeFileSync(EN_BASELINE_PATH, `${JSON.stringify(en, null, 2)}\n`, 'utf8')
  console.log(`  → baseline ${EN_BASELINE_PATH} (snapshot of en.json for next POLYLINGO_DELTA run)\n`)
}

async function main() {
  const DRY_RUN = envTruthy('POLYLINGO_DRY_RUN')
  if (!API_KEY && !DRY_RUN) {
    if (process.env.GITHUB_ACTIONS === 'true') {
      console.error(
        'Missing POLYLINGO_API_KEY. Add repository secret POLYLINGO_API_KEY: Settings → Secrets and variables → Actions → New repository secret. ' +
          'See frontend/MARKETING_I18N.md (dogfooding checklist).',
      )
    } else {
      console.error('Missing POLYLINGO_API_KEY. Create a key in the dashboard and export it, or add it to frontend/.env.local.')
    }
    process.exit(1)
  }
  if (DRY_RUN) {
    console.log('POLYLINGO_DRY_RUN=1 — no API calls and no file writes; plan only.\n')
  }

  const en = JSON.parse(readFileSync(EN_PATH, 'utf8'))
  const topKeys = Object.keys(en)

  const deltaRequested = envTruthy('POLYLINGO_DELTA')
  const forceFull = envTruthy('POLYLINGO_FULL')
  const deltaMode = deltaRequested && !forceFull

  let baseline = null
  if (deltaMode && existsSync(EN_BASELINE_PATH)) {
    try {
      baseline = JSON.parse(readFileSync(EN_BASELINE_PATH, 'utf8'))
    } catch (e) {
      console.warn('Could not read .polylingo-en-baseline.json — falling back to full run.\n')
    }
  }

  /** @type {{ topKeyFilter: Set<string> | null, buildOptions: object, deltaMerge: boolean, pruneOnly: boolean }} */
  let plan = {
    topKeyFilter: null,
    buildOptions: {},
    deltaMerge: false,
    pruneOnly: false,
  }

  if (deltaMode && baseline) {
    const { changed, removed } = diffMessageTrees(baseline, en)
    if (changed.size === 0 && removed.size === 0) {
      console.log('POLYLINGO_DELTA: no changes vs .polylingo-en-baseline.json — nothing to do.')
      process.exit(0)
    }

    if (changed.size === 0 && removed.size > 0) {
      console.log(`POLYLINGO_DELTA: removals only (${removed.size} path(s)) — pruning locale files, no API calls.\n`)
      plan = { topKeyFilter: null, buildOptions: {}, deltaMerge: true, pruneOnly: true }
    } else {
      let dirtyTranslate = dirtyTopForTranslate(changed)
      console.log(`POLYLINGO_DELTA: ${changed.size} changed, ${removed.size} removed path(s)`)
      let forceFullHome = false
      if (changed.size > 0 && dirtyTranslate.size === 0) {
        console.warn(
          '  (could not map changed paths to top-level namespaces — falling back to full translate for safety)',
        )
        dirtyTranslate = new Set(topKeys)
        forceFullHome = true
      }
      console.log(`  translate namespaces: ${[...dirtyTranslate].join(', ') || '(none)'}`)

      const homeChangedKeys = dirtyHomeFirstLevelFromChanged(changed)
      let homeMode = 'all'
      let homeFirstKeys = null
      if (dirtyTranslate.has('home')) {
        if (forceFullHome || homeChangedKeys.size === 0) {
          homeMode = 'all'
          console.log('  home: full namespace (all batches)')
        } else {
          homeMode = 'partial'
          homeFirstKeys = homeChangedKeys
          console.log(
            `  home: partial — ${homeChangedKeys.size} first-level key(s): ${[...homeChangedKeys].slice(0, 12).join(', ')}${homeChangedKeys.size > 12 ? '…' : ''}`,
          )
        }
      }

      plan = {
        topKeyFilter: dirtyTranslate,
        buildOptions: { topKeyFilter: dirtyTranslate, homeMode, homeFirstKeys },
        deltaMerge: true,
        pruneOnly: false,
      }
    }
  } else {
    if (deltaMode && !baseline) {
      console.log('POLYLINGO_DELTA: no baseline file — full run (creates .polylingo-en-baseline.json).\n')
    }
    plan = {
      topKeyFilter: null,
      buildOptions: {},
      deltaMerge: false,
      pruneOnly: false,
    }
  }

  console.log(`API: ${API_BASE}`)
  console.log(`Targets: ${TARGET_LOCALES.join(', ')}`)
  console.log(`Mode: ${plan.pruneOnly ? 'prune-only' : plan.deltaMerge ? 'delta' : 'full'}`)
  console.log(`Concurrency: ${CONCURRENCY} API calls/wave · ${LOCALE_CONCURRENCY} locale(s) in parallel`)
  console.log(`Repo root: ${repoRoot}`)
  console.log(`Source: ${EN_PATH}\n`)

  let filesWritten = 0
  const localeErrors = []
  const localesSucceeded = []
  const t0 = Date.now()

  /**
   * Process a single locale — extracted so it can run concurrently with other locales.
   * All file writes are locale-isolated so parallel execution is safe.
   */
  async function processLocale(locale) {
    console.log(`━━ Locale: ${locale} ━━`)

    if (plan.pruneOnly) {
      const existing = readLocaleJson(locale)
      const pruned = pruneToEnStructure(en, existing)
      const outPath = join(MESSAGES_DIR, `${locale}.json`)
      if (DRY_RUN) {
        console.log(`  [dry-run] would prune/write ${outPath}\n`)
      } else {
        writeFileSync(outPath, `${JSON.stringify(pruned, null, 2)}\n`, 'utf8')
        filesWritten++
        console.log(`  → pruned ${outPath}\n`)
      }
      return
    }

    const jobs = buildJobs(en, locale, topKeys, plan.buildOptions)
    console.log(`    ${jobs.length} API calls (parallel waves of ${CONCURRENCY})`)

    if (jobs.length === 0) {
      const existing = readLocaleJson(locale)
      const pruned = pruneToEnStructure(en, existing)
      const outPath = join(MESSAGES_DIR, `${locale}.json`)
      if (DRY_RUN) {
        console.log(`  [dry-run] would prune/write ${outPath}\n`)
      } else {
        writeFileSync(outPath, `${JSON.stringify(pruned, null, 2)}\n`, 'utf8')
        filesWritten++
        console.log(`  → no translate jobs; pruned ${outPath}\n`)
      }
      return
    }

    if (DRY_RUN) {
      console.log(`  [dry-run] would run ${jobs.length} API call(s); skipping.\n`)
      return
    }

    const results = await runJobsInWaves(jobs)
    let merged = mergeJobResults(results)

    if (plan.deltaMerge) {
      const existing = readLocaleJson(locale)
      merged = mergeDeltaIntoExisting(existing, merged)
    }

    merged = pruneToEnStructure(en, merged)

    const outPath = join(MESSAGES_DIR, `${locale}.json`)
    writeFileSync(outPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
    filesWritten++
    console.log(`  → wrote ${outPath}\n`)
  }

  async function processLocaleSafe(locale) {
    try {
      await processLocale(locale)
      localesSucceeded.push(locale)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`Locale "${locale}" failed: ${msg}`)
      localeErrors.push({ locale, error: msg })
      if (!CONTINUE_ON_LOCALE_ERROR) throw err
    }
  }

  // Run locales in waves of LOCALE_CONCURRENCY (default 1 = sequential, set >1 in CI to speed up).
  for (let i = 0; i < TARGET_LOCALES.length; i += LOCALE_CONCURRENCY) {
    const wave = TARGET_LOCALES.slice(i, i + LOCALE_CONCURRENCY)
    await Promise.all(wave.map(processLocaleSafe))
  }

  if (!DRY_RUN) {
    writeBaseline(en)
  } else {
    console.log('[dry-run] would refresh baseline at ' + EN_BASELINE_PATH)
  }

  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1)
  appendStepSummary(`## PolyLingo message translation`)
  appendStepSummary(
    `| Metric | Value |
| --- | --- |
| Mode | ${plan.pruneOnly ? 'prune-only' : plan.deltaMerge ? 'delta' : 'full'} |
| Locales OK | ${localesSucceeded.length} |
| Locales failed | ${localeErrors.length} |
| Files written | ${filesWritten} |
| API calls (translate) | ${usageAccumulator.apiCalls} |
| Tokens (total) | ${usageAccumulator.total_tokens} |
| Duration | ${elapsedSec}s |
`,
  )
  if (localeErrors.length) {
    appendStepSummary(`### Failures\n${localeErrors.map((e) => `- **${e.locale}:** ${e.error}`).join('\n')}`)
  }

  const statsPayload = {
    locales_translated: localesSucceeded.join(','),
    files_changed: filesWritten,
    tokens_used: usageAccumulator.total_tokens,
  }
  const statsPath = process.env.POLYLINGO_STATS_MESSAGES
  if (statsPath) {
    writeFileSync(statsPath, `${JSON.stringify(statsPayload)}\n`, 'utf8')
  }

  writeGithubOutputs({
    locales_translated: statsPayload.locales_translated,
    files_changed: String(statsPayload.files_changed),
    tokens_used: String(statsPayload.tokens_used),
  })

  console.log('Done. Review diffs, then commit the updated messages/*.json files and .polylingo-en-baseline.json.')

  if (localeErrors.length) {
    console.error(`\n${localeErrors.length} locale(s) failed.`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
