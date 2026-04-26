/**
 * Shared path/config helpers for translate-messages.mjs and translate-docs.mjs.
 */
import { readFileSync, existsSync, appendFileSync, readdirSync } from 'fs'
import { join, resolve } from 'path'

/**
 * @param {string[]} argv
 * @param {string} scriptDir __dirname of the caller (…/src in this action repo)
 */
export function parseRootFromArgv(argv, scriptDir) {
  const defaultRoot = resolve(join(scriptDir, '..'))
  let root = process.env.POLYLINGO_ROOT || process.env.REPO_ROOT || process.env.GITHUB_WORKSPACE || null
  let configPath = process.env.POLYLINGO_CONFIG || null
  const args = argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--root' && args[i + 1]) {
      root = resolve(args[++i])
      continue
    }
    if (a.startsWith('--root=')) {
      root = resolve(a.slice('--root='.length))
      continue
    }
    if (a === '--config' && args[i + 1]) {
      configPath = resolve(args[++i])
      continue
    }
    if (a.startsWith('--config=')) {
      configPath = resolve(a.slice('--config='.length))
      continue
    }
  }
  if (!root) root = defaultRoot
  return { repoRoot: resolve(root), configPath }
}

/**
 * Load POLYLINGO_* and NEXT_PUBLIC_API_URL from repo-root and frontend/.env.local (first wins if already in process.env).
 * @param {string} repoRoot
 */
export function loadPolylingoEnvFromRepo(repoRoot) {
  for (const rel of ['frontend/.env.local', '.env.local']) {
    const p = join(repoRoot, rel)
    if (!existsSync(p)) continue
    const text = readFileSync(p, 'utf8')
    for (const line of text.split(/\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      const key = trimmed.slice(0, eq).trim()
      if (!key.startsWith('POLYLINGO_') && key !== 'NEXT_PUBLIC_API_URL') continue
      if (process.env[key]) continue
      let val = trimmed.slice(eq + 1).trim()
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1)
      }
      process.env[key] = val
    }
  }
}

/**
 * @param {string} repoRoot
 * @param {string | null} explicitConfigPath
 */
export function loadPolylingoJson(repoRoot, explicitConfigPath) {
  const p = explicitConfigPath || join(repoRoot, '.polylingo.json')
  if (!existsSync(p)) return {}
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return {}
  }
}

/**
 * Apply optional apiUrl / base URL from config when env is unset.
 * @param {Record<string, unknown>} fileConfig
 */
export function applyConfigApiUrl(fileConfig) {
  const url =
    (typeof fileConfig.apiUrl === 'string' && fileConfig.apiUrl) ||
    (typeof fileConfig.apiURL === 'string' && fileConfig.apiURL) ||
    (typeof fileConfig.baseURL === 'string' && fileConfig.baseURL) ||
    null
  if (url && !process.env.POLYLINGO_API_URL) {
    process.env.POLYLINGO_API_URL = url.replace(/\/$/, '')
  }
}

/**
 * @param {string} repoRoot
 * @param {Record<string, unknown>} fileConfig
 */
export function resolveMessagesPaths(repoRoot, fileConfig) {
  const absDir = process.env.POLYLINGO_MESSAGES_DIR
  const relDir =
    (typeof fileConfig.messagesDir === 'string' && fileConfig.messagesDir) ||
    process.env.POLYLINGO_MESSAGES_DIR_REL ||
    'frontend/messages'
  const messagesDir = absDir ? resolve(absDir) : join(repoRoot, relDir)

  const sourceRel =
    (typeof fileConfig.sourceFile === 'string' && fileConfig.sourceFile) ||
    process.env.POLYLINGO_SOURCE_FILE ||
    null
  const enPath = sourceRel ? join(repoRoot, sourceRel) : join(messagesDir, 'en.json')

  const baselineRel =
    (typeof fileConfig.baselineFile === 'string' && fileConfig.baselineFile) ||
    process.env.POLYLINGO_BASELINE_FILE ||
    null
  const baselinePath = baselineRel
    ? join(repoRoot, baselineRel)
    : join(messagesDir, '.polylingo-en-baseline.json')

  return { messagesDir, enPath, baselinePath }
}

/**
 * @param {string} repoRoot
 * @param {Record<string, unknown>} fileConfig
 */
export function resolveDocsDir(repoRoot, fileConfig) {
  const abs = process.env.POLYLINGO_DOCS_DIR
  const rel =
    (typeof fileConfig.docsDir === 'string' && fileConfig.docsDir) ||
    process.env.POLYLINGO_DOCS_DIR_REL ||
    'docs'
  return abs ? resolve(abs) : join(repoRoot, rel)
}

/**
 * Resolve list of Markdown filenames under docs root (English sources).
 * @param {string} docsDir
 * @param {Record<string, unknown>} fileConfig
 * @param {string[]} defaultFiles
 */
export function resolveDocsSourceFiles(docsDir, fileConfig, defaultFiles) {
  const envList = process.env.POLYLINGO_DOCS_SOURCE_FILES
  if (envList && envList.trim()) {
    return parseDocsFileList(envList.trim(), docsDir, defaultFiles)
  }
  const fromCfg = fileConfig.docsSourceFiles
  if (Array.isArray(fromCfg)) {
    return fromCfg.map(String).filter(Boolean)
  }
  if (typeof fromCfg === 'string') {
    return parseDocsFileList(fromCfg.trim(), docsDir, defaultFiles)
  }
  return [...defaultFiles]
}

/**
 * @param {string} spec comma-list or "*.md"
 * @param {string} docsDir
 * @param {string[]} defaultFiles
 */
function parseDocsFileList(spec, docsDir, defaultFiles) {
  if (spec === '*.md' || spec === '**/*.md') {
    if (!existsSync(docsDir)) return [...defaultFiles]
    return readdirSync(docsDir)
      .filter((f) => f.endsWith('.md') && !f.startsWith('.'))
      .sort()
  }
  return spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Locales from config if POLYLINGO_LOCALES unset.
 * @param {Record<string, unknown>} fileConfig
 * @param {string[]} defaultLocales
 */
export function resolveTargetLocales(fileConfig, defaultLocales) {
  if (process.env.POLYLINGO_LOCALES && process.env.POLYLINGO_LOCALES.trim()) {
    return process.env.POLYLINGO_LOCALES.split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  const c = fileConfig.locales
  if (Array.isArray(c)) {
    return c.map(String).filter(Boolean)
  }
  return [...defaultLocales]
}

export function envTruthy(name) {
  const v = process.env[name]?.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}

/**
 * @param {string} markdown
 */
export function appendStepSummary(markdown) {
  const f = process.env.GITHUB_STEP_SUMMARY
  if (!f) return
  try {
    appendFileSync(f, `${markdown}\n`, 'utf8')
  } catch {
    /* ignore */
  }
}
