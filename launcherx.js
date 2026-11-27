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
      build: ['if (!(Test-Path victory.toml)) { Copy-Item victory.example.toml victory.toml }', '.\\Get-NVIDIA-DLSS.cmd'], run: ".\\scripts\\play-nvidia.ps1 -Exe '{game}' {args}",
      // play-foxhound.ps1's parameters
      options: [{ id: 'dlss', label: 'DLSS', flag: '-Dlss', choices: [['', 'Default (quality)'], ['quality', 'Quality'], ['balanced', 'Balanced'], ['performance', 'Performance'], ['dlaa', 'DLAA'], ['off', 'Off']] },
        { id: 'res', label: 'Resolution', flag: '-Res', choices: [['', 'Default (1440p)'], ['1440', '1440p'], ['1080to1440', '1080p to 1440p'], ['4k', '4K']] },
        { id: 'fg', label: 'Frame generation', flag: '-FrameGen' }, { id: 'seriess', label: 'Series S profile (faster, softer)', flag: '-SeriesS' }],
      // `victory preload <game folder>`: every shader + the loading pipelines, ahead of the first start (its README / play-foxhound.ps1 -Preload).
      shaders: ['cargo build --release --locked -p victory', ".\\target\\release\\victory.exe preload ([IO.Path]::GetDirectoryName('{game}'))"] },
    { name: 'VIctory-DexNom', repo: 'https://github.com/DexNom/VIctory', branch: 'main',
      build: ['.\\Initialize-FormatTables.ps1', 'cargo build --locked --release -p victory --features diagnostics --bins'], run: ".\\target\\release\\victory-play.exe {args} '{game}'",
      // victory-play's launcher options (they go before the game path)
      options: [{ id: 'rt', label: 'Ray tracing', choices: [['', 'Default'], ['--rt', 'On'], ['--no-rt', 'Off']] },
        { id: 'up', label: 'Upscaling', choices: [['', 'Default'], ['--fsr-quality', 'FSR Quality'], ['--fsr-balanced', 'FSR Balanced'], ['--fsr-performance', 'FSR Performance'], ['--native-1440p', 'Native 1440p'], ['--1080p-to-1440p', '1080p to 1440p']] },
        { id: 'console', label: 'Console profile', flag: '--console', choices: [['', 'Default'], ['series-x', 'Series X'], ['series-s', 'Series S']] }],
      shaders: [".\\target\\release\\victory-warm.exe '{game}'"] }, // its README: "To warm the shader cache, open victory-warm.exe"
    { name: 'kelvaroq', repo: 'https://github.com/stellarr-studio/kelvaroq', branch: 'main',
      build: ['cargo build --release --locked', 'python scripts/build_native.py'], run: '.\\target\\release\\kelvaroq.exe' },
  ],
})

// Windows keeps PATH in the registry; a console started from an app gets the app's old copy.
const PATH_REFRESH = "$m = [Environment]::GetEnvironmentVariable('Path', 'Machine'); if ($m) { $env:Path = $m + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + $env:Path }"
// What the projects need on Windows, and the winget package that installs it (Launcher-X's CheckTools + its README's build tools line).
const TOOLS = {
  git: { label: 'Git', install: 'winget install -e --id Git.Git' },
  cargo: { label: 'Rust', install: 'winget install -e --id Rustlang.Rustup' },
  msvc: { label: 'C++ build tools (needed by Rust)', install: 'winget install -e --id Microsoft.VisualStudio.2022.BuildTools --override "--wait --quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"' },
  python: { label: 'Python', install: 'winget install -e --id Python.Python.3.12' },
}
const needs = c => {
  const cmds = c.projects.flatMap(p => [...(p.build || []), ...(p.shaders || [])]).join('\n')
  return ['git', ...(/\bcargo\b/.test(cmds) ? ['cargo', 'msvc'] : []), ...(/\bpython\b/.test(cmds) ? ['python'] : [])]
}
// Opens a PowerShell window running `text` (written to a temp .ps1).
function console_(name, text) {
  const f = path.join(os.tmpdir(), `${name}.ps1`)
  fs.writeFileSync(f, '\ufeff' + text) // BOM: PowerShell 5.1 reads BOM-less files as ANSI
  spawn('cmd.exe', ['/c', 'start', '""', 'powershell', '-NoProfile', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', f], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  return true
}
// Play options -> command-line arguments (values only from the fixed choices; `extra` is the user's own text).
const args = p => [...(p.options || []).map(o => { const v = p.opts?.[o.id]; return o.choices ? (v && o.choices.some(([c]) => c === v) ? (o.flag ? `${o.flag} ${v}` : v) : '') : v ? o.flag : '' }),
  p.extra || ''].filter(Boolean).join(' ')
const Q = s => "'" + String(s ?? '').replace(/'/g, "''") + "'"
const NAME = /^[\w.-]{1,80}$/

// PowerShell job script. Steps: update, build, force, run. Clone always happens if missing. Same text as Launcher-X's Core.Script.
function script(c, p, steps) {
  const dir = path.join(c.root, p.name), mark = dir + '.built'
  const o = [
    'function X { if ($LASTEXITCODE) { throw "Step failed, exit code $LASTEXITCODE" } }',
    "$ErrorActionPreference = 'Stop'",
    PATH_REFRESH, // tools installed after Mod Manager started (Rust, Git) are found without restarting it
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
  const run = cmd => { const a = args(p); return game(cmd.includes('{args}') ? cmd.replace(/\{args\}/g, a) : a ? `${cmd} ${a}` : cmd).trim() }
  // Shader prep: the project's own warm-up/preload commands, so the first start doesn't stutter while pipelines compile.
  if (steps.includes('shaders')) for (const cmd of p.shaders || []) o.push(`${game(cmd)}; X`)
  if (steps.includes('run') && p.run) o.push(run(p.run))
  return o.join('\n')
}

const git = args => new Promise(ok => execFile('git', args, { windowsHide: true, timeout: 30e3, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
  (e, out) => ok(e?.code === 'ENOENT' ? null : (out || '').trim())))

const releases = {} // repo -> latest release info, fetched once per run (GitHub allows 60 unauthenticated calls an hour)
async function latest(repo) {
  if (repo in releases) return releases[repo]
  const m = repo.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(\.git)?$/)
  releases[repo] = !m ? null : await fetch(`https://api.github.com/repos/${m[1]}/releases/latest`, { headers: { 'user-agent': 'mod-manager', accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15e3) })
    .then(r => r.ok ? r.json() : null).then(j => j && { tag: j.tag_name, date: j.published_at, url: j.html_url }).catch(() => null)
  return releases[repo]
}

// Size of a folder in bytes (symlinks not followed).
async function du(dir) {
  let n = 0
  for (const e of await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const f = path.join(dir, e.name)
    n += e.isDirectory() ? await du(f) : e.isFile() ? (await fs.promises.stat(f).catch(() => ({ size: 0 }))).size : 0
  }
  return n
}
const SHELL = process.platform === 'win32' ? 'powershell' : 'pwsh' // pwsh only for tests off Windows

module.exports = (dataDir, emit = () => {}) => {
  const jobs = {} // name -> { child, lines }
  const file = path.join(dataDir, 'launcherx.json')
  const load = () => {
    const d = defaults(dataDir)
    let c; try { c = { ...d, ...JSON.parse(fs.readFileSync(file, 'utf8')) } } catch { return d }
    for (const p of c.projects) { // saved before these existed: take them from the defaults
      const dp = d.projects.find(x => x.name === p.name)
      if (!p.shaders) p.shaders = dp?.shaders || []
      if (dp?.options && !p.options) { p.options = dp.options; if (p.run === dp.run.replace(/ ?\{args\}/, '')) p.run = dp.run }
    }
    return c
  }
  const save = c => (fs.mkdirSync(dataDir, { recursive: true }), fs.writeFileSync(file, JSON.stringify(c, null, 1)), c)
  const find = (c, name) => c.projects.find(p => p.name === name) || (() => { throw new Error(`No project ${name}`) })()
  const clean = p => {
    const name = String(p.name || '').trim(), repo = String(p.repo || '').trim().replace(/\/$/, '')
    if (!NAME.test(name)) throw new Error('Project name: letters, numbers, . _ - only')
    if (!/^(https:\/\/|git@|[A-Za-z]:\\|\/)/.test(repo)) throw new Error('Repository must be a git URL')
    const lines = v => (Array.isArray(v) ? v : String(v || '').split(/\r?\n/)).map(s => s.trim()).filter(Boolean)
    return { name, repo, branch: String(p.branch || 'main').trim() || 'main', build: lines(p.build), shaders: lines(p.shaders), run: String(p.run || '').trim(),
      ...(p.options ? { options: p.options, opts: p.opts, extra: p.extra } : {}) }
  }
  // Runs steps without a window, the output streamed to the page (lxlog events) and kept in logs/<name>.log.
  // Resolves { code, error } where error is the line that explains a failure.
  function job(c, p, steps) {
    if (jobs[p.name]?.child) throw new Error(`${p.name} is already busy`)
    const f = path.join(os.tmpdir(), `launcherx-${p.name}-job.ps1`), logDir = path.join(dataDir, 'logs')
    fs.writeFileSync(f, '\ufeff' + script(c, p, steps)); fs.mkdirSync(logDir, { recursive: true })
    const log = fs.createWriteStream(path.join(logDir, `launcherx-${p.name}.log`))
    const child = spawn(SHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', f], { cwd: os.tmpdir(), windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
    const j = jobs[p.name] = { child, lines: [], steps }
    emit('lxjob', { name: p.name, busy: true, steps })
    let rest = ''
    const add = d => { rest += d; const ls = rest.split(/\r?\n/); rest = ls.pop(); for (const line of ls) { j.lines.push(line); if (j.lines.length > 2000) j.lines.shift(); log.write(line + '\n'); emit('lxlog', { name: p.name, line }) } }
    child.stdout.on('data', add); child.stderr.on('data', add)
    return new Promise(ok => {
      const done = code => {
        if (rest) add('\n'); log.end(); j.child = null
        const error = code ? [...j.lines].reverse().find(l => /Step failed|error(\[\w+\])?:|fatal:|not recognized|cannot find/i.test(l)) || `Exit code ${code}` : null
        emit('lxjob', { name: p.name, busy: false, code, error, stopped: j.stopped }); ok({ code, error })
      }
      child.on('error', e => { add(e.message + '\n'); done(1) }); child.on('exit', c2 => done(c2 ?? 1))
    })
  }
  return {
    script, Q, needs, args,
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
    // Launch = update (if auto-update) + build if changed, shown on the page, then the game in its own PowerShell window
    // (the play scripts can ask questions there). Other steps run on the page only.
    lxRun: async (name, steps) => {
      if (process.platform !== 'win32') throw new Error('Launcher-X projects run on Windows')
      const c = load(), p = find(c, name)
      const needsGame = steps === 'launch' ? (p.run || '').includes('{game}') : steps.includes?.('shaders') && (p.shaders || []).some(x => x.includes('{game}'))
      if (needsGame && !fs.existsSync(c.game)) throw new Error('Pick the game exe first (Game box above)')
      if (steps.includes?.('shaders') && !p.shaders?.length) throw new Error(`${p.name} has no shader prep commands. Add them with Edit.`)
      if (steps === 'launch') {
        save({ ...c, last: p.name })
        const r = await job(c, p, c.autoUpdate ? ['update', 'build'] : ['build'])
        if (r.code) throw new Error(jobs[p.name].stopped ? 'Stopped' : `${p.name}: build failed. ${r.error}`)
        return console_(`launcherx-${p.name}`, script(c, p, ['run']))
      }
      if (!Array.isArray(steps) || !steps.every(s => ['update', 'build', 'force', 'shaders'].includes(s))) throw new Error('Bad steps')
      const r = await job(c, p, steps)
      if (r.code) throw new Error(jobs[p.name].stopped ? 'Stopped' : `${p.name}: ${r.error}`)
      return true
    },
    lxStop: name => { const j = jobs[name]; if (j?.child) { j.stopped = true; process.platform === 'win32' ? spawn('taskkill', ['/pid', String(j.child.pid), '/T', '/F'], { windowsHide: true }) : j.child.kill() } return true },
    lxLog: name => ({ lines: jobs[name]?.lines || [], busy: !!jobs[name]?.child }),
    lxSetOpts: (name, opts, extra) => {
      const c = load(), p = find(c, name)
      p.opts = Object.fromEntries((p.options || []).map(o => [o.id, o.choices ? String(opts?.[o.id] || '') : !!opts?.[o.id]]))
      p.extra = String(extra || '').trim().slice(0, 300)
      return save(c)
    },
    // Disk use: the whole folder and the build output (target\ for Rust, build\ for CMake) that Clean removes.
    lxSize: async name => { const dir = path.join(load().root, name); return { total: await du(dir), build: (await du(path.join(dir, 'target'))) + (await du(path.join(dir, 'build'))) } },
    lxClean: async name => {
      const c = load(), dir = path.join(c.root, find(c, name).name)
      if (jobs[name]?.child) throw new Error(`${name} is busy`)
      for (const d of ['target', 'build']) await fs.promises.rm(path.join(dir, d), { recursive: true, force: true }) // async: can be tens of GB
      fs.rmSync(dir + '.built', { force: true }) // next Launch builds again
      return true
    },
    // Commits on GitHub that this copy doesn't have yet (fetch, nothing changes in the working copy).
    lxCommits: async name => {
      const c = load(), p = find(c, name), dir = path.join(c.root, p.name)
      if (!fs.existsSync(path.join(dir, '.git')) || await git(['-C', dir, 'fetch', '--quiet', 'origin', p.branch]) === null) return []
      return ((await git(['-C', dir, 'log', '--format=%h%x09%s%x09%cr', '-n', '30', 'HEAD..FETCH_HEAD'])) || '').split('\n').filter(Boolean)
        .map(l => { const [hash, subject, when] = l.split('\t'); return { hash, subject, when } })
    },
    // Missing tools for the listed projects: [{ id, label }]. Windows only (the projects build there).
    lxTools: () => new Promise(ok => {
      if (process.platform !== 'win32') return ok([])
      const want = needs(load())
      const ps = [PATH_REFRESH,
        "foreach ($t in 'git', 'cargo', 'python') { if (Get-Command $t -CommandType Application -ErrorAction SilentlyContinue | Where-Object { $_.Source -notmatch 'WindowsApps' }) { $t } }",
        '$vw = "${env:ProgramFiles(x86)}\\Microsoft Visual Studio\\Installer\\vswhere.exe"',
        "if ((Test-Path $vw) -and (& $vw -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath)) { 'msvc' }"].join('\n')
      execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 60e3 }, (e, out) => {
        const have = new Set(String(out || '').split(/\s+/))
        ok(e ? [] : want.filter(t => !have.has(t)).map(id => ({ id, label: TOOLS[id].label })))
      })
    }),
    // Installs them with winget in a PowerShell window (the build tools ask for admin rights).
    lxInstallTools: ids => {
      if (process.platform !== 'win32') throw new Error('Installing tools works on Windows')
      const list = ids.filter(id => TOOLS[id])
      if (!list.length) return false
      return console_('launcherx-tools', [...list.map(id => `Write-Host 'Installing ${TOOLS[id].label}...'; ${TOOLS[id].install} --accept-source-agreements --accept-package-agreements`),
        "Write-Host ''; Write-Host 'Done. Close this window and press Check again in Mod Manager.'"].join('\n'))
    },
    lxLatest: async name => { const c = load(); return latest(find(c, name).repo) },
    lxDir: name => { const c = load(); return path.join(c.root, find(c, name).name) },
  }
}
