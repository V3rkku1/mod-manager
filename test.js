// Live self-check against Thunderstore + Modrinth APIs (needs network). Run: npm test
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-'))
const core = require('./core')(path.join(tmp, 'profiles'))
;(async () => {
  const ts = await core.createProfile({ name: 'LC', type: 'thunderstore', game: 'lethal-company' })
  const hits = await core.search(ts.id, 'LateCompany')
  assert(hits.length, 'thunderstore search')
  let p = await core.install(ts.id, 'notnotnotswipez-MoreCompany')
  assert(p.mods.some(m => m.id === 'BepInEx-BepInExPack'), 'dependency installed')
  assert(fs.existsSync(path.join(tmp, 'profiles', ts.id, 'files/BepInEx/core/BepInEx.dll')), 'pack layout')
  assert(p.mods.find(m => m.id === 'notnotnotswipez-MoreCompany').files.every(f => f.startsWith('BepInEx/')), 'mod layout')

  const mc = await core.createProfile({ name: 'MC', type: 'modrinth', mc: { version: '1.21.1', loader: 'fabric' } })
  assert((await core.search(mc.id, 'sodium')).length, 'modrinth search')
  p = await core.install(mc.id, 'mOgUt4GM') // Mod Menu, requires fabric-api
  assert(p.mods.length >= 2 && p.mods.every(m => m.files[0].startsWith('mods/')), 'modrinth install + deps')

  const code = await core.exportCode(mc.id)
  const { profile, failed } = await core.importCode(code)
  assert.deepStrictEqual(failed, [])
  assert.deepStrictEqual(profile.mods.map(m => m.vid).sort(), p.mods.map(m => m.vid).sort(), 'import matches')
  await assert.rejects(core.importCode('MM1garbage'), /Invalid share code/)

  await core.updateProfile(mc.id, { target: path.join(tmp, 'game') })
  await core.deploy(mc.id)
  assert.strictEqual(fs.readdirSync(path.join(tmp, 'game/mods')).length, p.mods.length, 'deploy')
  p = await core.uninstall(mc.id, 'mOgUt4GM')
  await core.deploy(mc.id)
  assert.strictEqual(fs.readdirSync(path.join(tmp, 'game/mods')).length, p.mods.length, 'redeploy removes old')
  console.log('ok', code.length, 'char code')
})().catch(e => { console.error(e); process.exit(1) }).finally(() => fs.rmSync(tmp, { recursive: true, force: true }))
