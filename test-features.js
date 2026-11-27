// Saved servers, missing-dependency and duplicate-mod detection (uses Modrinth).
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ft'))
const core = require('./core')(path.join(tmp, 'profiles'), { emit: () => {} })
;(async () => {
  let p = await core.createProfile({ name: 'F', type: 'modrinth', mc: { version: '1.21.1', loader: 'fabric' } })

  assert(await core.addServer(p.id, 'Home', 'play.example.com:25566'))
  await assert.rejects(async () => core.addServer(p.id, 'x', 'bad address!'), /not a server address/)
  assert.deepEqual((await core.worlds(p.id)).servers.map(s => s.ip), ['play.example.com:25566'])
  await core.removeServer(p.id, 'play.example.com:25566')
  assert.deepEqual((await core.worlds(p.id)).servers, [])

  // World backups: zip, skip unchanged, restore keeps the current copy.
  const w = path.join(p.target, 'saves', 'My World'); fs.mkdirSync(path.join(w, 'region'), { recursive: true })
  fs.writeFileSync(path.join(w, 'level.dat'), 'v1'); fs.writeFileSync(path.join(w, 'region', 'r.0.0.mca'), Buffer.alloc(5000, 1))
  assert.deepEqual(await core.backupWorlds(p.id), ['My World'])
  assert.deepEqual(await core.backupWorlds(p.id), [], 'unchanged world not backed up again')
  fs.writeFileSync(path.join(w, 'level.dat'), 'v2')
  const [b] = await core.worldBackups(p.id); assert.equal(b.world, 'My World')
  assert.equal(await core.worldRestore(p.id, b.file), 'My World')
  assert.equal(fs.readFileSync(path.join(w, 'level.dat'), 'utf8'), 'v1', 'restored')
  assert(fs.readdirSync(path.join(p.target, 'saves')).some(n => n.startsWith('My World (before restore')), 'current copy kept')
  await assert.rejects(async () => core.worldBackup(p.id, '../x'), /No such world/)
  await assert.rejects(async () => core.worldRestore(p.id, '../../evil--1.zip'), /not found/)

  // Crash report: newest report found, with its time.
  fs.mkdirSync(path.join(p.target, 'crash-reports'), { recursive: true }); fs.writeFileSync(path.join(p.target, 'crash-reports', 'crash-1.txt'), 'Description: boom\nSuspected Mod: Nope (nope)')
  const cr = await core.analyzeCrash(p.id); assert(cr.crash && cr.time > Date.now() - 60e3, 'crash report seen')

  p = await core.install(p.id, 'modrinth', 'mOgUt4GM') // Mod Menu, needs Fabric API
  const api = p.mods.find(m => m.id === 'P7dR8mSH'); assert(api, 'dependency installed')
  assert.deepEqual((await core.conflicts(p.id)).filter(c => c.type !== 'file'), [])
  await core.setDisabled(p.id, 'P7dR8mSH', true)
  const miss = (await core.conflicts(p.id)).find(c => c.type === 'missing')
  assert(miss && miss.disabled && miss.depName === 'Fabric API' && miss.mods.includes('Mod Menu'), 'switched-off dependency reported')
  await core.setDisabled(p.id, 'P7dR8mSH', false)

  // A second Mod Menu jar of another version, added as a local file.
  const jar = path.join(tmp, 'modmenu-9.0.0.jar'); fs.writeFileSync(jar, 'x')
  await core.addLocal(p.id, [jar])
  const dup = (await core.conflicts(p.id)).find(c => c.type === 'duplicate')
  assert(dup && dup.files.includes('modmenu-9.0.0.jar'), 'duplicate found')
  console.log('ok features')
})().catch(e => { console.error(e); process.exit(1) })
