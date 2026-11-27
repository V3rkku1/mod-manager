// Launcher-X built in (port of github.com/V3rkku1/launcher-x Core.cs): git clone / pull / build / run projects in their own PowerShell console.
// Skipped: Launcher-X's self-update (Mod Manager updates itself) and its WinForms UI.
const fs = require('fs'), path = require('path'), os = require('os')
const { execFile, spawn } = require('child_process')

const defaults = root => ({
  enabled: false, name: 'GTA 6', root: path.join(root, 'projects'), game: '', autoUpdate: true,
  projects: [
    { name: 'VIctory-Belobug-AMD', repo: 'https://github.com/Belobug/VIctory-Belobug-AMD', branch: 'a-publier',
      build: ['cargo build --locked --profile diag -p victory --features diagnostics'], run: ".\\scripts\\play.ps1 -Exe '{game}'" },
    { name: 'VIctory-NVIDIA', repo: 'https://github.com/trustno1-coder/VIctory-NVIDIA', branch: 'main',
      build: ['if (!(Test-Path victory.toml)) { Copy-Item victory.example.toml victory.toml }', '.\\Get-NVIDIA-DLSS.cmd'], run: ".\\scripts\\play-nvidia.ps1 -Exe '{game}'",
      // `victory preload <game folder>`: every shader + the loading pipelines, ahead of the first start (its README / play-foxhound.ps1 -Preload).
      shaders: ['cargo build --release --locked -p victory', ".\\target\\release\\victory.exe preload ([IO.Path]::GetDirectoryName('{game}'))"] },
    { name: 'VIctory-DexNom', repo: 'https://github.com/DexNom/VIctory', branch: 'main',
      build: ['.\\Initialize-FormatTables.ps1', 'cargo build --locked --release -p victory --features diagnostics --bins'], run: ".\\target\\release\\victory-play.exe '{game}'",
      shaders: [".\\target\\release\\victory-warm.exe '{game}'"] }, // its README: "To warm the shader cache, open victory-warm.exe"
    { name: 'kelvaroq', repo: 'https://github.com/stellarr-studio/kelvaroq', branch: 'main',
      build: ['cargo build --release --locked', 'python scripts/build_native.py'], run: '.\\target\\release\\kelvaroq.exe' },
  ],
})

const Q = s => "'" + String(s ?? '').replace(/'/g, "''") + "'"
const NAME = /^[\w.-]{1,80}$/

// PowerShell job script. Steps: update, build, force, run. Clone always happens if missing. Same text as Launcher-X's Core.Script.
function script(c, p, steps) {
  const dir = path.join(c.root, p.name), mark = dir + '.built'
  const o = [
    'function X { if ($LASTEXITCODE) { throw "Step failed, exit code $LASTEXITCODE" } }',
    "$ErrorActionPreference = 'Stop'",
    `New-Item -ItemType Directory -Force ${Q(c.root)} | Out-Null`,
    `if (!(Test-Path ${Q(path.join(dir, '.git'))})) { git clone --recurse-submodules -b ${Q(p.branch || 'main')} ${Q(p.repo)} ${Q(dir)}; X }`,
    `Set-Location ${Q(dir)}`,
  ]
  if (steps.includes('update')) o.push('git pull --ff-only --recurse-submodules; X')
  if (steps.includes('build')) {
    o.push(`if (${steps.includes('force') ? '$true' : `(git rev-parse HEAD) -ne (Get-Content ${Q(mark)} -ErrorAction SilentlyContinue)`}) {`)
    for (const b of p.build || []) o.push(`  ${b}; X`)
    o.push(`  git rev-parse HEAD | Set-Content ${Q(mark)}`, '}')
  }
  const game = cmd => cmd.replace(/\{game\}/g, String(c.game || '').replace(/'/g, "''"))
  // Shader prep: the project's own warm-up/preload commands, so the first start doesn't stutter while pipelines compile.
  if (steps.includes('shaders')) for (const cmd of p.shaders || []) o.push(`${game(cmd)}; X`)
  if (steps.includes('run') && p.run) o.push(game(p.run))
  return o.join('\n')
}

const git = args => new Promise(ok => execFile('git', args, { windowsHide: true, timeout: 30e3, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
  (e, out) => ok(e?.code === 'ENOENT' ? null : (out || '').trim())))

module.exports = dataDir => {
  const file = path.join(dataDir, 'launcherx.json')
  const load = () => {
    const d = defaults(dataDir)
    let c; try { c = { ...d, ...JSON.parse(fs.readFileSync(file, 'utf8')) } } catch { return d }
    for (const p of c.projects) if (!p.shaders) p.shaders = d.projects.find(x => x.name === p.name)?.shaders || [] // saved before shader prep existed
    return c
  }
  const save = c => (fs.mkdirSync(dataDir, { recursive: true }), fs.writeFileSync(file, JSON.stringify(c, null, 1)), c)
  const find = (c, name) => c.projects.find(p => p.name === name) || (() => { throw new Error(`No project ${name}`) })()
  const clean = p => {
    const name = String(p.name || '').trim(), repo = String(p.repo || '').trim().replace(/\/$/, '')
    if (!NAME.test(name)) throw new Error('Project name: letters, numbers, . _ - only')
    if (!/^(https:\/\/|git@|[A-Za-z]:\\|\/)/.test(repo)) throw new Error('Repository must be a git URL')
    const lines = v => (Array.isArray(v) ? v : String(v || '').split(/\r?\n/)).map(s => s.trim()).filter(Boolean)
    return { name, repo, branch: String(p.branch || 'main').trim() || 'main', build: lines(p.build), shaders: lines(p.shaders), run: String(p.run || '').trim() }
  }
  return {
    script, Q,
    lxConfig: load,
    lxSave: patch => {
      const c = load()
      if ('root' in patch && patch.root) c.root = String(patch.root)
      if ('game' in patch) c.game = String(patch.game || '')
      if ('autoUpdate' in patch) c.autoUpdate = !!patch.autoUpdate
      if (patch.name?.trim()) c.name = String(patch.name).trim().slice(0, 40)
      if ('enabled' in patch) c.enabled = !!patch.enabled // shown in the left bar (added with + > Recomps)
      return save(c)
    },
    // Add or replace (by `was`, the old name) a project.
    lxPut: (p, was) => {
      const c = load(), n = clean(p)
      if (c.projects.some(x => x.name === n.name && x.name !== was)) throw new Error(`${n.name} already exists`)
      const i = c.projects.findIndex(x => x.name === (was || n.name))
      i >= 0 ? c.projects.splice(i, 1, n) : c.projects.push(n)
      return save(c)
    },
    lxRemove: (name, deleteFiles) => {
      const c = load(), p = find(c, name), dir = path.join(c.root, p.name)
      if (deleteFiles) { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(dir + '.built', { force: true }) } // rmSync handles read-only git objects
      c.projects = c.projects.filter(x => x !== p)
      return save(c)
    },
    lxStatus: async name => {
      const c = load(), p = find(c, name), dir = path.join(c.root, p.name)
      if (!fs.existsSync(path.join(dir, '.git'))) return 'Not installed'
      const head = await git(['-C', dir, 'rev-parse', 'HEAD'])
      if (head === null) return 'git missing'
      const remote = ((await git(['ls-remote', p.repo, `refs/heads/${p.branch}`])) || '').split('\t')[0]
      const s = !remote ? 'Offline' : remote !== head ? 'Update available' : 'Up to date'
      const built = fs.existsSync(dir + '.built') ? fs.readFileSync(dir + '.built', 'utf8').trim() : ''
      return built === head ? s : s + ', not built'
    },
    // Launch = update (if auto-update) + build if changed + run. Opens its own PowerShell console like Launcher-X.
    lxRun: (name, steps) => {
      if (process.platform !== 'win32') throw new Error('Launcher-X projects run on Windows')
      const c = load(), p = find(c, name)
      const needsGame = steps === 'launch' ? (p.run || '').includes('{game}') : steps.includes?.('shaders') && (p.shaders || []).some(x => x.includes('{game}'))
      if (needsGame && !fs.existsSync(c.game)) throw new Error('Pick the game exe first (Game box above)')
      if (steps.includes?.('shaders') && !p.shaders?.length) throw new Error(`${p.name} has no shader prep commands. Add them with Edit.`)
      if (steps === 'launch') {
        steps = c.autoUpdate ? ['update', 'build', 'run'] : ['build', 'run']
      }
      if (!Array.isArray(steps) || !steps.every(s => ['update', 'build', 'force', 'shaders', 'run'].includes(s))) throw new Error('Bad steps')
      const f = path.join(os.tmpdir(), `launcherx-${p.name}.ps1`)
      fs.writeFileSync(f, '﻿' + script(c, p, steps)) // BOM: PowerShell 5.1 reads BOM-less files as ANSI
      spawn('cmd.exe', ['/c', 'start', '""', 'powershell', '-NoProfile', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', f], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
      return true
    },
    lxDir: name => { const c = load(); return path.join(c.root, find(c, name).name) },
  }
}
