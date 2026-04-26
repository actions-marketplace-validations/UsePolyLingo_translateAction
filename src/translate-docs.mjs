#!/usr/bin/env node
/**
 * Translate repo Markdown under docs/ (English source) via PolyLingo async jobs API.
 * Writes docs/<locale>/README.md, getting-started.md, api-reference.md, sdk-node.md, sdk-python.md
 *
 * Uses POST /v1/jobs (returns 202 immediately) + polls GET /v1/jobs/:id — no HTTP
 * timeout risk regardless of document size.
 *
 * From frontend/:
 *   POLYLINGO_API_KEY=pl_xxx npm run i18n:docs
 * Or set POLYLINGO_API_KEY in frontend/.env.local (same loader as translate-messages.mjs).
 *
 * Optional:
 *   POLYLINGO_LOCALES=es,fr,de      — subset of targets (default: same 29 as marketing messages)
 *   POLYLINGO_DOCS_MISSING_ONLY=1   — only translate locales missing docs/<locale>/*.md
 *   POLYLINGO_DOCS_BATCH=5          — target languages per job (smaller = faster worker turnaround)
 *   POLYLINGO_DOCS_TIMEOUT_MS=600000 — total polling budget per job (default 10 min)
 *   POLYLINGO_POLL_INTERVAL_MS=10000 — how often to poll job status (default 10s)
 *   POLYLINGO_DELAY_MS=200          — optional pause after each file (parallel batches use async jobs; no sync timeout risk)
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import PolyLingo from 'polylingo'
import {
  appendStepSummary,
  applyConfigApiUrl,
  envTruthy,
  loadPolylingoEnvFromRepo,
  loadPolylingoJson,
  parseRootFromArgv,
  resolveDocsDir,
  resolveDocsSourceFiles,
  resolveTargetLocales,
} from './i18n-config.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const { repoRoot, configPath } = parseRootFromArgv(process.argv, __dirname)
loadPolylingoEnvFromRepo(repoRoot)
const fileConfig = loadPolylingoJson(repoRoot, configPath)
applyConfigApiUrl(fileConfig)
const DOCS_DIR = resolveDocsDir(repoRoot, fileConfig)

/** Must match marketing targets in translate-messages.mjs / i18n.ts (excluding en). */
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

const DEFAULT_SOURCE_FILES = [
  'README.md',
  'getting-started.md',
  'api-reference.md',
  'sdk-node.md',
  'sdk-python.md',
]

const SOURCE_FILES = resolveDocsSourceFiles(DOCS_DIR, fileConfig, DEFAULT_SOURCE_FILES)

const API_BASE = (
  process.env.POLYLINGO_API_URL ||
  process.env.NEXT_PUBLIC_API_URL ||
  'https://api.usepolylingo.com/v1'
).replace(/\/$/, '')

const API_KEY = (process.env.POLYLINGO_API_KEY || '').trim()
const DELAY_MS        = parseInt(process.env.POLYLINGO_DELAY_MS        || '0',      10)
const BATCH           = Math.max(1, parseInt(process.env.POLYLINGO_DOCS_BATCH     || '5',      10))
const JOB_TIMEOUT_MS  = parseInt(process.env.POLYLINGO_DOCS_TIMEOUT_MS  || '600000', 10) // 10 min
const POLL_INTERVAL_MS = Math.max(5000, parseInt(process.env.POLYLINGO_POLL_INTERVAL_MS || '10000', 10))

const baseLocales = resolveTargetLocales(fileConfig, DEFAULT_LOCALES)

let TARGET_LOCALES = baseLocales
if (envTruthy('POLYLINGO_DOCS_MISSING_ONLY')) {
  TARGET_LOCALES = baseLocales.filter(localeDocsIncomplete)
}

const CONTINUE_ON_FILE_ERROR =
  envTruthy('POLYLINGO_CONTINUE_ON_FILE_ERROR') ||
  (process.env.POLYLINGO_CONTINUE_ON_FILE_ERROR === undefined &&
    process.env.GITHUB_ACTIONS === 'true')

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

let docsUsageAccumulator = { total_tokens: 0, input_tokens: 0, output_tokens: 0, jobs: 0 }

function addDocsUsage(u) {
  if (!u || typeof u !== 'object') return
  if (typeof u.total_tokens === 'number') docsUsageAccumulator.total_tokens += u.total_tokens
  if (typeof u.input_tokens === 'number') docsUsageAccumulator.input_tokens += u.input_tokens
  if (typeof u.output_tokens === 'number') docsUsageAccumulator.output_tokens += u.output_tokens
  docsUsageAccumulator.jobs++
}

/** True if locale dir is missing or any tracked English doc copy is missing. */
function localeDocsIncomplete(loc) {
  const dir = join(DOCS_DIR, loc)
  if (!existsSync(dir)) return true
  return SOURCE_FILES.some((f) => !existsSync(join(dir, f)))
}

/**
 * English docs use ../ to reach repo root from docs/. Files live under docs/<locale>/,
 * so one extra ../ is required for those links.
 */
function adjustRelativeLinksForLocaleSubfolder(md) {
  return md.replace(/\]\(\.\.\//g, '](../../')
}

const MAX_RETRIES = 4

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

function isInvalidJsonJobError(message) {
  const m = String(message ?? '')
  return /invalid JSON/i.test(m) || /Model returned invalid JSON/i.test(m)
}

/**
 * One locale batch: async job via Node SDK, with retries and JSON split fallback for multi-locale jobs.
 */
async function translateOneBatch(content, targets, label) {
  if (!content?.trim() || targets.length === 0) {
    return { translations: {} }
  }

  if (envTruthy('POLYLINGO_DRY_RUN')) {
    const translations = {}
    for (const t of targets) translations[t] = content
    docsUsageAccumulator.jobs++
    return { translations }
  }

  let lastErr
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await getPolyClient().jobs.translate({
        content,
        targets,
        format: 'markdown',
        source: 'en',
        model: 'standard',
        pollInterval: POLL_INTERVAL_MS,
        timeout: JOB_TIMEOUT_MS,
      })
      addDocsUsage(result.usage)
      return result
    } catch (err) {
      lastErr = err
      const msg = err instanceof Error ? err.message : String(err)
      if (isInvalidJsonJobError(msg) && targets.length > 1) {
        console.warn(`    ${label}invalid JSON — splitting (${targets.join(', ')})`)
        const rows = await Promise.all(
          targets.map((t) =>
            getPolyClient().jobs.translate({
              content,
              targets: [t],
              format: 'markdown',
              source: 'en',
              model: 'standard',
              pollInterval: POLL_INTERVAL_MS,
              timeout: JOB_TIMEOUT_MS,
            }),
          ),
        )
        const translations = {}
        for (const row of rows) {
          addDocsUsage(row.usage)
          Object.assign(translations, row.translations || {})
        }
        return { translations }
      }
      if (attempt < MAX_RETRIES) {
        const delay = 3000 * Math.pow(2, attempt)
        console.warn(`    ${label}(retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms: ${msg})`)
        await sleep(delay)
        continue
      }
    }
  }
  throw lastErr
}

function chunk(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

async function main() {
  const DRY_RUN = envTruthy('POLYLINGO_DRY_RUN')
  if (!API_KEY && !DRY_RUN) {
    console.error('Missing POLYLINGO_API_KEY (env or repo .env.local).')
    process.exit(1)
  }
  if (DRY_RUN) {
    console.log('POLYLINGO_DRY_RUN=1 — stub translations, optional writes skipped.\n')
  }

  if (TARGET_LOCALES.length === 0) {
    console.log('No target locales (all docs present, or empty filter). Nothing to do.')
    process.exit(0)
  }

  console.log(`Repo root: ${repoRoot}`)
  console.log(`Docs dir: ${DOCS_DIR}`)
  console.log(`Source files: ${SOURCE_FILES.join(', ')}`)
  if (envTruthy('POLYLINGO_DOCS_MISSING_ONLY')) {
    console.log(`Missing-only mode: filling ${TARGET_LOCALES.length} locale(s): ${TARGET_LOCALES.join(', ')}`)
  }
  console.log(`Targets: ${TARGET_LOCALES.length} locales, batch size ${BATCH}`)
  console.log(`API: ${API_BASE}/jobs (async — polling every ${POLL_INTERVAL_MS}ms, timeout ${JOB_TIMEOUT_MS}ms)\n`)

  const t0 = Date.now()
  const fileErrors = []
  let filesWritten = 0

  /**
   * Translate one source file into all target locales (all batches submit+poll in parallel).
   * Returns a map of locale → translated markdown.
   */
  async function translateSourceFile(name) {
    const srcPath = join(DOCS_DIR, name)
    if (!existsSync(srcPath)) {
      console.warn(`Skip (missing): ${srcPath}`)
      return null
    }

    const content = readFileSync(srcPath, 'utf8')
    console.log(`\n── ${name} (${content.length} chars) ──`)

    const batches = chunk(TARGET_LOCALES, BATCH)
    for (let idx = 0; idx < batches.length; idx++) {
      const targets = batches[idx]
      console.log(`  ${name} batch ${idx + 1}/${batches.length}: ${targets.join(', ')}`)
    }

    const results = await Promise.all(
      batches.map((targets, idx) =>
        translateOneBatch(
          content,
          targets,
          `${name} batch ${idx + 1}/${batches.length}: `,
        ),
      ),
    )

    /** @type {Record<string, string>} */
    const perLocale = {}
    for (let idx = 0; idx < batches.length; idx++) {
      const targets = batches[idx]
      const data = results[idx]
      const tr = data.translations || {}
      for (const loc of targets) {
        let text = tr[loc]
        if (text == null) {
          throw new Error(`Missing translation for locale "${loc}" in response (${name})`)
        }
        if (typeof text === 'object' && text !== null) {
          text = JSON.stringify(text)
        }
        if (typeof text !== 'string') {
          throw new Error(`Invalid translation type for "${loc}" (${name}): ${typeof text}`)
        }
        perLocale[loc] = adjustRelativeLinksForLocaleSubfolder(text.trim())
      }
    }

    if (DELAY_MS > 0) await sleep(DELAY_MS)

    return { name, perLocale }
  }

  const settled = await Promise.allSettled(SOURCE_FILES.map((f) => translateSourceFile(f)))
  /** @type {{ name: string, perLocale: Record<string, string> }[]} */
  const fileResults = []
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i]
    const fname = SOURCE_FILES[i]
    if (s.status === 'fulfilled') {
      if (s.value) fileResults.push(s.value)
    } else {
      const msg = s.reason instanceof Error ? s.reason.message : String(s.reason)
      console.error(`File "${fname}" failed: ${msg}`)
      fileErrors.push({ file: fname, error: msg })
      if (!CONTINUE_ON_FILE_ERROR) {
        process.exit(1)
      }
    }
  }

  for (const result of fileResults) {
    const { name, perLocale } = result
    for (const loc of TARGET_LOCALES) {
      const dir = join(DOCS_DIR, loc)
      mkdirSync(dir, { recursive: true })
      const outPath = join(dir, name)
      if (DRY_RUN) {
        console.log(`  [dry-run] would write ${outPath}`)
      } else {
        writeFileSync(outPath, `${perLocale[loc]}\n`, 'utf8')
        filesWritten++
        console.log(`  wrote ${outPath}`)
      }
    }
  }

  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1)
  appendStepSummary(`## PolyLingo docs translation`)
  appendStepSummary(
    `| Metric | Value |
| --- | --- |
| Source files | ${SOURCE_FILES.length} |
| Target locales | ${TARGET_LOCALES.length} |
| Output files written | ${filesWritten} |
| Jobs (batches) | ${docsUsageAccumulator.jobs} |
| Tokens (total) | ${docsUsageAccumulator.total_tokens} |
| File failures | ${fileErrors.length} |
| Duration | ${elapsedSec}s |
`,
  )
  if (fileErrors.length) {
    appendStepSummary(
      `### Failures\n${fileErrors.map((e) => `- **${e.file}:** ${e.error}`).join('\n')}`,
    )
  }

  const statsPath = process.env.POLYLINGO_STATS_DOCS
  if (statsPath) {
    writeFileSync(
      statsPath,
      `${JSON.stringify({
        docs_files_written: filesWritten,
        docs_tokens_used: docsUsageAccumulator.total_tokens,
      })}\n`,
      'utf8',
    )
  }

  writeGithubOutputs({
    docs_files_written: String(filesWritten),
    docs_tokens_used: String(docsUsageAccumulator.total_tokens),
  })

  console.log('\nDone. Commit docs/<locale>/*.md and push so GitHub links work.\n')

  if (fileErrors.length) {
    process.exit(1)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
