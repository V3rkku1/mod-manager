// Heavy self-check: downloads Minecraft 1.21.1 + Fabric and starts the game for 40s (needs a display). Run: npm run test:launcher
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mm2-'))
const events = []
const core = require('./core')(path.join(tmp, 'profiles'), { emit: (e, d) => events.push([e, d]) })
const MC = require('./mc')
;(async () => {
  // servers.dat NBT parse
  const str = s => { const b = Buffer.from(s); return Buffer.concat([Buffer.from([b.length >> 8, b.length & 255]), b]) }
  const nbt = Buffer.concat([Buffer.from([10]), str(''), Buffer.from([9]), str('servers'), Buffer.from([10, 0, 0, 0, 1]),
    Buffer.from([8]), str('name'), str('Hypixel'), Buffer.from([8]), str('ip'), str('mc.hypixel.net'), Buffer.from([1]), str('hidden'), Buffer.from([0]), Buffer.from([0]), Buffer.from([0])])
  fs.writeFileSync(path.join(tmp, 'servers.dat'), nbt)
  assert.deepStrictEqual(MC.readServers(path.join(tmp, 'servers.dat')), [{ name: 'Hypixel', ip: 'mc.hypixel.net' }])

  let p = await core.createProfile({ name: 'MC', type: 'modrinth', mc: { version: '1.21.1', loader: 'fabric' } })
  assert(p.target.startsWith(path.join(tmp, 'profiles')), 'instance dir default')
  p = await core.install(p.id, 'modrinth', 'mOgUt4GM')
  fs.writeFileSync(path.join(tmp, 'Local.jar'), 'jar')
  p = await core.addLocal(p.id, [path.join(tmp, 'Local.jar')])
  assert(p.mods.some(m => m.id === 'local:Local.jar' && m.files[0] === 'mods/Local.jar'), 'local add')
  assert(!(await core.exportCode(p.id)).includes('Local'), 'local not in code')
  fs.mkdirSync(path.join(p.target, 'config'), { recursive: true }); fs.writeFileSync(path.join(p.target, 'config/a.toml'), 'a=1')
  const n = await core.exportMrpack(p.id, path.join(tmp, 'x.mrpack'))
  assert(n >= 2, 'mrpack downloads')
  const imp = await core.importInstance(path.join(tmp, 'x.mrpack'))
  assert.strictEqual(imp.profile.mc.loader, 'fabric'); assert(imp.profile.mc.loaderVersion, 'loader version')
  assert(imp.profile.mods[0].files.includes('mods/Local.jar') && imp.profile.mods[0].files.includes('config/a.toml'), 'mrpack overrides')

  // Prism-like instance
  const prism = path.join(tmp, 'PrismInst')
  fs.mkdirSync(path.join(prism, '.minecraft/mods'), { recursive: true }); fs.mkdirSync(path.join(prism, '.minecraft/saves/World1'), { recursive: true })
  fs.writeFileSync(path.join(prism, 'mmc-pack.json'), JSON.stringify({ components: [{ uid: 'net.minecraft', version: '1.20.1' }, { uid: 'net.fabricmc.fabric-loader', version: '0.15.11' }] }))
  fs.writeFileSync(path.join(prism, '.minecraft/mods/a.jar'), 'x'); fs.writeFileSync(path.join(prism, '.minecraft/mods/b.jar.disabled'), 'x')
  const pr = (await core.importInstance(prism)).profile
  assert.deepStrictEqual([pr.mc.version, pr.mc.loader, pr.mc.loaderVersion], ['1.20.1', 'fabric', '0.15.11'])
  assert.strictEqual(pr.mods.length, 2); assert(pr.mods.find(m => m.name === 'b.jar').disabled)
  assert.strictEqual((await core.worlds(pr.id)).worlds[0].name, 'World1')
  const dup = await core.duplicate(pr.id)
  assert(dup.target.includes(dup.id) && fs.existsSync(path.join(dup.target, 'saves/World1')), 'duplicate')

  // Play with a stub account (no real login here)
  fs.writeFileSync(path.join(tmp, 'accounts.json'), JSON.stringify([{ uuid: '0'.repeat(32), name: 'Tester', token: 'x', refresh: 'r', expires: Date.now() + 864e5 }]))
  await core.uninstall(p.id, 'local:Local.jar')
  await core.play(p.id)
  await new Promise(r => setTimeout(r, 40000))
  const log = core.getLog(p.id).join('\n')
  assert(/Loading \d+ mods/.test(log) && log.includes('modmenu'), 'game loaded with mods')
  assert.deepStrictEqual(core.running(), [p.id])
  core.stop(p.id); await new Promise(r => setTimeout(r, 3000))
  assert((await core.listProfiles()).find(x => x.id === p.id).playtime > 30, 'playtime')
  assert(core.logFiles(p.id).length, 'log files'); assert(core.readLog(p.id, core.logFiles(p.id)[0].rel).length)
  console.log('ok', events.filter(e => e[0] === 'status').length, 'status events')
})().catch(e => { console.error(e); process.exitCode = 1 })
