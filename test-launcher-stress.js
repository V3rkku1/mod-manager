// Launcher stress test (network + display): parallel prepares, double Play, two instances of one version,
// play/stop cycles, corrupt-file repair, loader matrix with real launches. Run: xvfb-run -a node test-launcher-stress.js
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto')
const tmp = process.env.MM_STRESS_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'mm-stress-'))
const events = []
const core = require('./core')(path.join(tmp, 'profiles'), { emit: (e, d) => events.push([e, d]) })
const MC = require('./mc')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const t0 = Date.now(), lap = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`
const results = []
const step = async (name, fn) => {
  const s = Date.now()
  try { const note = await fn(); results.push(['PASS', name, ((Date.now() - s) / 1000).toFixed(1) + 's', note || '']); console.log(lap(), 'PASS', name, note || '') }
  catch (e) { results.push(['FAIL', name, ((Date.now() - s) / 1000).toFixed(1) + 's', e.message.split('\n')[0]]); console.log(lap(), 'FAIL', name, e.stack) }
}
// Game reached the main menu / world load without crashing.
const started = log => /Backend library: LWJGL|Created: \d+x\d+.*-atlas|Sound engine started|LWJGL Version/.test(log)
const crashed = log => /---- Minecraft Crash Report ----|Exception in thread "main"|Could not find or load main class|Error: Unable to initialize main class/.test(log)
async function waitGame(pid, s = 150) {
  for (let i = 0; i < s; i++) {
    const log = core.getLog(pid).join('\n')
    if (crashed(log)) throw new Error('game crashed: ' + log.split('\n').filter(l => /Exception|Error|Caused by/.test(l)).slice(0, 3).join(' | '))
    if (started(log)) return i
    if (!core.running().includes(pid) && i > 5) throw new Error('game exited early: ' + core.getLog(pid).slice(-3).join(' | '))
    await sleep(1000)
  }
  throw new Error('game did not start in time: ' + core.getLog(pid).slice(-2).join(' | '))
}
async function stopAll() { for (const id of core.running()) core.stop(id); for (let i = 0; i < 30 && core.running().length; i++) await sleep(1000) }
const mk = (name, version, loader) => core.createProfile({ name, type: 'modrinth', mc: { version, loader } })

;(async () => {
  fs.writeFileSync(path.join(tmp, 'accounts.json'), JSON.stringify([{ uuid: '0'.repeat(32), name: 'Tester', token: 'x', refresh: 'r', expires: Date.now() + 864e5 }]))
  const base = path.join(tmp, 'minecraft')

  await step('4 parallel prepares of the same version (cold cache)', async () => {
    const mcl = MC(path.join(tmp, 'mc-parallel'))
    const r = await Promise.allSettled(Array.from({ length: 4 }, () => mcl.prepare({ mc: '1.21.1', loader: 'fabric' })))
    const bad = r.filter(x => x.status === 'rejected')
    assert(!bad.length, `${bad.length}/4 failed: ${bad[0]?.reason?.message}`)
    fs.rmSync(path.join(tmp, 'mc-parallel'), { recursive: true, force: true })
  })

  const a = await mk('A', '1.21.1', 'fabric'), b = await mk('B', '1.21.1', 'fabric')
  await core.install(a.id, 'modrinth', 'mOgUt4GM') // Mod Menu + Fabric API

  await step('double Play click on one profile', async () => {
    const r = await Promise.allSettled([core.play(a.id), core.play(a.id)])
    await sleep(3000)
    const java = core.running().filter(id => id === a.id).length
    assert(r.filter(x => x.status === 'fulfilled').length === 1, `both plays succeeded -> two games for one profile (${r.map(x => x.status)})`)
    return `second: ${r.find(x => x.status === 'rejected')?.reason.message}`
  })
  await step('A reaches the game', async () => `${await waitGame(a.id)}s`)

  await step('B (same version) launches while A runs', async () => {
    await core.play(b.id)
    const s = await waitGame(b.id)
    assert(core.running().includes(a.id), 'A died when B started')
    return `${s}s, both running`
  })
  await stopAll()

  await step('5 rapid play/stop cycles', async () => {
    for (let i = 0; i < 5; i++) {
      await core.play(a.id); await sleep(4000 + i * 1500); core.stop(a.id)
      for (let j = 0; j < 20 && core.running().includes(a.id); j++) await sleep(500)
      assert(!core.running().includes(a.id), `cycle ${i} did not stop`)
    }
    const p = (await core.listProfiles()).find(x => x.id === a.id)
    assert(p.playtime > 0, 'playtime')
    assert(fs.readdirSync(path.join(p.target, 'mods')).length >= 2, 'mods still deployed')
  })

  await step('stop while still preparing', async () => {
    const c = await mk('C', '1.20.1', 'fabric')
    const pr = core.play(c.id); await sleep(500); core.stop(c.id)
    await pr.catch(() => {}); await sleep(3000)
    const left = core.running().includes(c.id)
    if (left) { core.stop(c.id); await sleep(3000) }
    assert(!left, 'game started anyway after Stop during download')
  })

  await step('corrupt client jar + library: repair fixes, play works', async () => {
    const jar = path.join(base, 'versions', '1.21.1', '1.21.1.jar')
    const lib = fs.readdirSync(path.join(base, 'libraries', 'org', 'lwjgl', 'lwjgl'))[0]
    const libJar = path.join(base, 'libraries', 'org', 'lwjgl', 'lwjgl', lib, `lwjgl-${lib}.jar`)
    const good = crypto.createHash('sha1').update(fs.readFileSync(jar)).digest('hex')
    fs.writeFileSync(jar, 'broken'); fs.truncateSync(libJar, 100)
    await core.repair(a.id)
    assert.strictEqual(crypto.createHash('sha1').update(fs.readFileSync(jar)).digest('hex'), good, 'client jar restored')
    assert(fs.statSync(libJar).size > 100, 'library restored')
    await core.play(a.id); const s = await waitGame(a.id); await stopAll()
    return `game ok ${s}s after repair`
  })

  await step('leftover .part files and a half-written asset', async () => {
    const objs = path.join(base, 'assets', 'objects'), d = fs.readdirSync(objs)[0], f = fs.readdirSync(path.join(objs, d))[0]
    fs.writeFileSync(path.join(objs, d, f + '.part'), 'junk')
    await core.play(a.id); await waitGame(a.id); await stopAll()
  })

  const matrix = [['1.21.1', 'vanilla'], ['1.20.1', 'forge'], ['1.21.1', 'neoforge'], ['1.20.1', 'quilt'], ['1.16.5', 'fabric'], ['1.12.2', 'vanilla'], ['1.8.9', 'vanilla'], ['1.12.2', 'forge'], ['1.7.10', 'vanilla']]
  for (const [v, l] of matrix) await step(`launch ${l} ${v}`, async () => {
    const p = await mk(`${l}-${v}`, v, l)
    await core.play(p.id)
    const s = await waitGame(p.id, 240)
    await stopAll()
    return `menu after ${s}s`
  })

  await step('three different versions at once', async () => {
    const ps = await Promise.all([['1.21.1', 'fabric'], ['1.20.1', 'forge'], ['1.16.5', 'fabric']].map(([v, l], i) => mk(`multi${i}`, v, l)))
    await Promise.all(ps.map(p => core.play(p.id)))
    const s = await Promise.all(ps.map(p => waitGame(p.id, 240)))
    assert.strictEqual(core.running().length, 3)
    await stopAll()
    return s.map(x => x + 's').join(', ')
  })

  console.log('\nRESULTS'); for (const r of results) console.log(r.join('  '))
  console.log('disk', require('child_process').execSync(`du -sh ${tmp}`).toString().trim())
})().catch(e => { console.error(e); process.exitCode = 1 }).finally(async () => { await stopAll(); if (!process.env.MM_STRESS_DIR) fs.rmSync(tmp, { recursive: true, force: true }); process.exit() })
