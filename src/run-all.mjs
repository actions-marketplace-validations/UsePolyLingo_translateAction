#!/usr/bin/env node
/**
 * Run translate-messages.mjs then optionally translate-docs.mjs; merge stats into $GITHUB_OUTPUT.
 */
import { readFileSync, unlinkSync, existsSync, appendFileSync } from 'fs'
import { spawnSync } from 'child_process'
import { randomBytes } from 'crypto'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const node = process.execPath

function writeGithubOutputs(fields) {
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

function runScript(rel, extraEnv) {
  const env = { ...process.env, ...extraEnv }
  const r = spawnSync(node, [join(__dirname, rel)], { env, stdio: 'inherit' })
  return r.status ?? 1
}

const withDocs =
  process.env.INPUT_WITH_DOCS !== 'false' && process.env.INPUT_WITH_DOCS !== '0'

const withMessages =
  process.env.INPUT_WITH_MESSAGES !== 'false' && process.env.INPUT_WITH_MESSAGES !== '0'

if (!withMessages && !withDocs) {
  console.error('Nothing to do: set with_messages and/or with_docs.')
  process.exit(1)
}

const msgStats = join(tmpdir(), `pl-msg-${randomBytes(8).toString('hex')}.json`)
const docStats = join(tmpdir(), `pl-doc-${randomBytes(8).toString('hex')}.json`)

let code = 0
if (withMessages) {
  code = runScript('translate-messages.mjs', {
    POLYLINGO_SUPPRESS_ACTION_OUTPUT: '1',
    POLYLINGO_STATS_MESSAGES: msgStats,
  })
  if (code !== 0) {
    try {
      unlinkSync(msgStats)
    } catch {
      /* ignore */
    }
    process.exit(code)
  }
}

if (withDocs) {
  code = runScript('translate-docs.mjs', {
    POLYLINGO_SUPPRESS_ACTION_OUTPUT: '1',
    POLYLINGO_STATS_DOCS: docStats,
  })
  if (code !== 0) {
    try {
      unlinkSync(msgStats)
      unlinkSync(docStats)
    } catch {
      /* ignore */
    }
    process.exit(code)
  }
}

/** @type {{ locales_translated?: string, files_changed?: number, tokens_used?: number }} */
let m = {}
/** @type {{ docs_files_written?: number, docs_tokens_used?: number }} */
let d = {}
try {
  if (existsSync(msgStats)) {
    m = JSON.parse(readFileSync(msgStats, 'utf8'))
    unlinkSync(msgStats)
  }
} catch {
  /* ignore */
}
try {
  if (existsSync(docStats)) {
    d = JSON.parse(readFileSync(docStats, 'utf8'))
    unlinkSync(docStats)
  }
} catch {
  /* ignore */
}

const filesChanged = (m.files_changed || 0) + (d.docs_files_written || 0)
const tokensUsed = (m.tokens_used || 0) + (d.docs_tokens_used || 0)

writeGithubOutputs({
  locales_translated: m.locales_translated || '',
  files_changed: String(filesChanged),
  tokens_used: String(tokensUsed),
})
