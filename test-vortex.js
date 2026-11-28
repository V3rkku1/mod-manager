// Vortex-style features offline: per-mod staging + conflict priority, Data/ stripping, FOMOD installer flow, load order, hardlink deploy, purge.
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path')
const { zipSync, strToU8 } = require('fflate')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-vx-'))
const core = require('./core')(path.join(tmp, 'profiles'))
const zip = (name, files) => { const f = path.join(tmp, name); fs.writeFileSync(f, zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])))); return f }
const read = f => fs.readFileSync(path.join(tmp, 'game', f), 'utf8')
;(async () => {
  let p = await core.createProfile({ name: 'SSE', type: 'nexus', game: 'skyrimspecialedition', gameId: '1704', gameName: 'Skyrim Special Edition' })
  await core.updateProfile(p.id, { target: path.join(tmp, 'game') })
  // Two mods shipping the same texture; archive A has a Data/ folder that gets stripped.
  p = await core.addLocal(p.id, [zip('A.zip', { 'Data/textures/sky.dds': 'A', 'Data/A.esp': 'a' })])
  assert.deepStrictEqual(p.mods[0].files.sort(), ['A.esp', 'textures/sky.dds'], 'Data/ stripped')
  p = await core.addLocal(p.id, [zip('B.zip', { 'textures/sky.dds': 'B', 'B.esm': 'b' })])
  const c = await core.conflicts(p.id)
  assert.strictEqual(c[0].winner, 'B', 'later mod wins')
  await core.deploy(p.id); assert.strictEqual(read('textures/sky.dds'), 'B')
  await core.moveMod(p.id, 'local:A.zip', 'local:B.zip'); await core.deploy(p.id)
  assert.strictEqual(read('textures/sky.dds'), 'A', 'priority change flips the winner')
  // Incremental deploy: unchanged files are not rewritten; a file the game edited is restored.
  const esp = path.join(tmp, 'game', 'A.esp'), t0 = fs.statSync(esp).mtimeMs
  fs.writeFileSync(path.join(tmp, 'game', 'textures/sky.dds'), 'X'); await core.deploy(p.id)
  assert.strictEqual(fs.statSync(esp).mtimeMs, t0, 'unchanged file skipped'); assert.strictEqual(read('textures/sky.dds'), 'A', 'edited file restored')
  // Drag to top (afterId null), then back
  assert.strictEqual((await core.moveMod(p.id, 'local:A.zip', null)).mods[0].id, 'local:A.zip', 'moved to top')
  await core.moveMod(p.id, 'local:A.zip', 'local:B.zip')
  // Disk cleanup removes only staging folders no mod uses
  fs.mkdirSync(path.join(tmp, 'profiles', p.id, 'files', 'nexus-999', 'x'), { recursive: true }); fs.writeFileSync(path.join(tmp, 'profiles', p.id, 'files', 'nexus-999', 'x', 'y'), 'z')
  assert.deepStrictEqual((await core.diskUsage(p.id)).orphans, ['nexus-999'], 'orphan found')
  assert.strictEqual(await core.cleanup(p.id), 1); assert.strictEqual(read('textures/sky.dds'), 'A'); assert.deepStrictEqual((await core.diskUsage(p.id)).orphans, [])
  // Load order: masters first, custom order kept
  const lo = await core.loadOrder(p.id)
  assert.deepStrictEqual(lo.plugins.map(x => x.name), ['B.esm', 'A.esp'])
  // FOMOD
  const xml = `<config><moduleName>Test</moduleName><requiredInstallFiles><file source="core\\base.txt" destination="base.txt"/></requiredInstallFiles>
    <installSteps><installStep name="Main"><optionalFileGroups><group name="Color" type="SelectExactlyOne"><plugins>
    <plugin name="Red"><description>r</description><files><folder source="red" destination="textures"/></files><typeDescriptor><type name="Recommended"/></typeDescriptor></plugin>
    <plugin name="Blue"><description>b</description><files><folder source="blue" destination="textures"/></files><typeDescriptor><type name="Optional"/></typeDescriptor></plugin>
    </plugins></group></optionalFileGroups></installStep></installSteps></config>`
  const r = await core.addLocal(p.id, [zip('F.zip', { 'F/fomod/ModuleConfig.xml': xml, 'F/core/base.txt': 'base', 'F/red/x.dds': 'red', 'F/blue/x.dds': 'blue' })])
  assert(r.fomod && r.fomod.xml.includes('<installSteps>'), 'installer offered')
  p = await core.fomodFinish(p.id, r.fomod.stage, [{ source: 'core\\base.txt', destination: 'base.txt' }, { source: 'red', destination: 'textures', folder: true }])
  const fm = p.mods.find(m => m.id === 'local:F.zip')
  assert.deepStrictEqual(fm.files.sort(), ['base.txt', 'textures/x.dds'], 'chosen files only')
  // Hardlink deploy + purge
  await core.setSettings({ deployMode: 'hardlink' }); await core.deploy(p.id)
  assert.strictEqual(fs.statSync(path.join(tmp, 'game', 'base.txt')).nlink, 2, 'hardlinked')
  await core.purge(p.id)
  assert(!fs.existsSync(path.join(tmp, 'game', 'base.txt')) && !fs.existsSync(path.join(tmp, 'game', 'A.esp')), 'purged')
  // Uninstall removes the mod's own folder only
  await core.uninstall(p.id, 'local:A.zip')
  assert(fs.existsSync(path.join(tmp, 'profiles', p.id, 'files', fm.stage, 'base.txt')))
  console.log('ok vortex features')
})().catch(e => { console.error(e); process.exitCode = 1 }).finally(() => fs.rmSync(tmp, { recursive: true, force: true }))
