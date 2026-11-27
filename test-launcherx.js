// Launcher-X built in: same checks as launcher-x/tests/Test.cs. The end-to-end part needs PowerShell (Windows CI).
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), { spawnSync } = require('child_process')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lx'))
const LX = require('./launcherx')(tmp)

// Unit: generated script text.
let c = { root: '/g', game: "/it's/game.exe" }, p = { name: 'x', repo: 'https://github.com/a/x', branch: 'main', build: ['cargo build'], run: ".\\p.ps1 -Exe '{game}'" }
const a = LX.script(c, p, ['update', 'build', 'run'])
assert(a.includes("git clone --recurse-submodules -b 'main' 'https://github.com/a/x'"), 'clone')
assert(a.includes('git pull') && a.includes('  cargo build; X') && a.includes('Get-Content'), 'update/build')
assert(a.includes(".\\p.ps1 -Exe '/it''s/game.exe'"), 'run quoting')
const b = LX.script(c, p, ['build', 'force'])
assert(!b.includes('git pull') && b.includes('if ($true)') && !b.includes('p.ps1'), 'force/no-run')
assert.equal(LX.lxConfig().projects.length, 4, 'defaults')
assert.equal(LX.lxConfig().enabled, false, 'hidden until added with + > Recomps')
assert.deepEqual(LX.needs(LX.lxConfig()), ['git', 'cargo', 'msvc', 'python'], 'tools the default projects need')
assert(a.includes("GetEnvironmentVariable('Path', 'Machine')"), 'fresh PATH so newly installed Rust is found')
assert.equal(LX.lxSave({ enabled: true, name: 'GTA 6' }).enabled, true)
const sh = LX.script(c, { ...p, shaders: ["warm.exe '{game}'"] }, ['build', 'shaders'])
assert(sh.includes("warm.exe '/it''s/game.exe'; X") && !sh.includes('p.ps1'), 'shader prep step')
assert(!a.includes('warm.exe'), 'no shader prep unless asked')
assert(LX.lxConfig().projects.find(x => x.name === 'VIctory-NVIDIA').shaders.some(x => x.includes('preload')), 'NVIDIA preload default')

// Config: add, rename, duplicate name, bad input, remove.
LX.lxPut({ name: 'demo', repo: 'https://github.com/a/demo', build: 'one\ntwo', run: 'go' })
assert.deepEqual(LX.lxConfig().projects.at(-1).build, ['one', 'two'])
LX.lxPut({ name: 'demo2', repo: 'https://github.com/a/demo', build: '', run: '' }, 'demo')
assert(LX.lxConfig().projects.some(x => x.name === 'demo2') && !LX.lxConfig().projects.some(x => x.name === 'demo'), 'rename')
assert.throws(() => LX.lxPut({ name: 'kelvaroq', repo: 'https://github.com/a/b' }), /already exists/)
assert.throws(() => LX.lxPut({ name: '../evil', repo: 'https://github.com/a/b' }), /Project name/)
LX.lxRemove('demo2'); assert.equal(LX.lxConfig().projects.length, 4)

// Play options: fixed choices become arguments in the right place; unknown values are dropped.
LX.lxSetOpts('VIctory-NVIDIA', { dlss: 'balanced', fg: true, res: 'bad' }, '-More x')
LX.lxSetOpts('VIctory-DexNom', { rt: '--no-rt', console: 'series-s' })
const cfg = { ...LX.lxConfig(), game: 'D:\\G.exe' }, run1 = n => LX.script(cfg, cfg.projects.find(x => x.name === n), ['run']).split('\n').pop()
assert.equal(run1('VIctory-NVIDIA'), ".\\scripts\\play-nvidia.ps1 -Exe 'D:\\G.exe' -Dlss balanced -FrameGen -More x")
assert.equal(run1('VIctory-DexNom'), ".\\target\\release\\victory-play.exe --no-rt --console series-s 'D:\\G.exe'", 'options before the game path')
assert.equal(run1('kelvaroq'), '.\\target\\release\\kelvaroq.exe')
// A config saved before options existed gets them, and the old run command gains {args}.
const old = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lxo')))
fs.writeFileSync(path.join(old, 'launcherx.json'), JSON.stringify({ projects: [{ name: 'VIctory-DexNom', repo: 'https://github.com/DexNom/VIctory', branch: 'main', build: [], run: ".\\target\\release\\victory-play.exe '{game}'" }] }))
assert(require('./launcherx')(old).lxConfig().projects[0].run.includes('{args}'), 'run command migrated')

;(async () => {
  // Disk use and Clean: build output goes, sources stay, next Launch rebuilds.
  const kd = path.join(LX.lxConfig().root, 'kelvaroq')
  fs.mkdirSync(path.join(kd, 'target'), { recursive: true }); fs.writeFileSync(path.join(kd, 'target', 'big'), Buffer.alloc(1000)); fs.writeFileSync(path.join(kd, 'src.rs'), 'x'); fs.writeFileSync(kd + '.built', 'h')
  assert.deepEqual(await LX.lxSize('kelvaroq'), { total: 1001, build: 1000 })
  await LX.lxClean('kelvaroq'); assert(!fs.existsSync(path.join(kd, 'target')) && fs.existsSync(path.join(kd, 'src.rs')) && !fs.existsSync(kd + '.built'), 'clean')

  // New commits on the remote, without touching the working copy (git only).
  const g = (cwd, ...a2) => spawnSync('git', a2, { cwd, encoding: 'utf8' })
  const up = path.join(tmp, 'up'); fs.mkdirSync(up); g(up, 'init', '-q', '-b', 'main'); g(up, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'one')
  LX.lxPut({ name: 'cm', repo: up, build: '', run: '' }); g(tmp, 'clone', '-q', up, path.join(LX.lxConfig().root, 'cm'))
  assert.deepEqual(await LX.lxCommits('cm'), [])
  g(up, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'Faster shaders')
  const nc = await LX.lxCommits('cm'); assert(nc.length === 1 && nc[0].subject === 'Faster shaders', 'new commit listed')
  LX.lxRemove('cm', true)

  const shell = ['powershell', 'pwsh'].find(s => !spawnSync(s, ['-NoProfile', '-Command', 'exit 0']).error)
  if (!shell) return console.log('ok launcherx (unit; no PowerShell here, end-to-end runs on Windows CI)')
  const sh = (exe, cwd, ...args) => { const r = spawnSync(exe, args, { cwd, encoding: 'utf8' }); if (r.status) console.log(`[${exe} exit ${r.status}] ${r.stdout}${r.stderr}`.trim()); return r.status }
  const src = path.join(tmp, 'src'); fs.mkdirSync(src)
  const commit = m => sh('git', src, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', m)
  sh('git', src, 'init', '-q', '-b', 'main'); commit('one')
  const count = path.join(tmp, 'count.txt'), builds = () => fs.existsSync(count) ? fs.readFileSync(count, 'utf8').trim().split(/\r?\n/).length : 0
  LX.lxSave({ root: path.join(tmp, "it's projects"), game: path.join(tmp, "game's.exe") })
  LX.lxPut({ name: 'demo', repo: src, build: `Add-Content ${LX.Q(count)} x`, run: "Set-Content ran.txt '{game}'" })
  c = LX.lxConfig(); p = c.projects.find(x => x.name === 'demo')
  const job = (...steps) => { const f = path.join(tmp, 'job.ps1'); fs.writeFileSync(f, '\ufeff' + LX.script(c, p, steps)); return sh(shell, tmp, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', f) }

  if (process.platform === 'win32') { const miss = await LX.lxTools(); assert(Array.isArray(miss) && !miss.some(t => t.id === 'git'), 'tool check: ' + JSON.stringify(miss)) }
  assert.equal(await LX.lxStatus('demo'), 'Not installed')
  assert.equal(job('update', 'build', 'run'), 0); assert.equal(builds(), 1)
  assert.equal(fs.readFileSync(path.join(LX.lxDir('demo'), 'ran.txt'), 'utf8').trim(), c.game, 'run got game path')
  assert.equal(await LX.lxStatus('demo'), 'Up to date')
  assert(job('update', 'build') === 0 && builds() === 1, 'no rebuild when unchanged')
  commit('two'); assert.equal(await LX.lxStatus('demo'), 'Update available')
  assert(job('update', 'build') === 0 && builds() === 2, 'rebuild after update')
  assert(job('build', 'force') === 0 && builds() === 3, 'force rebuild')
  p.shaders = ["Set-Content warmed.txt '{game}'"]
  assert(job('build', 'shaders') === 0 && builds() === 3, 'shader prep without rebuild')
  assert.equal(fs.readFileSync(path.join(LX.lxDir('demo'), 'warmed.txt'), 'utf8').trim(), c.game, 'shader prep got game path')
  p.build = ['git not-a-command']; commit('three')
  assert.notEqual(job('update', 'build'), 0, 'failed build exits non-zero')
  assert.equal(await LX.lxStatus('demo'), 'Up to date, not built')
  // Hidden job (what Update + Build / Rebuild / Launch's build run as): output reaches the page, failures say why.
  if (process.platform === 'win32') {
    const ev = [], LX2 = require('./launcherx')(tmp, (e, d) => ev.push([e, d]))
    p.build = [`Add-Content ${LX.Q(count)} x`, "Write-Host 'hello from build'"]; LX.lxPut(p, 'demo')
    assert.equal(await LX2.lxRun('demo', ['build', 'force']), true)
    assert(ev.some(([e, d]) => e === 'lxlog' && d.line.includes('hello from build')) && ev.at(-1)[1].busy === false, 'log streamed')
    LX.lxPut({ ...p, build: ['git not-a-command'] }, 'demo')
    await assert.rejects(LX2.lxRun('demo', ['build', 'force']), /Step failed|not-a-command/)
  }
  LX.lxRemove('demo', true); assert(!fs.existsSync(path.join(c.root, 'demo')), 'files deleted')
  console.log('ok launcherx (unit + end-to-end)')
})().catch(e => { console.error(e); process.exit(1) })
