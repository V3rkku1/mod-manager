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
