// Mod manager core: profiles on disk + per-site sources. Skipped: database, cache layer, download queue.
const fs = require('fs'), path = require('path'), os = require('os'), zlib = require('zlib')
const { spawn, execFileSync } = require('child_process')
const net = require('net')
const { zipSync, unzipSync, strToU8, strFromU8 } = require('fflate')
const { json, get, q, inside, write, remove, walk } = require('./lib')
const MC = require('./mc'), auth = require('./auth'), tunnel = require('./tunnel'), lib = require('./lib')
const crypto = require('crypto')

const TS = 'https://thunderstore.io', MR = 'https://api.modrinth.com/v2'
// Which sites each profile type can install from; first is the default.
const SOURCES = { thunderstore: ['thunderstore'], modrinth: ['modrinth', 'curseforge'], curseforge: ['curseforge'], nexus: ['nexus'], gamebanana: ['gamebanana'], terraria: ['workshop'] }
const ID = { thunderstore: /^[\w.-]+-\w+$/, modrinth: /^\w+$/, curseforge: /^\d+$/, nexus: /^\d+$/, gamebanana: /^\d+$/, workshop: /^\d+$/ }
const GAME = { thunderstore: /^[\w-]+$/, curseforge: /^\d+$/, nexus: /^\w+$/, gamebanana: /^\d+$/, terraria: /^terraria$/ }
const VER = /^[\w.+-]+$/
const CONFIG_DIR = { thunderstore: 'BepInEx/config', modrinth: 'config', terraria: 'ModConfigs' }
// tModLoader keeps mods in Documents (or OneDrive Documents) on Windows.
const tmlDir = () => [path.join(os.homedir(), 'Documents'), path.join(os.homedir(), 'OneDrive', 'Documents')]
  .map(d => path.join(d, 'My Games', 'Terraria', 'tModLoader')).find(d => fs.existsSync(d))
// Write to a temp file then rename, so a crash never leaves half-written JSON.
const writeAtomic = (file, text) => { fs.writeFileSync(file + '.tmp', text); fs.renameSync(file + '.tmp', file) }
const url = s => typeof s === 'string' && (s.startsWith('https://') || (/^data:image\/(png|jpeg|webp);base64,/.test(s) && s.length < 400e3)) ? s : undefined
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')

const minecraftDir = () => process.platform === 'win32' ? path.join(process.env.APPDATA || os.homedir(), '.minecraft')
  : process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Application Support/minecraft')
  : path.join(os.homedir(), '.minecraft')

// Steam libraries -> installed games, from libraryfolders.vdf + appmanifest_*.acf (Windows only).
function steamGames() {
  if (process.platform !== 'win32') return []
  let root = 'C:\\Program Files (x86)\\Steam'
  try { root = execFileSync('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath']).toString().match(/SteamPath\s+REG_SZ\s+(.+)/)[1].trim() } catch {}
  let vdf = ''
  try { vdf = fs.readFileSync(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8') } catch {}
  const libs = new Set([root, ...[...vdf.matchAll(/"path"\s+"(.+?)"/g)].map(m => m[1].replace(/\\\\/g, '\\'))].map(l => path.normalize(l)))
  return [...libs].flatMap(lib => {
    const dir = path.join(lib, 'steamapps')
    try {
      return fs.readdirSync(dir).filter(f => /^appmanifest_\d+\.acf$/.test(f)).map(f => {
        const acf = fs.readFileSync(path.join(dir, f), 'utf8'), v = k => acf.match(new RegExp(`"${k}"\\s+"(.+?)"`))?.[1]
        return { appid: v('appid'), name: v('name'), dir: path.join(dir, 'common', v('installdir') || '') }
      })
    } catch { return [] }
  })
}

// emit(event, data) pushes launcher progress/logs to the UI; encrypt/decrypt protect stored login tokens.
// Epic Games Store manifests (Windows).
function epicGames() {
  const d = 'C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests'
  try {
    return fs.readdirSync(d).filter(f => f.endsWith('.item')).flatMap(f => {
      try { const j = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); return j.InstallLocation ? [{ name: j.DisplayName, dir: j.InstallLocation, epic: j.AppName, store: 'Epic' }] : [] } catch { return [] }
    })
  } catch { return [] }
}
// GOG Galaxy / offline installers register games here (Windows).
function gogGames() {
  if (process.platform !== 'win32') return []
  try {
    const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games', '/s']).toString()
    return out.split(/\r?\n\r?\n/).flatMap(b => {
      const v = k => b.match(new RegExp(`^\\s+${k}\\s+REG_SZ\\s+(.+)$`, 'm'))?.[1]?.trim()
      return v('path') && v('gameName') ? [{ name: v('gameName'), dir: v('path'), exe: v('exe'), store: 'GOG' }] : []
    })
  } catch { return [] }
}
const allGames = () => [...steamGames().map(g => ({ ...g, store: 'Steam' })), ...epicGames(), ...gogGames()]

// Where mods go inside the game folder, and which plugins.txt (Bethesda) a game uses. Keyed by Nexus domain; names for other sites.
const PRESETS = [
  { domain: 'skyrimspecialedition', name: 'skyrimspecialedition', sub: 'Data', plugins: 'Skyrim Special Edition', star: true },
  { domain: 'skyrim', name: 'skyrim', sub: 'Data', plugins: 'Skyrim' },
  { domain: 'fallout4', name: 'fallout4', sub: 'Data', plugins: 'Fallout4', star: true },
  { domain: 'newvegas', name: 'falloutnewvegas', sub: 'Data', plugins: 'FalloutNV' },
  { domain: 'fallout3', name: 'fallout3', sub: 'Data', plugins: 'Fallout3' },
  { domain: 'oblivion', name: 'oblivion', sub: 'Data', plugins: 'Oblivion' },
  { domain: 'starfield', name: 'starfield', sub: 'Data', plugins: 'Starfield', star: true },
  { domain: 'stardewvalley', name: 'stardewvalley', sub: 'Mods' },
  { domain: 'witcher3', name: 'thewitcher3wildhunt', sub: 'Mods' },
  { domain: 'cyberpunk2077', name: 'cyberpunk2077', sub: '' },
  { domain: 'mountandblade2bannerlord', name: 'mountbladeiibannerlord', sub: 'Modules' },
  { domain: 'valheim', name: 'valheim', sub: '' },
]
const presetOf = p => PRESETS.find(x => (p.type === 'nexus' && x.domain === p.game) || x.name === norm(p.gameName))

module.exports = (root, { emit = () => {}, encrypt = s => s, decrypt = s => s } = {}) => {
  fs.mkdirSync(root, { recursive: true })
  const mcl = MC(path.join(root, '..', 'minecraft'))
  const settingsFile = path.join(root, '..', 'settings.json')
  const settings = () => { try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')) } catch { return {} } }
  const dir = id => inside(root, id)
  // Per-mod staging (like Vortex): each mod installed since this version lives in files/<stage>/, so two mods can ship the same file.
  // Older mods (no m.stage) and shared configs live directly in files/.
  const files = p => path.join(dir(p.id), 'files', p.__stage || '')
  const mbase = (p, m) => path.join(dir(p.id), 'files', m?.stage || '')
  const mf = (p, m, rel) => inside(mbase(p, m), rel)
  const stageKey = (src, id) => `${src}-${id}`.replace(/[^\w.-]/g, '_').slice(0, 120)
  const load = id => JSON.parse(fs.readFileSync(path.join(dir(id), 'profile.json'), 'utf8'))
  const save = p => (writeAtomic(path.join(dir(p.id), 'profile.json'), JSON.stringify(p, null, 1)), p)
  const ctx = { files, settings, dataDir: path.join(root, '..') }
  const S = Object.fromEntries(Object.keys(ID).map(k => [k, require(`./sources/${k}`)(ctx)]))
  const srcOf = (p, m) => m.src || SOURCES[p.type][0]
  const vidOf = m => m.vid ?? m.version

  const create = ({ name, type, game, gameId, gameName, mc, icon, banner }) => {
    if (mc) mc = { version: mc.version, loader: mc.loader, ...(VER.test(mc.loaderVersion || '') ? { loaderVersion: mc.loaderVersion } : {}) }
    if (!SOURCES[type]) throw new Error('Unknown profile type')
    if (type === 'modrinth' ? !(mc && VER.test(mc.version) && /^\w+$/.test(mc.loader)) : !GAME[type].test(game || '') || (type === 'nexus' && !/^\d+$/.test(gameId)))
      throw new Error('Pick a game first')
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    fs.mkdirSync(dir(id), { recursive: true })
    return save({ id, name: String(name || 'Profile').slice(0, 40), type, game, gameId: gameId && String(gameId), gameName: gameName && String(gameName).slice(0, 80),
      mc: type === 'modrinth' ? mc : undefined, icon: url(icon), banner: url(banner),
      target: type === 'modrinth' ? path.join(dir(id), 'minecraft') : type === 'terraria' ? tmlDir() || '' : '', mods: [], extra: [], deployed: [] })
  }

  // After unpacking a generic archive into files/<stage>: start a FOMOD installer (returns true) or strip a leading Data/ (or Mods/) folder.
  function postInstall(p, src, id, mod, stage) {
    const sdir = path.join(dir(p.id), 'files', stage), sub = presetOf(p)?.sub
    const xml = mod.files.find(f => /(^|\/)fomod\/moduleconfig\.xml$/i.test(f))
    if (xml) {
      const pend = path.join(dir(p.id), 'files', `.fomod-${stage}`)
      fs.rmSync(pend, { recursive: true, force: true }); fs.renameSync(sdir, pend)
      p.pendingFomod = { src, id, mod, stage, root: xml.replace(/fomod\/moduleconfig\.xml$/i, '') }
      save(p)
      return true
    }
    if (sub && mod.files.length && mod.files.every(f => f.toLowerCase().startsWith(sub.toLowerCase() + '/'))) {
      const tmp = sdir + '.tmp'; fs.renameSync(sdir, tmp); fs.renameSync(path.join(tmp, mod.files[0].slice(0, sub.length)), sdir); fs.rmSync(tmp, { recursive: true, force: true })
      mod.files = mod.files.map(f => f.slice(sub.length + 1))
    }
    return false
  }
  // Installs a mod (+ required deps) into profile p in place. Returns warnings.
  async function installMod(p, src, id, vid, deps = true, nxm, auto) {
    if (!SOURCES[p.type].includes(src)) throw new Error(`${src} mods can't go in this profile`)
    if (p.mods.some(m => m.id === id)) return []
    const stage = stageKey(src, id)
    fs.rmSync(path.join(dir(p.id), 'files', stage), { recursive: true, force: true })
    p.__stage = stage
    let r
    try { r = await S[src].install(p, id, vid, nxm) } finally { delete p.__stage }
    if (['nexus', 'curseforge', 'gamebanana'].includes(src) && p.type !== 'modrinth' && postInstall(p, src, id, r.mod, stage)) return [{ fomod: stage }]
    p.mods.push({ ...r.mod, src, stage, ...(r.deps.length ? { deps: r.deps.map(d => d.id) } : {}), ...(r.incompat?.length ? { incompat: r.incompat } : {}), ...(auto ? { auto: true } : {}) }); save(p)
    const warns = r.warn ? [r.warn] : []
    if (deps) for (const d of r.deps) warns.push(...await installMod(p, src, d.id, d.vid, true, undefined, true).catch(e => [`Dependency ${d.id}: ${e.message}`]))
    return warns
  }
  const uninstall = (pid, id) => {
    const p = load(pid), m = p.mods.find(m => m.id === id)
    if (m?.stage) fs.rmSync(mbase(p, m), { recursive: true, force: true })
    else if (m) for (const f of m.files) remove(files(p), f)
    p.mods = p.mods.filter(m => m.id !== id)
    return save(p)
  }
  // Install (or switch to) a version; returns the profile with transient warnings.
  // Adds the FOMOD config (+ referenced images as data URLs) to an install result so the window can show the installer.
  const fomodOut = p => {
    const pf = p.pendingFomod
    p.warn = (p.warn || []).filter(w => !w?.fomod)
    if (!pf) return p
    const base = path.join(dir(p.id), 'files', `.fomod-${pf.stage}`)
    const raw = fs.readFileSync(inside(base, pf.root + pf.mod.files.find(f => /(^|\/)fomod\/moduleconfig\.xml$/i.test(f)).slice(pf.root.length)))
    const xml = raw[0] === 0xff && raw[1] === 0xfe ? raw.toString('utf16le') : raw[0] === 0xfe && raw[1] === 0xff ? Buffer.from(raw).swap16().toString('utf16le') : raw.toString('utf8')
    const images = {}
    for (const m of xml.matchAll(/<image\s+path="([^"]+)"/gi)) {
      const rel = pf.root + m[1].replace(/\\/g, '/'), f = pf.mod.files.find(x => x.toLowerCase() === rel.toLowerCase())
      if (f && fs.statSync(inside(base, f)).size < 600e3) images[m[1]] = `data:image/${/\.png$/i.test(f) ? 'png' : 'jpeg'};base64,` + fs.readFileSync(inside(base, f)).toString('base64')
    }
    return { ...p, fomod: { stage: pf.stage, name: pf.mod.name, xml: xml.replace(/^\uFEFF/, ''), images } }
  }
  // Replacing a mod keeps the old files aside until the new version is in, so a failed download never loses the mod.
  const install = async (pid, src, id, vid, nxm, deps = true) => {
    const old = load(pid).mods.find(m => m.id === id)
    if (!old) { const p = load(pid), warn = await installMod(p, src, id, vid, deps, nxm); return fomodOut({ ...p, warn }) }
    const p0 = load(pid), stash = path.join(dir(pid), '.stash'), moved = []
    fs.rmSync(stash, { recursive: true, force: true })
    for (const f of old.files) {
      const from = mf(p0, old, f)
      if (fs.existsSync(from)) { fs.mkdirSync(path.dirname(inside(stash, f)), { recursive: true }); fs.renameSync(from, inside(stash, f)); moved.push(f) }
    }
    save({ ...p0, mods: p0.mods.filter(m => m.id !== id) })
    try {
      const p = load(pid), warn = await installMod(p, src, id, vid, deps, nxm)
      const m = p.mods.find(m => m.id === id)
      if (m) for (const k of ['disabled', 'pinned', 'note', 'auto']) if (old[k] !== undefined) m[k] = old[k]
      if (p.pendingFomod) {
        const keep = path.join(dir(pid), 'files', `.old-${p.pendingFomod.stage}`)
        fs.rmSync(keep, { recursive: true, force: true }); if (fs.existsSync(stash)) fs.renameSync(stash, keep)
        p.pendingFomod.old = old; p.pendingFomod.moved = moved
      }
      save(p)
      if (!old.stage && !p.pendingFomod) for (const f of moved) if (!m?.files.includes(f)) remove(files(p), f) // tidy empty folders left by the old version
      return fomodOut({ ...p, warn })
    } catch (e) {
      const p = load(pid)
      for (const f of moved) { fs.mkdirSync(path.dirname(mf(p, old, f)), { recursive: true }); fs.renameSync(inside(stash, f), mf(p, old, f)) }
      save({ ...p, mods: [...p.mods.filter(m => m.id !== id), old] })
      throw e
    } finally { fs.rmSync(stash, { recursive: true, force: true }) }
  }

  const configs = p => {
    const rel = CONFIG_DIR[p.type]
    return rel && p.target ? Object.fromEntries(walk(path.join(p.target, rel)).map(f => [`${rel}/${f}`, fs.readFileSync(path.join(p.target, rel, f))])) : {}
  }
  const shareData = p => ({ n: p.name, t: p.type, g: p.game, gi: p.gameId, gn: p.gameName, mc: p.mc, i: p.icon, b: p.banner,
    m: p.mods.filter(m => m.src !== 'local').map(m => srcOf(p, m) === SOURCES[p.type][0] ? [m.id, vidOf(m)] : [m.id, vidOf(m), srcOf(p, m)]) })

  // Validates untrusted share data, creates the profile, installs pinned versions and writes shared configs.
  async function importData(d, name, cfg = {}) {
    if (!validData(d)) throw new Error('Invalid share code')
    const p = create({ name: name || d.n, type: d.t, game: d.g, gameId: d.gi, gameName: d.gn, mc: d.mc && { version: d.mc.version, loader: d.mc.loader }, icon: d.i, banner: d.b })
    const failed = []
    for (const [id, v, src = SOURCES[d.t][0]] of d.m) await installMod(p, src, id, v, false).catch(e => failed.push(`${id}: ${e.message}`))
    for (const [rel, data] of Object.entries(cfg)) write(files(p), rel, data), p.extra.push(rel)
    if (d.s && p.type === 'modrinth' && /^[\w.-]+(:\d+)?$/.test(d.s)) addServer(p, d.s)
    save(p)
    return { profile: p, failed }
  }

  // r2modman-compatible profile codes (hosted by Thunderstore, includes configs).
  const r2Yaml = p => `profileName: ${JSON.stringify(p.name)}\ngame: ${p.game}\nmods:\n` + p.mods.filter(m => m.src !== 'local').map(m => {
    const [major = 0, minor = 0, patch = 0] = vidOf(m).split('.').map(Number)
    return `  - name: ${m.id}\n    version:\n      major: ${major}\n      minor: ${minor}\n      patch: ${patch}\n    enabled: ${!m.disabled}\n`
  }).join('')
  async function importR2(key, name, game) {
    const { d, cfg } = await fetchR2(key, game)
    return importData(d, name, cfg)
  }
  async function fetchR2(key, game) {
    const text = await (await get(`${TS}/api/experimental/legacyprofile/get/${q(key)}/`)).text()
    const zip = unzipSync(Buffer.from(text.replace(/^#r2modman\s*/, ''), 'base64'))
    const yaml = strFromU8(zip['export.r2x'] || new Uint8Array())
    const g = yaml.match(/^game:\s*([\w-]+)/m)?.[1] || game
    if (!g) throw new Error('This r2modman code has no game: select a Thunderstore profile of that game first, then import')
    const mods = [...yaml.matchAll(/- name: (\S+)\s+version:\s+major: (\d+)\s+minor: (\d+)\s+patch: (\d+)/g)].map(m => [m[1], `${m[2]}.${m[3]}.${m[4]}`])
    const cfg = Object.fromEntries(Object.entries(zip).filter(([f]) => f !== 'export.r2x' && !f.endsWith('/')))
    const n = yaml.match(/^profileName:\s*(.+)$/m)?.[1]?.replace(/^"|"$/g, '')
    return { d: { n, t: 'thunderstore', g, m: mods }, cfg }
  }

  const setSettingsRaw = patch => { const s = { ...settings(), ...patch }; writeAtomic(settingsFile, JSON.stringify(s, null, 1)); return s }
  const cleanLaunch = o => Object.fromEntries(Object.entries({
    maxMem: +o.maxMem || undefined, minMem: +o.minMem || undefined, width: +o.width || undefined, height: +o.height || undefined, fullscreen: !!o.fullscreen || undefined,
    java: o.java, args: o.args, jvmArgs: o.jvmArgs, env: o.env, preLaunch: o.preLaunch, wrapper: o.wrapper, postExit: o.postExit,
  }).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 2000) : v]))

  // Accounts: refresh tokens are encrypted with the OS keychain (Electron safeStorage) via encrypt/decrypt.
  const accountsFile = path.join(root, '..', 'accounts.json')
  const readAccounts = () => { try { return JSON.parse(fs.readFileSync(accountsFile, 'utf8')).map(a => ({ ...a, refresh: decrypt(a.refresh), token: decrypt(a.token) })) } catch { return [] } }
  const writeAccounts = list => fs.writeFileSync(accountsFile, JSON.stringify(list.map(a => ({ ...a, refresh: encrypt(a.refresh), token: encrypt(a.token) }))))
  const clientId = () => settings().msClientId || (() => { throw new Error('Add your Microsoft (Azure) client ID in Settings first') })()
  let pending = null
  const running = {}, logs = {}
  async function activeAccount() {
    const list = readAccounts(), a = list.find(a => a.uuid === settings().activeAccount) || list[0]
    if (!a) throw new Error('Add a Microsoft account in Settings to play')
    if (a.expires > Date.now() + 5 * 60e3) return a
    const ms = await auth.refresh(clientId(), a.refresh), mc = await auth.minecraft(ms.access_token)
    const fresh = { ...a, ...mc, refresh: ms.refresh_token || a.refresh }
    writeAccounts(list.map(x => x.uuid === a.uuid ? fresh : x))
    return fresh
  }
  const servers = {}
  const pit = require('./playit')(path.join(root, '..'))
  const playitSecret = () => { const v = settings().playitSecret; try { return v ? decrypt(v) : null } catch { return null } }
  lib.progress.hook = d => emit('dl', d)
  const diff = (p, d) => {
    const have = Object.fromEntries(p.mods.filter(m => m.src !== 'local').map(m => [m.id, vidOf(m)])), want = Object.fromEntries(d.m.map(([id, v]) => [id, v]))
    return {
      add: d.m.filter(([id]) => !(id in have)).map(([id]) => id),
      change: d.m.filter(([id, v]) => id in have && have[id] !== v).map(([id]) => p.mods.find(m => m.id === id).name),
      remove: p.mods.filter(m => m.src !== 'local' && !(m.id in want)).map(m => m.name),
    }
  }
  const validData = d => SOURCES[d?.t] && Array.isArray(d.m) && d.m.every(([id, v, src = SOURCES[d.t][0]] = []) => SOURCES[d.t].includes(src) && ID[src].test(id) && VER.test(v))
  // Share code (MM1…), r2modman key, or gist:<id> -> validated share data.
  async function parseShare(input) {
    input = String(input).trim()
    let d, cfg = {}, rev
    if (input.startsWith('gist:')) {
      const g = await json(`https://api.github.com/gists/${q(input.slice(5))}`, { accept: 'application/vnd.github+json' })
      const f = g.files?.['modmanager.json']
      if (!f) throw new Error('Not a Mod Manager live share')
      const text = f.truncated ? await (await get(f.raw_url)).text() : f.content
      d = JSON.parse(text); rev = crypto.createHash('sha1').update(text).digest('hex')
    } else if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input)) {
      const r = await fetchR2(input); d = r.d; cfg = r.cfg
    } else {
      try { d = JSON.parse(zlib.inflateRawSync(Buffer.from(input.replace(/^MM1/, ''), 'base64url'))) } catch { throw new Error('Invalid share code') }
    }
    if (!validData(d)) throw new Error('Invalid share code')
    return { d, cfg, rev }
  }
  async function syncData(pid, d, drop, cfg = {}) {
    let p = load(pid)
    if (p.type !== d.t || (d.g && p.game !== d.g)) throw new Error('That code is for a different game')
    const failed = [], want = new Set(d.m.map(([id]) => id))
    if (drop) for (const m of p.mods.filter(m => m.src !== 'local' && !want.has(m.id))) uninstall(pid, m.id)
    for (const [id, v, src = SOURCES[d.t][0]] of d.m) {
      const m = load(pid).mods.find(m => m.id === id)
      if (m && vidOf(m) === v) continue
      await install(pid, src, id, v, undefined, false).catch(e => failed.push(`${id}: ${e.message}`))
    }
    p = load(pid)
    for (const [rel, data] of Object.entries(cfg)) write(files(p), rel, data), p.extra.push(rel)
    return { profile: save(p), failed }
  }
  // servers.dat entry so friends see the invited server in Worlds / the game list.
  const addServer = (p, address) => {
    const f = path.join(p.target, 'servers.dat'), list = MC.readServers(f).filter(s => s.ip !== address)
    fs.mkdirSync(p.target, { recursive: true }); MC.writeServers(f, [{ name: `${p.name} (friend)`, ip: address }, ...list])
  }
  // Profile snapshots: the mod list (exact versions) + flags. Rollback re-downloads those versions, so snapshots stay tiny.
  const snapDir = pid => path.join(dir(pid), 'snapshots')
  function snapshot(pid, reason = 'Manual') {
    const p = load(pid)
    if (!p.mods.length) return null
    const id = `${Date.now()}`
    write(snapDir(pid), `${id}.json`, JSON.stringify({ time: Date.now(), reason: String(reason).slice(0, 80), data: shareData(p),
      flags: Object.fromEntries(p.mods.map(m => [m.id, { disabled: m.disabled, pinned: m.pinned, note: m.note }])) }))
    const all = fs.readdirSync(snapDir(pid)).filter(f => f.endsWith('.json')).sort()
    for (const f of all.slice(0, -25)) fs.rmSync(path.join(snapDir(pid), f), { force: true })
    return id
  }
  const isShaderPack = async data => { try { return Object.keys(unzipSync(data)).some(f => f.startsWith('shaders/')) } catch { return false } }

  const pluginsTxt = pre => path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), pre.plugins, 'Plugins.txt')
  const deployRaw = (id, { vanilla } = {}) => {
    const p = load(id)
    if (!p.target) throw new Error('Set the target folder first')
    for (const f of p.deployed || []) remove(p.target, f)
    const on = vanilla ? [] : p.mods.filter(m => !m.disabled)
    // Later mods in the list win file conflicts; shared configs (extra) win over everything.
    const src = new Map()
    for (const m of on) for (const f of m.files) src.set(f, mf(p, m, f))
    if (!vanilla) for (const f of p.extra || []) src.set(f, inside(path.join(dir(p.id), 'files'), f))
    p.deployed = [...src.keys()]
    const link = settings().deployMode === 'hardlink'
    for (const [f, from] of src) {
      const to = inside(p.target, f)
      fs.mkdirSync(path.dirname(to), { recursive: true })
      if (link) { try { fs.linkSync(from, to); continue } catch {} } // different drive: fall back to copying
      fs.copyFileSync(from, to)
    }
    // Bethesda games read the plugin load order from %LOCALAPPDATA%/<game>/Plugins.txt.
    const pre = presetOf(p)
    if (pre?.plugins && process.platform === 'win32') {
      const names = on.flatMap(m => m.files.filter(f => !f.includes('/') && /\.(esm|esl|esp)$/i.test(f)))
      const order = p.loadOrder || [], rank = n => { const i = order.indexOf(n); return i < 0 ? 1e6 : i }, master = n => /\.(esm|esl)$/i.test(n)
      names.sort((a, b) => (master(b) - master(a)) || rank(a) - rank(b))
      const off = new Set(p.pluginsOff || [])
      const lines = names.map(n => pre.star ? `${off.has(n) ? '' : '*'}${n}` : off.has(n) ? null : n).filter(Boolean)
      try { fs.mkdirSync(path.dirname(pluginsTxt(pre)), { recursive: true }); fs.writeFileSync(pluginsTxt(pre), '# Written by Mod Manager\r\n' + lines.join('\r\n') + '\r\n') } catch {}
    }
    // tModLoader loads only mods listed in Mods/enabled.json.
    if (p.type === 'terraria') write(p.target, 'Mods/enabled.json', JSON.stringify(on.flatMap(m => m.files).filter(f => f.endsWith('.tmod')).map(f => path.basename(f, '.tmod'))))
    p.extra = [] // shared configs apply once; afterwards the game's own files win
    return save(p)
  }

  // ---- Minecraft server internals ----
  const PROPS = ['motd', 'gamemode', 'force-gamemode', 'difficulty', 'pvp', 'max-players', 'view-distance', 'simulation-distance', 'allow-flight', 'spawn-protection',
    'level-seed', 'level-name', 'hardcore', 'white-list', 'enforce-whitelist', 'allow-nether', 'spawn-monsters', 'enable-command-block', 'online-mode', 'server-port',
    'resource-pack', 'resource-pack-sha1', 'require-resource-pack', 'resource-pack-prompt', 'server-name', 'allow-cheats', 'allow-list']
  const readProps = file => { try { return Object.fromEntries(fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])) } catch { return {} } }
  const writeProps = (file, obj) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Object.entries(obj).map(([k, v]) => `${k}=${v}`).join('\n') + '\n') }
  const lastLogs = {}, crashes = {}, lastIssues = {}
  const GEYSER = { fabric: ['geyser', 'floodgate'], neoforge: ['geyser', 'floodgate'], paper: ['geyser', 'floodgate'], purpur: ['geyser', 'floodgate'] }
  const PLUGIN_LOADERS = ['paper', 'purpur', 'spigot', 'bukkit']
  const kindOf = p => p.server?.kind || 'profile'
  const sdirOf = (pid, kind = kindOf(load(pid))) => path.join(dir(pid), kind === 'bedrock' ? 'server-bedrock' : 'server')
  const worldDirs = (pid, kind) => {
    const level = readProps(path.join(sdirOf(pid, kind), 'server.properties'))['level-name'] || (kind === 'bedrock' ? 'Bedrock level' : 'world')
    return kind === 'bedrock' ? [`worlds/${level}`] : [level, `${level}_nether`, `${level}_the_end`]
  }
  const portFree = port => new Promise(ok => { const t = net.createServer().once('error', () => ok(false)).once('listening', () => t.close(() => ok(true))).listen(port) })

  async function backupWorld(pid) {
    const kind = kindOf(load(pid)), sdir = sdirOf(pid, kind), s = servers[pid], dirs = worldDirs(pid, kind)
    if (!fs.existsSync(path.join(sdir, dirs[0]))) throw new Error('No world yet: start the server once')
    const [off, on] = kind === 'bedrock' ? ['save hold\n', 'save resume\n'] : ['save-off\nsave-all flush\n', 'save-on\n']
    if (s?.online) { s.child.stdin.write(off); await new Promise(r => setTimeout(r, 3000)) }
    try {
      // shortcut: whole world is zipped in memory; fine for normal worlds, slow for multi-GB ones.
      const zip = {}
      for (const d of dirs) for (const f of walk(path.join(sdir, d))) if (!f.endsWith('session.lock')) zip[`${d}/${f}`] = fs.readFileSync(path.join(sdir, d, f))
      const name = `${path.basename(dirs[0]).replace(/[^\w.-]/g, '_')}-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}.zip`
      write(path.join(dir(pid), 'server-backups'), name, zipSync(zip, { level: 1 }))
      return name
    } finally { if (s?.online) s.child.stdin.write(on) }
  }

  // Reads the server log and explains common startup failures.
  function analyzeServer(lines) {
    const t = lines.join('\n'), out = []
    if (/FAILED TO BIND TO PORT|Address already in use|Port \d+ may already be in use/i.test(t)) out.push('The port is already used by another program (maybe another server). Change the port in Settings.')
    if (/You need to agree to the EULA/i.test(t)) out.push('The Minecraft EULA was not accepted.')
    for (const m of t.matchAll(/Mod '([^']+)' \([\w-]+\) [^ ]+ requires (?:any version|version [^ ]+) of (?:mod )?'?([^',\n]+?)'?(?:,| which is missing)/g)) out.push(`${m[1]} needs "${m[2]}", which is missing. Install it in Browse.`)
    for (const m of t.matchAll(/Mod ([\w-]+) requires ([\w-]+) [^\n]*/g)) out.push(`${m[1]} needs ${m[2]}.`)
    if (/Missing or unsupported mandatory dependencies/i.test(t)) out.push('A mod is missing a required dependency (see the log lines above "Missing or unsupported mandatory dependencies").')
    if (/Incompatible mods? found|Incompatible mod set/i.test(t)) out.push('Some mods are incompatible with each other. Check the conflict lines in the log.')
    if (/has been compiled by a more recent version of the Java Runtime|UnsupportedClassVersionError/i.test(t)) out.push('A mod needs a newer Java than this Minecraft version uses.')
    if (/environment type SERVER|Attempted to load class .* for invalid dist DEDICATED_SERVER|client-only/i.test(t)) out.push('A client-only mod was loaded on the server. Disable it for the server (or remove it).')
    if (/OutOfMemoryError|Java heap space/i.test(t)) out.push('The server ran out of memory. Give it more RAM in Settings.')
    return [...new Set(out)]
  }

  // Bedrock Dedicated Server: official download links API; keeps worlds and config files on update.
  async function prepareBedrock(sdir, log) {
    const key = process.platform === 'win32' ? 'serverBedrockWindows' : 'serverBedrockLinux'
    const url = (await json('https://net-secondary.web.minecraft-services.net/api/v1.0/download/links')).result.links.find(l => l.downloadType === key)?.downloadUrl
    if (!url) throw new Error('No Bedrock server for this OS')
    const exe = path.join(sdir, process.platform === 'win32' ? 'bedrock_server.exe' : 'bedrock_server'), verFile = path.join(sdir, '.version')
    if (!fs.existsSync(exe) || (fs.existsSync(verFile) && fs.readFileSync(verFile, 'utf8') !== url)) {
      log(`Downloading ${path.basename(url)}…`)
      const keep = new Set(['server.properties', 'permissions.json', 'allowlist.json'])
      for (const [f, d] of Object.entries(unzipSync(await lib.bytes(url)))) if (!f.endsWith('/') && !(keep.has(f) && fs.existsSync(path.join(sdir, f))) && !f.startsWith('worlds/')) write(sdir, f, d)
      if (process.platform !== 'win32') fs.chmodSync(exe, 0o755)
      fs.writeFileSync(verFile, url)
    }
    return { java: exe, args: [], env: process.platform === 'win32' ? {} : { LD_LIBRARY_PATH: '.' } }
  }

  // Plugins (Paper/Purpur) from Modrinth or Hangar, stored in server/plugins and tracked in profile.server.plugins.
  async function pluginFile(p, src, id) {
    if (src === 'modrinth') {
      const v = (await json(`${MR}/project/${q(id)}/version?loaders=${q(PLUGIN_LOADERS)}&game_versions=${q([p.mc.version])}`))[0]
      if (!v) throw new Error('No plugin build for this Minecraft version')
      const proj = await json(`${MR}/project/${q(id)}`), f = v.files.find(f => f.primary) || v.files[0]
      return { name: proj.title, version: v.version_number, url: f.url, file: path.basename(f.filename), icon: proj.icon_url }
    }
    const [owner, slug] = id.split('/')
    const base = `https://hangar.papermc.io/api/v1/projects/${q(slug)}/versions?platform=PAPER&limit=1`
    // Some plugins (e.g. Floodgate) don't tag Minecraft versions; fall back to their newest build.
    const r = (await json(`${base}&platformVersion=${q(p.mc.version)}`)).result?.length ? await json(`${base}&platformVersion=${q(p.mc.version)}`) : await json(base)
    const v = r.result?.[0], d = v?.downloads?.PAPER
    if (!d) throw new Error('No Hangar build for this Minecraft version')
    if (!d.downloadUrl) throw new Error(`This plugin is hosted elsewhere: ${d.externalUrl}`)
    return { name: slug, version: v.name, url: d.downloadUrl, file: d.fileInfo?.name || `${slug}-${v.name}.jar`, icon: `https://hangar.papermc.io/api/internal/projects/project/${q(owner)}/${q(slug)}/icon` }
  }

  async function startServer(pid, opts = {}) {
    const { eula, maxMem = 2048, port, online = true, geyser = false, autoRestart = false, backupOnStop = false, kind = 'profile',
      backupEvery = 0, restartEvery = 0, onStart = '', onStop = '' } = opts
    if (!eula) throw new Error('Accept the Minecraft EULA first')
    if (servers[pid]) throw new Error('Server already running')
    let p = load(pid)
    if (p.type !== 'modrinth') throw new Error('Servers are for Minecraft profiles')
    const sport = +port || (kind === 'bedrock' ? 19132 : 25565)
    p = save({ ...p, server: { ...p.server, kind, maxMem: +maxMem, port: sport, online: !!online, geyser: !!geyser, autoRestart: !!autoRestart, backupOnStop: !!backupOnStop,
      backupEvery: +backupEvery || 0, restartEvery: +restartEvery || 0, onStart: String(onStart).slice(0, 2000), onStop: String(onStop).slice(0, 2000), eula: true } })
    if (kind !== 'bedrock' && !await portFree(sport)) throw new Error(`Port ${sport} is used by another program. Pick another port in Settings.`)
    const sdir = sdirOf(pid, kind), s = servers[pid] = { log: [], online: false, players: new Set(), timers: [] }
    const log = line => { s.log.push(line); if (s.log.length > 3000) s.log.shift(); emit('slog', { pid, line }) }
    const status = () => emit('sstatus', { pid })
    delete lastIssues[pid]
    try {
      await syncPull(pid, log)
      log('Preparing server files…')
      let plan
      if (kind === 'bedrock') plan = await prepareBedrock(sdir, log)
      else plan = await mcl.prepareServer({ mc: p.mc.version, loader: kind === 'profile' ? p.mc.loader : kind, loaderVersion: kind === 'profile' ? p.mc.loaderVersion : null, dir: sdir, log })
      const loader = kind === 'profile' ? p.mc.loader : kind
      if (kind === 'profile') {
        // Server-side files only: every jar is looked up on Modrinth by SHA1 (packs, CurseForge and local files too); client-only projects are skipped.
        const on = p.mods.filter(m => !m.disabled)
        const wantM = on.flatMap(m => m.files.filter(f => (/^mods\/.+\.jar$/i.test(f) || (m.pack && /^(config|defaultconfigs|kubejs|scripts|datapacks)\//.test(f))) && !m.clientOnly?.includes(f)).map(f => [f, mf(p, m, f)]))
        const want = wantM.map(([f]) => f), fromOf = Object.fromEntries(wantM)
        const hash = Object.fromEntries(want.filter(f => f.endsWith('.jar')).map(f => [crypto.createHash('sha1').update(fs.readFileSync(fromOf[f])).digest('hex'), f]))
        const found = Object.keys(hash).length ? await json(`${MR}/version_files`, { 'content-type': 'application/json' }, { method: 'POST', body: JSON.stringify({ hashes: Object.keys(hash), algorithm: 'sha1' }) }).catch(() => ({})) : {}
        const ids = [...new Set(Object.values(found).map(v => v.project_id))], side = {}
        for (let i = 0; i < ids.length; i += 100) for (const x of await json(`${MR}/projects?ids=${q(ids.slice(i, i + 100))}`).catch(() => [])) side[x.id] = x.server_side
        const clientOnly = new Set(Object.entries(found).filter(([, v]) => side[v.project_id] === 'unsupported').map(([h]) => hash[h]))
        fs.rmSync(path.join(sdir, 'mods'), { recursive: true, force: true })
        for (const f of want) if (!clientOnly.has(f)) write(sdir, f, fs.readFileSync(fromOf[f]))
        if (clientOnly.size) log(`Skipped ${clientOnly.size} client-only mods`)
        s.have = new Set([...Object.values(found).map(v => v.project_id), ...on.map(m => m.id)])
      }
      if (geyser && (kind === 'paper' || kind === 'purpur')) {
        // Paper/Purpur: official GeyserMC downloads (Floodgate for Paper is not on Modrinth).
        for (const proj of ['geyser', 'floodgate']) if (!fs.existsSync(path.join(sdir, 'plugins', `${proj}-spigot.jar`)))
          write(sdir, `plugins/${proj}-spigot.jar`, await lib.bytes(`https://download.geysermc.org/v2/projects/${proj}/versions/latest/builds/latest/downloads/spigot`))
        s.bedrock = `${lanIp()}:19132`
      } else if (geyser && kind !== 'bedrock') {
        if (!GEYSER[loader]) throw new Error('Bedrock crossplay (Geyser) needs Fabric, NeoForge, Paper or Purpur')
        const folder = kind === 'profile' ? 'mods' : 'plugins', loaders = kind === 'profile' ? [loader] : PLUGIN_LOADERS
        const have = s.have || new Set(), todo = [...GEYSER[loader]]
        while (todo.length) {
          const slug = todo.shift()
          const v = (await json(`${MR}/project/${slug}/version?loaders=${q(loaders)}&game_versions=${q([p.mc.version])}`))[0]
          if (!v) throw new Error(`${slug} has no build for ${loader} ${p.mc.version}`)
          if (have.has(v.project_id)) continue
          have.add(v.project_id)
          const f = v.files.find(f => f.primary) || v.files[0]
          if (!fs.existsSync(path.join(sdir, folder, path.basename(f.filename)))) write(sdir, `${folder}/${path.basename(f.filename)}`, await lib.bytes(f.url))
          todo.push(...v.dependencies.filter(d => d.dependency_type === 'required' && d.project_id && !have.has(d.project_id)).map(d => d.project_id))
        }
        s.bedrock = `${lanIp()}:19132`
      }
      if (kind === 'bedrock') s.bedrock = `${lanIp()}:${sport}`
      if (kind !== 'bedrock') fs.writeFileSync(path.join(sdir, 'eula.txt'), 'eula=true\n')
      const propsFile = path.join(sdir, 'server.properties'), props = readProps(propsFile)
      writeProps(propsFile, kind === 'bedrock'
        ? { 'server-name': p.name.replace(/[\r\n;]/g, ''), 'max-players': 10, ...props, 'server-port': sport, 'online-mode': !!online }
        : { motd: p.name.replace(/[\r\n]/g, ''), 'max-players': 10, ...props, 'server-port': sport, 'online-mode': !!online })
      const args = kind === 'bedrock' ? [] : [`-Xmx${+maxMem}M`, '-Dlog4j2.formatMsgNoLookups=true', ...plan.args]
      const child = s.child = spawn(plan.java, args, { cwd: sdir, env: { ...process.env, ...plan.env } })
      const run = text => String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean).forEach(c => child.stdin.write(c + '\n'))
      const out = d => String(d).split(/\r?\n/).filter(Boolean).forEach(l => {
        log(l)
        if (!s.online && /Done \(|Server started\./.test(l)) {
          s.online = true; s.since = Date.now(); status(); run(onStart)
          // Scheduler: periodic backups / restarts.
          if (+backupEvery) s.timers.push(setInterval(() => backupWorld(pid).then(n => log(`Scheduled backup: ${n}`)).catch(e => log(`Backup failed: ${e.message}`)), backupEvery * 3600e3))
          if (+restartEvery) s.timers.push(setInterval(() => { run(onStop); s.restart = true; s.stopping = true; run('stop') }, restartEvery * 3600e3))
        }
        const j = l.match(/: (\w{1,16}) joined the game|Player connected: ([^,]+),/), left = l.match(/: (\w{1,16}) left the game|Player disconnected: ([^,]+),/)
        if (j) s.players.add(j[1] || j[2]), status()
        if (left) s.players.delete(left[1] || left[2]), status()
      })
      child.stdout.on('data', out); child.stderr.on('data', out)
      child.on('error', e => log(`Could not start: ${e.message}`))
      child.on('exit', async code => {
        s.timers.forEach(clearInterval); s.tunnel?.close(); log(`Server stopped (code ${code})`)
        if (s.playit && !Object.values(servers).some(x => x !== s && x.playit)) pit.stopAgent()
        lastLogs[pid] = s.log; delete servers[pid]
        if (!s.stopping) lastIssues[pid] = analyzeServer(s.log)
        const o = load(pid).server || {}
        if (syncDirOf(load(pid))) { await syncPush(pid, log).catch(e => log(`World sync failed: ${e.message}`)); if (!s.restart) releaseLock(pid) }
        if (o.backupOnStop) await backupWorld(pid).then(n => log(`Backup saved: ${n}`)).catch(e => log(`Backup failed: ${e.message}`))
        status()
        // Auto-restart after a crash, or after Restart. At most 3 crash restarts within 10 minutes, so a broken mod doesn't loop forever.
        const recent = (crashes[pid] = [...(crashes[pid] || []), Date.now()].filter(t => Date.now() - t < 600e3))
        if (!s.restart && !s.stopping && o.autoRestart && recent.length > 3) return log('Crashed 3 times in a row — not restarting. Check the console.')
        if (s.restart || (o.autoRestart && !s.stopping)) {
          log(s.restart ? 'Restarting…' : 'Server crashed — restarting in 5 seconds…')
          setTimeout(() => startServer(pid, { ...o, eula: true }).catch(e => emit('slog', { pid, line: `Restart failed: ${e.message}` })), s.restart ? 500 : 5000)
        }
      })
      s.stopCmds = onStop
      // Heartbeat keeps the host lock fresh; periodic upload protects against a crash losing the shared world.
      if (syncDirOf(p)) {
        s.timers.push(setInterval(() => { try { writeLock(syncDirOf(load(pid)), { heartbeat: Date.now(), address: s.address || null }) } catch {} }, 30e3))
        s.timers.push(setInterval(() => syncPush(pid, log).catch(e => log(`World sync failed: ${e.message}`)), 30 * 60e3))
      }
      s.lan = `${lanIp()}:${sport}`
      status()
      return true
    } catch (e) { lastLogs[pid] = s.log; lastIssues[pid] = analyzeServer(s.log); delete servers[pid]; if (!/hosting this world/.test(e.message)) releaseLock(pid); status(); throw e }
  }
  // ---- World sync: a shared cloud folder (Google Drive / OneDrive / Dropbox) holds world.zip + meta.json + lock.json ----
  // shortcut: relies on the cloud app to sync files; a lock older than 3 minutes counts as abandoned (host crashed or went offline).
  const SYNC_FILES = ['server.properties', 'ops.json', 'whitelist.json', 'banned-players.json', 'banned-ips.json', 'allowlist.json', 'permissions.json', 'server-icon.png']
  const LOCK_STALE = 180e3
  const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }
  const syncDirOf = p => p.server?.syncDir && fs.existsSync(p.server.syncDir) ? p.server.syncDir : null
  // MM_SYNC_NAME lets tests run two "friends" on one machine.
  const me = () => { if (process.env.MM_SYNC_NAME) return process.env.MM_SYNC_NAME; const a = readAccounts().find(a => a.uuid === settings().activeAccount); return (a?.name || os.userInfo().username || 'host') + '@' + os.hostname() }
  const lockInfo = dir => {
    const l = readJson(path.join(dir, 'lock.json'))
    return l && Date.now() - l.heartbeat < LOCK_STALE ? { ...l, mine: l.host === me() } : null
  }
  const writeLock = (dir, extra = {}) => fs.writeFileSync(path.join(dir, 'lock.json'), JSON.stringify({ host: me(), since: Date.now(), heartbeat: Date.now(), ...readJson(path.join(dir, 'lock.json')), ...extra, ...(extra.host ? {} : { host: me() }) }))

  // Download the newest shared world if it is newer than ours (keeping a backup of ours first), then take the host lock.
  async function syncPull(pid, log) {
    const p = load(pid), dir = syncDirOf(p)
    if (!dir) return
    const lock = lockInfo(dir)
    if (lock && !lock.mine) throw new Error(`${lock.host.split('@')[0]} is hosting this world right now${lock.address ? ` at ${lock.address}` : ''}. Join them instead.`)
    const meta = readJson(path.join(dir, 'meta.json')), mine = p.server?.syncVersion || 0
    if (meta && meta.version > mine) {
      const kind = kindOf(p), sdir = sdirOf(pid, kind), zipFile = path.join(dir, 'world.zip')
      if (!fs.existsSync(zipFile)) throw new Error('The shared folder has meta.json but no world.zip yet — wait for your cloud app to finish syncing')
      if (fs.existsSync(path.join(sdir, worldDirs(pid, kind)[0]))) await backupWorld(pid).then(n => log(`Backed up your old copy: ${n}`))
      log(`Downloading shared world v${meta.version} (saved by ${String(meta.by).split('@')[0]} ${new Date(meta.savedAt).toLocaleString()})…`)
      const zip = unzipSync(fs.readFileSync(zipFile))
      for (const d of worldDirs(pid, kind)) fs.rmSync(inside(sdir, d), { recursive: true, force: true })
      for (const [f, data] of Object.entries(zip)) if (!f.endsWith('/')) write(sdir, f, data)
      save({ ...load(pid), server: { ...load(pid).server, syncVersion: meta.version } })
    } else log(meta ? `Shared world is up to date (v${meta.version})` : 'Shared folder is empty — your world will be uploaded when the server stops')
    writeLock(dir, { host: me(), since: Date.now(), heartbeat: Date.now(), address: null })
  }

  // Upload the world (atomic: temp file + rename) and bump the version.
  async function syncPush(pid, log) {
    const p = load(pid), dir = syncDirOf(p)
    if (!dir) return
    const kind = kindOf(p), sdir = sdirOf(pid, kind), s = servers[pid]
    if (!fs.existsSync(path.join(sdir, worldDirs(pid, kind)[0]))) return
    const lock = lockInfo(dir)
    if (lock && !lock.mine) throw new Error(`Not uploading: ${lock.host.split('@')[0]} is hosting now`)
    if (s?.online) { s.child.stdin.write(kind === 'bedrock' ? 'save hold\n' : 'save-off\nsave-all flush\n'); await new Promise(r => setTimeout(r, 3000)) }
    try {
      const zip = {}
      for (const d of worldDirs(pid, kind)) for (const f of walk(path.join(sdir, d))) if (!f.endsWith('session.lock')) zip[`${d}/${f}`] = fs.readFileSync(path.join(sdir, d, f))
      for (const f of SYNC_FILES) if (fs.existsSync(path.join(sdir, f))) zip[f] = fs.readFileSync(path.join(sdir, f))
      const version = Math.max(p.server?.syncVersion || 0, readJson(path.join(dir, 'meta.json'))?.version || 0) + 1
      fs.writeFileSync(path.join(dir, 'world.zip.tmp'), zipSync(zip, { level: 1 }))
      fs.renameSync(path.join(dir, 'world.zip.tmp'), path.join(dir, 'world.zip'))
      fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ version, savedAt: Date.now(), by: me(), mc: p.mc.version, kind }))
      save({ ...load(pid), server: { ...load(pid).server, syncVersion: version } })
      log?.(`World uploaded to the shared folder (v${version})`)
      return version
    } finally { if (s?.online) s.child.stdin.write(kind === 'bedrock' ? 'save resume\n' : 'save-on\n') }
  }
  const releaseLock = pid => { const dir = syncDirOf(load(pid)); if (dir && lockInfo(dir)?.mine) fs.rmSync(path.join(dir, 'lock.json'), { force: true }) }

  const lanIp = () => Object.values(os.networkInterfaces()).flat().find(i => i.family === 'IPv4' && !i.internal)?.address || 'localhost'

  // One write at a time: profile.json is read-modify-written.
  let chain = Promise.resolve()
  const serial = fn => (...a) => { const r = chain.then(() => fn(...a)); chain = r.catch(() => {}); return r }
  const serialDeploy = (id, o) => serial(deployRaw)(id, o)
  const parallel = ['listProfiles', 'games', 'mcVersions', 'search', 'checkUpdates', 'details', 'getSettings', 'launch', 'exportCode', 'exportR2', 'exportFile',
    'preview', 'checkFollow', 'publish', 'analyzeCrash', 'javaList', 'conflicts', 'orphans', 'serverStatus', 'serverCmd', 'serverStop', 'serverStart', 'serverShare', 'inviteCode', 'serverRestart', 'serversRunning',
    'serverProps', 'serverPlayers', 'playerAction', 'backups', 'backup', 'pluginSearch', 'shareLog', 'diagnostics', 'sha1Url', 'playitStatus', 'playitLinkStart', 'playitLinkFinish', 'syncStatus', 'snapshots', 'changelog', 'setupStatus', 'playOfficial', 'loadOrder', 'collections', 'collectionMods', 'endorse', 'runTool',
    'accounts', 'loginStart', 'loginFinish', 'filters', 'running', 'getLog', 'stop', 'play', 'repair', 'worlds', 'logFiles', 'readLog', 'exportMrpack']

  return Object.fromEntries(Object.entries({
    // A damaged profile.json is skipped instead of breaking the whole list.
    listProfiles: () => fs.readdirSync(root).filter(d => fs.existsSync(path.join(root, d, 'profile.json'))).flatMap(d => { try { return [load(d)] } catch { return [] } }),
    createProfile: create,
    updateProfile: (id, patch) => {
      const p = load(id)
      if (patch.name) p.name = String(patch.name).slice(0, 40)
      if (patch.target) p.target = String(patch.target)
      if ('icon' in patch) p.icon = url(patch.icon)
      if ('group' in patch) p.group = String(patch.group || '').slice(0, 30) || undefined
      if (patch.launch) p.launch = cleanLaunch(patch.launch)
      return save(p)
    },
    deleteProfile: id => {
      if (servers[id] || running[id]) throw new Error('Stop the game and server of this profile first')
      fs.rmSync(dir(id), { recursive: true, force: true })
    },
    // Secrets that only the main process needs are not sent to the window.
    getSettings: () => { const { playitSecret: _, ...s } = settings(); return s },
    setSettings: patch => {
      // Appearance values are validated; the rest are plain strings/booleans.
      const LOOK = { theme: v => ['midnight', 'amoled', 'dark', 'light'].includes(v), accent: v => /^#[0-9a-f]{6}$/i.test(v), density: v => ['comfy', 'compact'].includes(v),
        scale: v => v >= 80 && v <= 130, motion: v => typeof v === 'boolean', descs: v => typeof v === 'boolean', rememberLast: v => typeof v === 'boolean' }
      for (const [k, ok] of Object.entries(LOOK)) if (k in patch && !ok(patch[k])) delete patch[k]
      const pick = ['curseforgeKey', 'nexusKey', 'nxmHandler', 'modrinthToken', 'msClientId', 'githubToken', 'autoStart', 'autoUpdate', 'tunnel', 'deployMode', ...Object.keys(LOOK)].filter(k => k in patch)
      return setSettingsRaw({ ...Object.fromEntries(pick.map(k => [k, patch[k]])), ...(patch.launch ? { launch: cleanLaunch(patch.launch) } : {}) })
    },

    games: (type, text) => S[type].games(text),
    search: (pid, src, text = '', page = 1, opts = {}) => S[src].search(load(pid), text, page, opts),
    details: async (pid, src, id) => { const p = load(pid); return { ...await S[src].details(p, id), url: S[src].url(p, id) } },
    pageUrl: (pid, src, id) => S[src].url(load(pid), id),

    install,
    uninstall,
    setAllDisabled: (pid, disabled) => {
      const p = load(pid)
      p.mods.forEach(m => m.disabled = !!disabled || undefined)
      return save(p)
    },
    setDisabled: (pid, id, disabled) => {
      const p = load(pid), m = p.mods.find(m => m.id === id)
      if (m) m.disabled = !!disabled
      return save(p)
    },
    // Returns { [modId]: newVersion } for mods with a newer compatible release.
    checkUpdates: async pid => {
      const p = load(pid)
      const latest = await Promise.all(p.mods.map(m => m.src === 'local' || m.pinned ? null : S[srcOf(p, m)].latest(p, m).catch(() => null)))
      return Object.fromEntries(p.mods.map((m, i) => [m.id, latest[i]]).filter(([m, v], i) => v && v.vid !== vidOf(p.mods[i])).map(([id, v]) => [id, { version: v.version, vid: String(v.vid) }]))
    },
    update: async (pid, id) => {
      const was = load(pid).mods.find(m => m.id === id)
      if (!was) throw new Error('Mod not installed')
      return install(pid, srcOf(load(pid), was), id, null)
    },

    // Copy enabled mods + shared configs into the target folder; removes what the previous deploy put there first.
    deploy: (id, o) => deployRaw(id, o),

    findGame: id => {
      const p = load(id)
      let found = p.type === 'modrinth' ? fs.existsSync(minecraftDir()) && minecraftDir() : p.type === 'terraria' ? tmlDir() : null
      if (!found && p.type === 'terraria') throw new Error('tModLoader folder not found — start tModLoader once, or pick Documents/My Games/Terraria/tModLoader')
      if (!found) {
        const games = allGames(), n = norm(p.gameName || p.game)
        found = (games.find(g => norm(g.name) === n) || games.find(g => norm(g.name).includes(n) || n.includes(norm(g.name))))?.dir
        const sub = presetOf(p)?.sub
        if (found && sub) found = path.join(found, sub)
      }
      if (!found) throw new Error(process.platform === 'win32' ? 'Game not found in Steam, Epic or GOG — pick the folder manually' : 'Auto-find works on Windows only')
      return save({ ...p, target: found })
    },
    launch: (id, { vanilla } = {}) => {
      if (vanilla) deployRaw(id, { vanilla: true })
      const p = load(id), args = (p.launch?.args || '').trim()
      if (process.platform !== 'win32') throw new Error('Launch works on Windows only')
      const run = (cmd, args) => spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref()
      if (p.type === 'modrinth') {
        const exe = ['ProgramFiles(x86)', 'ProgramFiles'].map(k => process.env[k] && path.join(process.env[k], 'Minecraft Launcher', 'MinecraftLauncher.exe')).find(f => f && fs.existsSync(f))
        return exe ? run(exe, []) : run('explorer.exe', ['shell:AppsFolder\\Microsoft.4297127D64EC6_8wekyb3d8bbwe!Minecraft'])
      }
      const steamRun = appid => run('explorer.exe', [args ? `steam://run/${appid}//${args}/` : `steam://rungameid/${appid}`])
      if (p.type === 'terraria') return steamRun(1281930)
      const t = path.normalize(p.target || '').toLowerCase()
      const g = t && allGames().find(g => (t + path.sep).startsWith(path.normalize(g.dir).toLowerCase() + path.sep))
      if (!g) throw new Error('Game not found in Steam, Epic or GOG — start it yourself')
      if (g.epic) return run('explorer.exe', [`com.epicgames.launcher://apps/${encodeURIComponent(g.epic)}?action=launch&silent=true`])
      if (g.store === 'GOG') return g.exe ? run(g.exe, (args || '').split(/\s+/).filter(Boolean)) : run('explorer.exe', [g.dir])
      steamRun(g.appid)
    },

    // FOMOD: copy the chosen files ({ source, destination, folder }) from the unpacked archive into the mod's own folder.
    fomodFinish: (pid, stage, picks) => {
      const p = load(pid), pf = p.pendingFomod
      if (!pf || pf.stage !== stage) throw new Error('No installer waiting')
      const pend = path.join(dir(p.id), 'files', `.fomod-${stage}`), out = path.join(dir(p.id), 'files', stage), sub = presetOf(p)?.sub, files = new Set()
      fs.rmSync(out, { recursive: true, force: true })
      const norm1 = x => String(x || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
      const strip = d => sub && d.toLowerCase().startsWith(sub.toLowerCase() + '/') ? d.slice(sub.length + 1) : sub && d.toLowerCase() === sub.toLowerCase() ? '' : d
      const lookup = rel => pf.mod.files.filter(f => f.toLowerCase() === (pf.root + rel).toLowerCase() || f.toLowerCase().startsWith((pf.root + rel).toLowerCase() + '/'))
      for (const pk of picks) {
        const srcRel = norm1(pk.source), dest = strip(norm1(pk.destination ?? (pk.folder ? '' : srcRel)))
        for (const f of lookup(srcRel)) {
          const inner = f.slice((pf.root + srcRel).length).replace(/^\//, '')
          const to = pk.folder ? (dest ? `${dest}/${inner}` : inner) : (dest || path.basename(f))
          if (!to) continue
          write(out, to, fs.readFileSync(inside(pend, f))); files.add(to)
        }
      }
      fs.rmSync(pend, { recursive: true, force: true }); fs.rmSync(path.join(dir(p.id), 'files', `.old-${stage}`), { recursive: true, force: true })
      const mod = { ...pf.mod, src: pf.src, stage, files: [...files], fomod: picks.length }
      for (const k of ['disabled', 'pinned', 'note']) if (pf.old?.[k] !== undefined) mod[k] = pf.old[k]
      return save({ ...p, pendingFomod: undefined, mods: [...p.mods.filter(m => m.id !== pf.id), mod] })
    },
    fomodCancel: pid => {
      const p = load(pid), pf = p.pendingFomod
      if (!pf) return p
      fs.rmSync(path.join(dir(p.id), 'files', `.fomod-${pf.stage}`), { recursive: true, force: true })
      const keep = path.join(dir(p.id), 'files', `.old-${pf.stage}`)
      if (pf.old) for (const f of pf.moved || []) { const to = mf(p, pf.old, f); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.renameSync(inside(keep, f), to) }
      fs.rmSync(keep, { recursive: true, force: true })
      return save({ ...p, pendingFomod: undefined, mods: pf.old ? [...p.mods.filter(m => m.id !== pf.id), pf.old] : p.mods })
    },

    // Bethesda load order: plugins (.esm/.esl/.esp) from enabled mods; written to plugins.txt on deploy.
    loadOrder: pid => {
      const p = load(pid), pre = presetOf(p)
      if (!pre?.plugins) return null
      const have = p.mods.filter(m => !m.disabled).flatMap(m => m.files.filter(f => !f.includes('/') && /\.(esm|esl|esp)$/i.test(f)).map(f => ({ name: f, mod: m.name })))
      const order = p.loadOrder || [], rank = n => { const i = order.indexOf(n); return i < 0 ? 1e6 : i }
      const master = n => /\.(esm|esl)$/i.test(n)
      have.sort((a, b) => (master(b.name) - master(a.name)) || rank(a.name) - rank(b.name))
      return { plugins: have.map(x => ({ ...x, on: !(p.pluginsOff || []).includes(x.name), master: master(x.name) })), file: pluginsTxt(pre) }
    },
    setLoadOrder: (pid, order, off) => {
      const p = load(pid)
      return save({ ...p, loadOrder: order.map(String).slice(0, 5000), pluginsOff: (off || []).map(String) })
    },

    // Custom tools (xEdit, LOOT, SKSE loader, …) per profile.
    setTools: (pid, tools) => save({ ...load(pid), tools: (tools || []).slice(0, 20).map(t => ({ name: String(t.name).slice(0, 40), exe: String(t.exe), args: String(t.args || '').slice(0, 500) })) }),
    runTool: (pid, i) => {
      const t = load(pid).tools?.[i]
      if (!t || !fs.existsSync(t.exe)) throw new Error('Tool not found — check its path')
      spawn(t.exe, t.args.split(/\s+/).filter(Boolean), { cwd: path.dirname(t.exe), detached: true, stdio: 'ignore' }).unref()
      return true
    },

    // Nexus Collections: browse + list the files of the latest revision (installing goes through the normal Nexus install).
    collections: async (pid, text = '', page = 1) => {
      const p = load(pid)
      if (p.type !== 'nexus') throw new Error('Collections are for Nexus Mods profiles')
      const f = { gameDomain: [{ value: p.game, op: 'EQUALS' }], adultContent: [{ value: false, op: 'EQUALS' }], ...(text ? { name: [{ value: text, op: 'WILDCARD' }] } : {}) }
      const r = await json('https://api.nexusmods.com/v2/graphql', { 'content-type': 'application/json' }, { method: 'POST', body: JSON.stringify({
        query: 'query($f:CollectionsSearchFilter,$o:Int){collectionsV2(count:20,offset:$o,filter:$f,sort:[{endorsements:{direction:DESC}}]){totalCount nodes{name slug summary tileImage{url} endorsements totalDownloads latestPublishedRevision{modCount}}}}',
        variables: { f, o: (page - 1) * 20 } }) })
      if (r.errors) throw new Error(r.errors[0].message)
      return { pages: Math.ceil(r.data.collectionsV2.totalCount / 20), items: r.data.collectionsV2.nodes }
    },
    collectionMods: async slug => {
      if (!/^\w+$/.test(slug)) throw new Error('Bad collection')
      const r = await json('https://api.nexusmods.com/v2/graphql', { 'content-type': 'application/json' }, { method: 'POST', body: JSON.stringify({
        query: 'query($s:String!){collection(slug:$s,viewAdultContent:false){name latestPublishedRevision{revisionNumber modFiles{optional fileId file{modId name version mod{name}}}}}}', variables: { s: slug } }) })
      if (r.errors) throw new Error(r.errors[0].message)
      const c = r.data.collection
      return { name: c.name, revision: c.latestPublishedRevision.revisionNumber, mods: c.latestPublishedRevision.modFiles.map(m => ({ modId: String(m.file.modId), fileId: String(m.fileId), name: m.file.mod?.name || m.file.name, version: m.file.version, optional: m.optional })) }
    },
    endorse: async (pid, id) => {
      const p = load(pid), m = p.mods.find(m => m.id === id), key = settings().nexusKey
      if (p.type !== 'nexus' || !key) throw new Error('Needs a Nexus profile and your Nexus API key')
      await json(`https://api.nexusmods.com/v1/games/${q(p.game)}/mods/${q(id)}/endorse.json`, { apikey: key, 'content-type': 'application/json' }, { method: 'POST', body: JSON.stringify({ version: m?.version || '' }) })
      return save({ ...p, mods: p.mods.map(x => x.id === id ? { ...x, endorsed: true } : x) })
    },

    // ---- Mod management extras ----
    // Move a mod so it loads after (wins over) another; order in the list = conflict priority.
    moveMod: (pid, id, afterId) => {
      const p = load(pid), m = p.mods.find(m => m.id === id)
      if (!m) throw new Error('Mod not installed')
      const rest = p.mods.filter(x => x.id !== id), i = rest.findIndex(x => x.id === afterId)
      rest.splice(i < 0 ? rest.length : i + 1, 0, m)
      return save({ ...p, mods: rest })
    },
    // Remove everything this profile put into the game folder (like Vortex "Purge").
    purge: id => {
      const p = load(id)
      for (const f of p.deployed || []) remove(p.target, f)
      return save({ ...p, deployed: [] })
    },
    updateMod: (pid, id, patch) => {
      const p = load(pid), m = p.mods.find(m => m.id === id)
      if (m && 'pinned' in patch) m.pinned = !!patch.pinned || undefined
      if (m && 'note' in patch) m.note = String(patch.note || '').slice(0, 300) || undefined
      return save(p)
    },
    // Dependencies installed automatically that nothing needs any more.
    orphans: pid => {
      const p = load(pid), needed = new Set(p.mods.flatMap(m => m.deps || []))
      return p.mods.filter(m => m.auto && !needed.has(m.id)).map(m => ({ id: m.id, name: m.name }))
    },
    // Same file written by two enabled mods, or Modrinth "incompatible" pairs.
    conflicts: pid => {
      const p = load(pid), on = p.mods.filter(m => !m.disabled), owner = {}, out = []
      for (const m of on) for (const f of m.files) (owner[f] ||= []).push(m)
      for (const [file, ms] of Object.entries(owner)) if (ms.length > 1 && !/\/config\//i.test(`/${file}`)) out.push({ type: 'file', file, mods: ms.map(m => m.name), ids: ms.map(m => m.id), winner: ms.at(-1).name })
      for (const m of on) for (const bad of m.incompat || []) { const o = on.find(x => x.id === bad); if (o) out.push({ type: 'incompatible', mods: [m.name, o.name] }) }
      return out
    },

    // Preview what a share code / followed profile would change. With pid: diff against that profile.
    preview: async (input, pid) => {
      const { d } = await parseShare(input), p = pid && load(pid)
      return { name: d.n, type: d.t, game: d.g, gameName: d.gn, mc: d.mc, count: d.m.length, diff: p ? diff(p, d) : null }
    },
    sync: async (pid, input, { remove: drop } = {}) => {
      const { d, cfg, rev } = await parseShare(input)
      snapshot(pid, 'Before syncing with a friend')
      const r = await syncData(pid, d, drop, cfg)
      if (rev && r.profile.follow && `gist:${r.profile.follow.gist}` === String(input).trim()) r.profile = save({ ...r.profile, follow: { ...r.profile.follow, rev } })
      return r
    },

    // Live share via a public GitHub Gist (listed on the publisher's site profile): needs a token with "gist" scope; friends only read.
    publish: async pid => {
      const p = load(pid), token = settings().githubToken
      if (!token) throw new Error('Add a GitHub token (gist scope) in Settings to live-share')
      const body = JSON.stringify({ description: `Mod Manager: ${p.name}`, public: true, files: { 'modmanager.json': { content: JSON.stringify(shareData(p)) } } })
      const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' }
      const r = p.publish
        ? await json(`https://api.github.com/gists/${q(p.publish)}`, headers, { method: 'PATCH', body }).catch(e => e.status === 404 ? null : Promise.reject(e))
        : null
      const g = r || await json('https://api.github.com/gists', headers, { method: 'POST', body })
      return save({ ...p, publish: g.id, publishUser: g.owner?.login || p.publishUser })
    },
    follow: async (gist, name) => {
      const { d, rev } = await parseShare(`gist:${gist}`)
      const res = await importData(d, name)
      res.profile = save({ ...load(res.profile.id), follow: { gist, rev } })
      return res
    },
    checkFollow: async pid => {
      const p = load(pid)
      if (!p.follow) return null
      const { d, rev } = await parseShare(`gist:${p.follow.gist}`)
      return { changed: rev !== p.follow.rev, diff: diff(p, d) }
    },

    // Reads the newest crash report / log and points at installed mods it mentions.
    analyzeCrash: pid => {
      const p = load(pid), dirs = ['crash-reports', 'logs'].map(d => path.join(p.target || '', d))
      const file = dirs.flatMap(d => fs.existsSync(d) ? fs.readdirSync(d).filter(f => /\.(txt|log)$/.test(f)).map(f => path.join(d, f)) : [])
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]
      if (!file) return { suspects: [] }
      const text = fs.readFileSync(file, 'utf8')
      const words = new Set([
        ...[...text.matchAll(/Suspected Mods?:([^\n]+)/gi)].flatMap(m => [...m[1].matchAll(/\(([\w-]+)\)/g)].map(x => x[1])),
        ...[...text.matchAll(/(?:Mod ID|modid|from mod)[: ']+([\w-]+)/gi)].map(m => m[1]),
        ...[...text.matchAll(/([\w.+-]+\.jar)/g)].map(m => m[1]),
      ].map(norm).filter(w => w.length > 2 && !['minecraft', 'fabricloader', 'java', 'forge', 'neoforge', 'mixinextras', 'fabricapi'].includes(w)))
      const suspects = p.mods.filter(m => !m.disabled && [...words].some(w => m.files.some(f => norm(path.basename(f)).includes(w)) || norm(m.name) === w))
      const lines = text.split('\n'), i = lines.findIndex(l => /Description:|Exception|Error:/.test(l))
      return { file: path.relative(p.target, file), suspects: suspects.map(m => ({ id: m.id, name: m.name })), snippet: lines.slice(Math.max(0, i), i + 8).join('\n') }
    },

    // Installed Java runtimes (managed ones + common install folders).
    javaList: () => {
      const exe = process.platform === 'win32' ? 'javaw.exe' : 'java'
      const roots = [path.join(root, '..', 'minecraft', 'runtime'),
        ...(process.platform === 'win32' ? ['ProgramFiles', 'ProgramFiles(x86)'].flatMap(k => process.env[k] ? ['Java', 'Eclipse Adoptium', 'Microsoft', 'Zulu', 'BellSoft', 'Amazon Corretto'].map(v => path.join(process.env[k], v)) : []) : ['/usr/lib/jvm'])]
      const found = roots.flatMap(r => { try { return fs.readdirSync(r).map(d => path.join(r, d, 'bin', exe)) } catch { return [] } })
      if (process.env.JAVA_HOME) found.push(path.join(process.env.JAVA_HOME, 'bin', exe))
      return [...new Set(found)].filter(f => fs.existsSync(f)).map(f => ({ path: f, label: path.basename(path.dirname(path.dirname(f))) }))
    },

    // ---- Minecraft server (local, optional public address through bore.pub) ----
    serverStatus: pid => {
      const s = servers[pid], p = load(pid), icon = path.join(sdirOf(pid), 'server-icon.png')
      return { running: !!s, online: !!s?.online, address: s?.address, lan: s?.lan, bedrock: s?.bedrock, bedrockPublic: s?.bedrockPublic, voice: s?.voice, playit: !!playitSecret() && settings().tunnel !== 'bore', players: s ? [...s.players] : [],
        since: s?.since, log: s?.log || lastLogs[pid] || [], issues: s ? [] : lastIssues[pid] || [], opts: p.server || {}, kind: kindOf(p),
        icon: fs.existsSync(icon) ? 'data:image/png;base64,' + fs.readFileSync(icon).toString('base64') : null, ram: Math.round(os.totalmem() / 1048576) }
    },
    serverCmd: (pid, cmd) => { servers[pid]?.child?.stdin.write(String(cmd).replace(/\n/g, ' ') + '\n'); return true },
    serverStop: pid => {
      const s = servers[pid]; if (!s) return true
      s.stopping = true
      if (!s.child) throw new Error('The server is still preparing — wait a moment')
      String(s.stopCmds || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).forEach(c => s.child.stdin.write(c + '\n'))
      s.child.stdin.write('stop\n'); return true
    },
    serversRunning: () => Object.keys(servers),
    serverStart: (pid, opts = {}) => startServer(pid, opts),
    serverRestart: async pid => {
      const s = servers[pid]; if (!s?.child) throw new Error('Server is not running')
      s.restart = true; s.stopping = true; s.child.stdin.write('stop\n'); return true
    },
    setServerKind: (pid, kind) => {
      if (!['profile', 'paper', 'purpur', 'bedrock'].includes(kind)) throw new Error('Unknown server type')
      if (servers[pid]) throw new Error('Stop the server first')
      const p = load(pid); return save({ ...p, server: { ...p.server, kind, port: kind === 'bedrock' ? 19132 : (p.server?.port === 19132 ? 25565 : p.server?.port) } }).server
    },

    // server.properties editor (whitelisted keys only).
    serverProps: pid => readProps(path.join(sdirOf(pid), 'server.properties')),
    setServerProps: (pid, patch) => {
      const file = path.join(sdirOf(pid), 'server.properties'), cur = readProps(file)
      for (const [k, v] of Object.entries(patch)) if (PROPS.includes(k)) cur[k] = String(v).replace(/[\r\n]/g, ' ').slice(0, 400)
      writeProps(file, cur)
      return cur
    },
    setServerIcon: (pid, dataUrl) => {
      const m = String(dataUrl).match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/)
      if (!m || m[1].length > 200e3) throw new Error('Icon must be a PNG')
      write(sdirOf(pid), 'server-icon.png', Buffer.from(m[1], 'base64')); return true
    },
    // SHA1 for a resource pack URL (server.properties resource-pack-sha1).
    sha1Url: async u => {
      if (!/^https:\/\//.test(u)) throw new Error('Resource pack URL must be https')
      return crypto.createHash('sha1').update(await lib.bytes(u)).digest('hex')
    },

    // Players: online (from log), known (usercache), ops / whitelist / bans (server json files); actions go through the console.
    serverPlayers: pid => {
      const kind = kindOf(load(pid)), sdir = sdirOf(pid, kind)
      const names = f => { try { return JSON.parse(fs.readFileSync(path.join(sdir, f), 'utf8')).map(x => x.name).filter(Boolean) } catch { return [] } }
      return kind === 'bedrock'
        ? { online: [...(servers[pid]?.players || [])], ops: [], whitelist: names('allowlist.json'), banned: [], known: [], bedrock: true }
        : { online: [...(servers[pid]?.players || [])], ops: names('ops.json'), whitelist: names('whitelist.json'), banned: names('banned-players.json'), known: names('usercache.json') }
    },
    playerAction: (pid, action, name) => {
      const bedrock = kindOf(load(pid)) === 'bedrock'
      const cmd = { op: 'op', deop: 'deop', kick: 'kick', ban: !bedrock && 'ban', pardon: !bedrock && 'pardon', allow: bedrock ? 'allowlist add' : 'whitelist add', disallow: bedrock ? 'allowlist remove' : 'whitelist remove' }[action]
      if (!cmd || !/^[A-Za-z0-9_ ]{1,16}$/.test(name)) throw new Error('Invalid player action')
      if (!servers[pid]) throw new Error('Start the server to manage players')
      servers[pid].child.stdin.write(`${cmd} ${bedrock && /\s/.test(name) ? `"${name}"` : name}\n`)
      if (!bedrock && (action === 'allow' || action === 'disallow')) servers[pid].child.stdin.write('whitelist reload\n')
      return true
    },
    // Deletes a player's inventory/position, stats and advancements (server must be stopped).
    resetPlayer: (pid, name) => {
      if (servers[pid]) throw new Error('Stop the server first')
      const sdir = sdirOf(pid), level = readProps(path.join(sdir, 'server.properties'))['level-name'] || 'world'
      let cache = []; try { cache = JSON.parse(fs.readFileSync(path.join(sdir, 'usercache.json'), 'utf8')) } catch {}
      const uuid = cache.find(c => c.name === name)?.uuid
      if (!uuid || !/^[\w-]{32,36}$/.test(uuid)) throw new Error(`${name} has never joined`)
      for (const f of [`playerdata/${uuid}.dat`, `playerdata/${uuid}.dat_old`, `stats/${uuid}.json`, `advancements/${uuid}.json`]) fs.rmSync(inside(path.join(sdir, level), f), { force: true })
      return true
    },

    // World backups (zip of the world folders), restore while stopped.
    backups: pid => {
      const b = path.join(dir(pid), 'server-backups')
      return fs.existsSync(b) ? fs.readdirSync(b).filter(f => f.endsWith('.zip')).map(f => ({ name: f, size: fs.statSync(path.join(b, f)).size, time: fs.statSync(path.join(b, f)).mtimeMs })).sort((a, b) => b.time - a.time) : []
    },
    backup: pid => backupWorld(pid),
    restoreBackup: (pid, name) => {
      if (servers[pid]) throw new Error('Stop the server before restoring')
      if (!/^[\w.-]+\.zip$/.test(name)) throw new Error('Bad backup name')
      const kind = kindOf(load(pid)), sdir = sdirOf(pid, kind)
      const zip = unzipSync(fs.readFileSync(inside(path.join(dir(pid), 'server-backups'), name)))
      for (const d of worldDirs(pid, kind)) fs.rmSync(inside(sdir, d), { recursive: true, force: true })
      for (const [f, data] of Object.entries(zip)) if (!f.endsWith('/')) write(sdir, f, data)
      return true
    },
    deleteBackup: (pid, name) => {
      if (!/^[\w.-]+\.zip$/.test(name)) throw new Error('Bad backup name')
      fs.rmSync(inside(path.join(dir(pid), 'server-backups'), name), { force: true }); return true
    },

    // Plugins for Paper / Purpur servers (Modrinth + Hangar).
    pluginSearch: async (pid, src, text = '', page = 1) => {
      const p = load(pid)
      if (src === 'hangar') {
        const r = await json(`https://hangar.papermc.io/api/v1/projects?q=${q(text)}&platform=PAPER&version=${q(p.mc.version)}&sort=-downloads&limit=20&offset=${(page - 1) * 20}`)
        return { pages: Math.ceil(r.pagination.count / 20), items: r.result.map(x => ({ id: `${x.namespace.owner}/${x.namespace.slug}`, title: x.name, author: x.namespace.owner, desc: x.description, icon: x.avatarUrl, downloads: x.stats.downloads })) }
      }
      const facets = [['project_type:plugin'], PLUGIN_LOADERS.map(l => `categories:${l}`), [`versions:${p.mc.version}`]]
      const r = await json(`${MR}/search?query=${q(text)}&facets=${q(facets)}&index=${text ? 'relevance' : 'downloads'}&limit=20&offset=${(page - 1) * 20}`)
      return { pages: Math.ceil(r.total_hits / 20), items: r.hits.map(m => ({ id: m.project_id, title: m.title, author: m.author, desc: m.description, icon: m.icon_url, downloads: m.downloads })) }
    },
    pluginInstall: async (pid, src, id) => {
      if (!['modrinth', 'hangar'].includes(src) || !(src === 'hangar' ? /^[\w.-]+\/[\w.-]+$/ : /^\w+$/).test(id)) throw new Error('Bad plugin id')
      const p = load(pid), f = await pluginFile(p, src, id), sdir = sdirOf(pid)
      const list = (p.server?.plugins || []).filter(x => x.id !== id)
      for (const old of (p.server?.plugins || []).filter(x => x.id === id)) fs.rmSync(inside(sdir, `plugins/${old.file}`), { force: true })
      const file = path.basename(f.file).replace(/[^\w.+-]/g, '_')
      write(sdir, `plugins/${file}`, await lib.bytes(f.url))
      return save({ ...p, server: { ...p.server, plugins: [...list, { id, src, name: f.name, version: f.version, file, icon: f.icon }] } }).server.plugins
    },
    pluginRemove: (pid, id) => {
      const p = load(pid), x = (p.server?.plugins || []).find(x => x.id === id)
      if (x) fs.rmSync(inside(sdirOf(pid), `plugins/${x.file}`), { force: true })
      return save({ ...p, server: { ...p.server, plugins: (p.server?.plugins || []).filter(x => x.id !== id) } }).server.plugins
    },

    // Upload a log to mclo.gs (public paste site for Minecraft logs) and return the link.
    shareLog: async (pid, which = 'server') => {
      const p = load(pid)
      const text = which === 'server' ? (servers[pid]?.log || lastLogs[pid] || []).join('\n')
        : (() => { try { return fs.readFileSync(path.join(p.target, 'logs', 'latest.log'), 'utf8') } catch { return (logs[pid] || []).join('\n') } })()
      if (!text.trim()) throw new Error('No log yet')
      const r = await json('https://api.mclo.gs/1/log', {}, { method: 'POST', body: new URLSearchParams({ content: text.slice(-2e6) }) })
      if (!r.success) throw new Error(r.error || 'Upload failed')
      return r.url
    },

    // Updates the mod loader to the newest version (and Fabric API if installed).
    updateLoader: async pid => {
      if (servers[pid] || running[pid]) throw new Error('Stop the game and server first')
      const p = load(pid)
      if (p.mc.loader === 'vanilla') throw new Error('Vanilla has no loader')
      const to = await mcl.latestLoader(p.mc.version, p.mc.loader), from = p.mc.loaderVersion
      save({ ...p, mc: { ...p.mc, loaderVersion: to } })
      if (p.mods.some(m => m.id === 'P7dR8mSH')) await install(pid, 'modrinth', 'P7dR8mSH', null).catch(() => {})
      return { from, to }
    },

    // Connectivity / setup checks for the server panel.
    diagnostics: async pid => {
      const p = load(pid), port = p.server?.port || 25565, check = async (name, fn) => { try { return { name, ok: true, detail: await fn() } } catch (e) { return { name, ok: false, detail: e.message } } }
      const tcp = (host, port) => new Promise((ok, fail) => { const c = net.connect(port, host, () => { c.destroy(); ok('reachable') }); c.setTimeout(5000, () => { c.destroy(); fail(new Error('timeout')) }); c.on('error', fail) })
      return Promise.all([
        check('Internet / Modrinth', async () => (await json(`${MR}/tag/loader`)).length && 'ok'),
        check('Mojang downloads', async () => (await mcl.versions()).length && 'ok'),
        check('Tunnel service (bore.pub)', () => tcp('bore.pub', 7835)),
        check('playit.gg', async () => { const t = Date.now(); await pit.ping(); return `${playitSecret() ? 'linked' : 'not linked'} · API ${Date.now() - t} ms` }),
        check(`Port ${port} free`, async () => servers[pid] ? 'used by this server' : (await portFree(port)) ? 'free' : Promise.reject(new Error('used by another program'))),
        check('Memory', async () => `${Math.round(os.totalmem() / 1073741824)} GB total, ${Math.round(os.freemem() / 1073741824)} GB free`),
      ])
    },
    // Public address for friends outside your network.
    // Public address: playit.gg when linked (Java + Bedrock/UDP + voice chat), otherwise bore.pub (Java TCP only).
    serverShare: async pid => {
      const s = servers[pid]
      if (!s) throw new Error('Start the server first')
      if (s.address) return s.address
      const port = +s.lan.split(':')[1], kind = kindOf(load(pid)), secret = playitSecret()
      const log = line => { s.log.push(line); emit('slog', { pid, line }) }
      if (secret && settings().tunnel !== 'bore') {
        log('Opening playit.gg tunnel…')
        await pit.startAgent(secret, log)
        s.playit = true
        s.address = await pit.tunnel(secret, { name: `mm-${pid}`, localPort: port, kind: kind === 'bedrock' ? 'bedrock' : 'java' })
        if (kind !== 'bedrock' && s.bedrock) s.bedrockPublic = await pit.tunnel(secret, { name: `mm-${pid}-bedrock`, localPort: 19132, kind: 'bedrock' }).catch(e => (log(e.message), null))
        // Simple Voice Chat uses UDP 24454 next to the server.
        const sdir = sdirOf(pid, kind)
        if (['mods', 'plugins'].some(d => fs.existsSync(path.join(sdir, d)) && fs.readdirSync(path.join(sdir, d)).some(f => /voicechat/i.test(f))))
          s.voice = await pit.tunnel(secret, { name: `mm-${pid}-voice`, localPort: 24454, kind: 'udp' }).catch(e => (log(e.message), null))
        // Tell Simple Voice Chat which public address to hand to players (read at server start).
        if (s.voice) for (const f of ['config/voicechat/voicechat-server.properties', 'plugins/voicechat/voicechat-server.properties']) {
          const file = path.join(sdir, f)
          if (!fs.existsSync(file)) continue
          const t = fs.readFileSync(file, 'utf8'), line = `voice_host=${s.voice}`
          if (!t.includes(line)) { fs.writeFileSync(file, /^voice_host=.*$/m.test(t) ? t.replace(/^voice_host=.*$/m, line) : t + `\n${line}\n`); log('Voice chat address saved — restart the server once so players get it') }
        }
      } else {
        if (kind === 'bedrock') throw new Error('Bedrock needs UDP: link a free playit.gg account in Settings → Accounts')
        s.tunnel = await tunnel.open(port, { onError: () => { s.address = null; emit('sstatus', { pid }) } })
        s.address = `${s.tunnel.host}:${s.tunnel.port}`
      }
      const sd = syncDirOf(load(pid)); if (sd) try { writeLock(sd, { heartbeat: Date.now(), address: s.address }) } catch {}
      emit('sstatus', { pid })
      return s.address
    },
    // Snapshots / rollback
    snapshot: (pid, reason) => snapshot(pid, reason),
    snapshots: pid => {
      const d = snapDir(pid)
      return fs.existsSync(d) ? fs.readdirSync(d).filter(f => /^\d+\.json$/.test(f)).sort().reverse().flatMap(f => {
        try { const j = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); return [{ id: f.slice(0, -5), time: j.time, reason: j.reason, count: j.data.m.length }] } catch { return [] }
      }) : []
    },
    restoreSnapshot: async (pid, id) => {
      if (!/^\d+$/.test(id)) throw new Error('Bad snapshot')
      const j = JSON.parse(fs.readFileSync(path.join(snapDir(pid), `${id}.json`), 'utf8'))
      if (!validData(j.data)) throw new Error('Snapshot is damaged')
      snapshot(pid, 'Before rollback')
      const r = await syncData(pid, j.data, true)
      const p = load(pid)
      for (const m of p.mods) Object.assign(m, Object.fromEntries(Object.entries(j.flags?.[m.id] || {}).filter(([, v]) => v !== undefined)))
      return { ...r, profile: save(p) }
    },
    // Release notes for one version (fetched when the user opens them).
    changelog: async (pid, src, id, vid) => S[src].changelog ? S[src].changelog(load(pid), id, vid) : null,

    // Play without the app's own Microsoft login: hand the instance to the official Minecraft Launcher.
    // Copies the prepared version (loader) + its libraries into .minecraft and adds a launcher profile pointing at this instance.
    playOfficial: async pid => {
      let p = load(pid)
      if (p.type !== 'modrinth') throw new Error('Only Minecraft profiles')
      const status = text => emit('status', { pid, text })
      status('Preparing…')
      try {
        const plan = await mcl.prepare({ mc: p.mc.version, loader: p.mc.loader, loaderVersion: p.mc.loaderVersion, progress: status })
        p = await serialDeploy(pid)
        if (plan.loaderVersion && plan.loaderVersion !== p.mc.loaderVersion) p = save({ ...p, mc: { ...p.mc, loaderVersion: plan.loaderVersion } })
        const mcd = minecraftDir(), base = path.join(root, '..', 'minecraft')
        for (let id = plan.id; id;) {
          const from = path.join(base, 'versions', id)
          fs.cpSync(from, path.join(mcd, 'versions', id), { recursive: true, force: false, errorOnExist: false })
          id = JSON.parse(fs.readFileSync(path.join(from, `${id}.json`), 'utf8')).inheritsFrom
        }
        const libs = path.join(base, 'libraries')
        for (const f of plan.classpath) if (f.startsWith(libs + path.sep)) {
          const to = path.join(mcd, 'libraries', path.relative(libs, f))
          if (!fs.existsSync(to) && fs.existsSync(f)) fs.mkdirSync(path.dirname(to), { recursive: true }), fs.copyFileSync(f, to)
        }
        const lpFile = path.join(mcd, 'launcher_profiles.json')
        let lp = {}; try { lp = JSON.parse(fs.readFileSync(lpFile, 'utf8')) } catch {}
        const mem = p.launch?.maxMem || settings().launch?.maxMem || 4096
        lp.profiles = { ...lp.profiles, [`mm-${pid}`]: { ...lp.profiles?.[`mm-${pid}`], name: p.name, type: 'custom', icon: 'Grass', lastVersionId: plan.id, gameDir: p.target,
          javaArgs: `-Xmx${mem}M -Dlog4j2.formatMsgNoLookups=true`, created: lp.profiles?.[`mm-${pid}`]?.created || new Date().toISOString(), lastUsed: new Date().toISOString() } }
        fs.mkdirSync(mcd, { recursive: true }); writeAtomic(lpFile, JSON.stringify(lp, null, 2))
        let launched = false
        if (process.platform === 'win32') {
          const run = (cmd, args) => spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref()
          const exe = ['ProgramFiles(x86)', 'ProgramFiles'].map(k => process.env[k] && path.join(process.env[k], 'Minecraft Launcher', 'MinecraftLauncher.exe')).find(f => f && fs.existsSync(f))
          exe ? run(exe, []) : run('explorer.exe', ['shell:AppsFolder\\Microsoft.4297127D64EC6_8wekyb3d8bbwe!Minecraft'])
          launched = true
        }
        return { profile: p.name, version: plan.id, launched }
      } finally { emit('status', { pid, text: null }) }
    },
    // Setup checklist: what still needs doing for every feature to work.
    setupStatus: async () => {
      const s = settings(), repo = require('./package.json').build?.publish
      const ok = async u => { try { const r = await fetch(u, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(10e3) }); return r.status < 400 } catch { return null } }
      const [releases, pages] = repo ? await Promise.all([ok(`https://github.com/${repo.owner}/${repo.repo}/releases/latest`), ok(`https://${repo.owner.toLowerCase()}.github.io/${repo.repo}/join.html`)]) : [null, null]
      return { repo: repo && `${repo.owner}/${repo.repo}`, releases, pages, msLogin: readAccounts().length > 0, msClientId: !!s.msClientId, playit: !!playitSecret(),
        curseforge: !!s.curseforgeKey, nexus: !!s.nexusKey, github: !!s.githubToken, minecraftLauncher: fs.existsSync(path.join(minecraftDir(), 'launcher_profiles.json')) }
    },

    // World sync API
    syncStatus: pid => {
      const p = load(pid), dir = syncDirOf(p)
      return { dir: p.server?.syncDir || null, missing: !!p.server?.syncDir && !dir, meta: dir && readJson(path.join(dir, 'meta.json')), lock: dir && lockInfo(dir), local: p.server?.syncVersion || 0, me: me() }
    },
    setSyncDir: (pid, d) => {
      if (servers[pid]) throw new Error('Stop the server first')
      if (d && !(path.isAbsolute(d) && fs.statSync(d).isDirectory())) throw new Error('Pick a folder')
      const p = load(pid)
      // Joining an existing shared world: pull on next start (version 0 locally).
      return save({ ...p, server: { ...p.server, syncDir: d || undefined, syncVersion: d && readJson(path.join(d, 'meta.json')) ? 0 : p.server?.syncVersion } }).server
    },
    syncNow: pid => syncPush(pid, line => emit('slog', { pid, line })),
    syncPull: pid => { if (servers[pid]) throw new Error('Stop the server first'); return syncPull(pid, line => emit('slog', { pid, line })).then(() => (releaseLock(pid), true)) },
    playitStatus: () => ({ linked: !!playitSecret(), tunnel: settings().tunnel || 'auto' }),
    playitLinkStart: () => pit.claimStart(),
    playitLinkFinish: async code => { setSettingsRaw({ playitSecret: encrypt(await pit.claimFinish(code)) }); return true },
    playitUnlink: () => { pit.stopAgent(); setSettingsRaw({ playitSecret: undefined }); return true },
    // Invite: share code + server address; friends' import adds it to their server list.
    inviteCode: pid => {
      const s = servers[pid]
      if (!s?.address) throw new Error('Share the server online first')
      return 'MM1' + zlib.deflateRawSync(JSON.stringify({ ...shareData(load(pid)), s: s.address })).toString('base64url')
    },

    // ---- Minecraft launcher ----
    accounts: () => readAccounts().map(({ uuid, name, skin }) => ({ uuid, name, skin, active: uuid === settings().activeAccount })),
    loginStart: async () => {
      const cid = clientId()
      pending = await auth.deviceCode(cid)
      return { code: pending.user_code, url: pending.verification_uri, message: pending.message }
    },
    loginFinish: async () => {
      if (!pending) throw new Error('Start the login first')
      const cid = clientId(), ms = await auth.waitForToken(cid, pending)
      pending = null
      const mc = await auth.minecraft(ms.access_token)
      const list = readAccounts().filter(a => a.uuid !== mc.uuid)
      writeAccounts([...list, { ...mc, refresh: ms.refresh_token }])
      setSettingsRaw({ activeAccount: mc.uuid })
      return { uuid: mc.uuid, name: mc.name }
    },
    setActiveAccount: uuid => (setSettingsRaw({ activeAccount: uuid }), true),
    removeAccount: uuid => (writeAccounts(readAccounts().filter(a => a.uuid !== uuid)), true),

    mcVersions: async all => (await mcl.versions()).filter(v => all || v.type === 'release').map(v => v.id),
    filters: async (pid, src, kind) => S[src].filters ? S[src].filters(load(pid), kind) : {},
    running: () => Object.keys(running),
    getLog: pid => logs[pid] || [],
    stop: pid => { if (running[pid]) running[pid].stopped = true, running[pid].child?.kill(); return true },

    // Prepare (download game, loader, Java), deploy mods into the instance folder and start Minecraft.
    play: async (pid, quickPlay = {}, { vanilla } = {}) => {
      if (running[pid]) throw new Error('Already running')
      let p = load(pid)
      if (p.type !== 'modrinth') throw new Error('Only Minecraft profiles launch from here')
      const me = running[pid] = { preparing: true } // claims the profile now so a second Play click can't start a second game
      try {
      const acct = await activeAccount()
      const status = text => emit('status', { pid, text })
      const log = line => { (logs[pid] ||= []).push(line); if (logs[pid].length > 5000) logs[pid].shift(); emit('log', { pid, line }) }
      logs[pid] = []
      status('Preparing…')
      const plan = await mcl.prepare({ mc: p.mc.version, loader: p.mc.loader, loaderVersion: p.mc.loaderVersion, log, progress: status })
      if (me.stopped) throw new Error('Stopped')
      p = await serialDeploy(pid, { vanilla })
      if (plan.loaderVersion && plan.loaderVersion !== p.mc.loaderVersion) p.mc.loaderVersion = plan.loaderVersion, save(p)
      const opts = { ...settings().launch, ...p.launch }
      const start = Date.now()
      const child = mcl.launch(plan, { gameDir: p.target, account: acct, opts, quickPlay, onLog: log,
        onExit: code => {
          const stopped = running[pid]?.stopped
          delete running[pid]
          const q = load(pid); q.playtime = (q.playtime || 0) + Math.round((Date.now() - start) / 1000); q.lastPlayed = Date.now(); save(q)
          emit('status', { pid, text: null, exit: stopped ? 0 : code })
        } })
      me.child = child; me.preparing = false
      if (me.stopped) child.kill()
      status('Running')
      return true
      } catch (e) { if (running[pid] === me && !me.child) delete running[pid], emit('status', { pid, text: null }); throw e }
    },
    repair: async pid => {
      const p = load(pid)
      await mcl.prepare({ mc: p.mc.version, loader: p.mc.loader, loaderVersion: p.mc.loaderVersion, force: true, progress: text => emit('status', { pid, text }) })
      emit('status', { pid, text: null })
      return true
    },

    worlds: pid => {
      const p = load(pid), saves = path.join(p.target || '', 'saves')
      const worlds = fs.existsSync(saves) ? fs.readdirSync(saves, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => {
        const w = path.join(saves, d.name), icon = path.join(w, 'icon.png')
        return { name: d.name, modified: fs.statSync(w).mtimeMs, icon: fs.existsSync(icon) ? 'data:image/png;base64,' + fs.readFileSync(icon).toString('base64') : null }
      }).sort((a, b) => b.modified - a.modified) : []
      return { worlds, servers: MC.readServers(path.join(p.target || '', 'servers.dat')) }
    },
    logFiles: pid => {
      const p = load(pid)
      return ['logs', 'crash-reports'].flatMap(d => {
        const full = path.join(p.target || '', d)
        return fs.existsSync(full) ? fs.readdirSync(full).filter(f => /\.(log|log\.gz|txt)$/.test(f)).map(f => ({ rel: `${d}/${f}`, time: fs.statSync(path.join(full, f)).mtimeMs })) : []
      }).sort((a, b) => b.time - a.time)
    },
    readLog: (pid, rel) => {
      if (!/^(logs|crash-reports)\/[^/\\]+$/.test(rel)) throw new Error('Bad log path')
      return MC.readLog(inside(load(pid).target, rel))
    },

    // Add files from disk (drag and drop) as untracked "local" mods.
    addLocal: async (pid, paths) => {
      const p = load(pid)
      for (const file of paths) {
        const name = path.basename(file), data = fs.readFileSync(file), out = [], stage = stageKey('local', name)
        fs.rmSync(path.join(dir(p.id), 'files', stage), { recursive: true, force: true })
        p.__stage = stage
        let rel
        if (p.type === 'modrinth') {
          rel = /\.jar$/i.test(name) ? `mods/${name}` : /\.mrpack$/i.test(name) ? null : (await isShaderPack(data)) ? `shaderpacks/${name}` : `resourcepacks/${name}`
          if (/\.mrpack$/i.test(name)) {
            const r = await S.modrinth.installPackData(p, unzipSync(data), { id: `local:${name}`, name: name.replace(/\.mrpack$/i, ''), version: 'local' })
            delete p.__stage; p.mods = p.mods.filter(m => m.id !== r.mod.id); p.mods.push({ ...r.mod, src: 'local', stage }); continue
          }
          write(files(p), rel, data); out.push(rel)
        } else if (p.type === 'terraria' && /\.tmod$/i.test(name)) {
          rel = `Mods/${name}`; write(files(p), rel, data); out.push(rel)
        } else if (p.type === 'thunderstore' && /\.dll$/i.test(name)) {
          rel = `BepInEx/plugins/${name}`; write(files(p), rel, data); out.push(rel)
        } else {
          for (const [r, d] of Object.entries(await require('./lib').extract(name, data))) write(files(p), r, d), out.push(r)
          delete p.__stage
          const mod = { id: `local:${name}`, name: name.replace(/\.(zip|7z|rar)$/i, ''), version: 'local', files: out }
          if (p.type !== 'modrinth' && postInstall(p, 'local', mod.id, mod, stage)) return fomodOut(load(p.id))
          p.mods = p.mods.filter(m => m.id !== mod.id); p.mods.push({ ...mod, src: 'local', stage }); continue
        }
        delete p.__stage
        p.mods = p.mods.filter(m => m.id !== `local:${name}`)
        p.mods.push({ id: `local:${name}`, src: 'local', name, version: 'local', files: out, stage })
      }
      return save(p)
    },

    // Export as a Modrinth .mrpack: Modrinth mods as downloads, everything else (and configs) as overrides.
    exportMrpack: async (pid, dest) => {
      const p = load(pid)
      if (p.type !== 'modrinth') throw new Error('Only Minecraft profiles export as .mrpack')
      const zip = {}, list = []
      for (const m of p.mods.filter(m => !m.disabled)) {
        if (srcOf(p, m) === 'modrinth' && !m.pack && m.vid) {
          const f = (await json(`${MR}/version/${q(m.vid)}`)).files.find(f => f.primary) || {}
          if (f.url) { list.push({ path: m.files[0], hashes: f.hashes, downloads: [f.url], fileSize: f.size }); continue }
        }
        for (const rel of m.files) zip[`overrides/${rel}`] = fs.readFileSync(mf(p, m, rel))
      }
      for (const [rel, data] of Object.entries(configs(p))) zip[`overrides/${rel}`] = data
      const lv = p.mc.loaderVersion || await mcl.latestLoader(p.mc.version, p.mc.loader)
      const key = { fabric: 'fabric-loader', quilt: 'quilt-loader', forge: 'forge', neoforge: 'neoforge' }[p.mc.loader]
      zip['modrinth.index.json'] = strToU8(JSON.stringify({ formatVersion: 1, game: 'minecraft', versionId: '1.0.0', name: p.name, files: list,
        dependencies: { minecraft: p.mc.version, ...(key && lv ? { [key]: lv } : {}) } }, null, 1))
      fs.writeFileSync(dest, zipSync(zip))
      return list.length
    },

    // Import a .mrpack file or another launcher's instance folder (Prism/MultiMC, CurseForge, ATLauncher, GDLauncher).
    importInstance: async (src, name) => {
      if (/\.mrpack$/i.test(src)) {
        const zip = unzipSync(fs.readFileSync(src))
        const index = JSON.parse(strFromU8(zip['modrinth.index.json'] || strToU8('{}')))
        const d = index.dependencies || {}
        const loader = d['fabric-loader'] ? 'fabric' : d['quilt-loader'] ? 'quilt' : d.neoforge ? 'neoforge' : d.forge ? 'forge' : 'vanilla'
        const p = create({ name: name || index.name, type: 'modrinth', mc: { version: d.minecraft, loader, loaderVersion: d[{ fabric: 'fabric-loader', quilt: 'quilt-loader' }[loader] || loader] } })
        const stage = stageKey('local', path.basename(src)); p.__stage = stage
        const r = await S.modrinth.installPackData(p, zip, { id: `local:${path.basename(src)}`, name: index.name, version: index.versionId || 'local' }).finally(() => delete p.__stage)
        p.mods.push({ ...r.mod, src: 'local', stage })
        return { profile: save(p), failed: [] }
      }
      const has = f => fs.existsSync(path.join(src, f)), read = f => JSON.parse(fs.readFileSync(path.join(src, f), 'utf8'))
      let mc, loader = 'vanilla', lv, gameDir = src
      if (has('mmc-pack.json')) {
        const c = Object.fromEntries(read('mmc-pack.json').components.map(c => [c.uid, c.version]))
        mc = c['net.minecraft']
        ;[loader, lv] = c['net.fabricmc.fabric-loader'] ? ['fabric', c['net.fabricmc.fabric-loader']] : c['org.quiltmc.quilt-loader'] ? ['quilt', c['org.quiltmc.quilt-loader']]
          : c['net.neoforged'] ? ['neoforge', c['net.neoforged']] : c['net.minecraftforge'] ? ['forge', c['net.minecraftforge']] : ['vanilla']
        gameDir = ['.minecraft', 'minecraft'].map(d => path.join(src, d)).find(d => fs.existsSync(d)) || src
      } else if (has('minecraftinstance.json')) {
        const j = read('minecraftinstance.json'), m = (j.baseModLoader?.name || '').match(/^(\w+)-([\w.+-]+?)(?:-[\d.]+)?$/)
        mc = j.gameVersion; if (m) [loader, lv] = [m[1].toLowerCase(), m[2]]
      } else if (has('instance.json') && read('instance.json').launcher) {
        const j = read('instance.json'), t = j.launcher.loaderVersion
        mc = j.id || j.minecraftVersion; if (t) [loader, lv] = [t.type.toLowerCase(), t.version]
      } else if (has('config.json') && read('config.json').loader) {
        const l = read('config.json').loader
        mc = l.mcVersion; loader = (l.loaderType || 'vanilla').toLowerCase(); lv = l.loaderVersion
      } else throw new Error('Unknown instance folder (supported: Prism, MultiMC, CurseForge, ATLauncher, GDLauncher, .mrpack)')
      if (!VER.test(mc || '')) throw new Error('Could not read the Minecraft version')
      const p = create({ name: name || path.basename(src), type: 'modrinth', mc: { version: mc, loader, loaderVersion: lv } })
      const modsDir = path.join(gameDir, 'mods')
      for (const f of fs.existsSync(modsDir) ? fs.readdirSync(modsDir).filter(f => /\.jar(\.disabled)?$/i.test(f)) : []) {
        const n = f.replace(/\.disabled$/i, ''), rel = `mods/${n}`, stage = stageKey('local', n)
        write(path.join(dir(p.id), 'files', stage), rel, fs.readFileSync(path.join(modsDir, f)))
        p.mods.push({ id: `local:${n}`, src: 'local', name: n, version: 'local', files: [rel], stage, disabled: f.endsWith('.disabled') || undefined })
      }
      for (const e of fs.readdirSync(gameDir)) if (!['mods', 'logs', 'crash-reports', '.fabric', '.cache'].includes(e))
        fs.cpSync(path.join(gameDir, e), path.join(p.target, e), { recursive: true })
      return { profile: save(p), failed: [] }
    },

    duplicate: id => {
      const p = load(id), nid = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
      fs.cpSync(dir(id), dir(nid), { recursive: true })
      const target = p.target?.startsWith(dir(id)) ? dir(nid) + p.target.slice(dir(id).length) : p.target
      return save({ ...p, id: nid, name: `${p.name} (copy)`.slice(0, 40), target, deployed: target === p.target ? [] : p.deployed, playtime: 0 })
    },
    unlinkPack: (pid, id) => {
      const p = load(pid), m = p.mods.find(m => m.id === id && m.pack)
      if (m) Object.assign(m, { id: `local:${m.name}`, src: 'local', pack: undefined, vid: undefined })
      return save(p)
    },

    // Share code: "MM1" + base64url(deflate(JSON)). Pinned versions so friends get exactly the same set.
    exportCode: id => 'MM1' + zlib.deflateRawSync(JSON.stringify(shareData(load(id)))).toString('base64url'),
    // Thunderstore-hosted r2modman code with configs; works in r2modman too.
    exportR2: async id => {
      const p = load(id)
      if (p.type !== 'thunderstore') throw new Error('Config codes are for Thunderstore games; use "Save file" instead')
      const zip = zipSync({ 'export.r2x': strToU8(r2Yaml(p)), ...configs(p) })
      const r = await json(`${TS}/api/experimental/legacyprofile/create/`, { 'content-type': 'application/octet-stream' },
        { method: 'POST', body: '#r2modman\n' + Buffer.from(zip).toString('base64') })
      return r.key
    },
    // .mmpack file: mod list + configs from the target folder.
    exportFile: (id, dest) => {
      const p = load(id)
      fs.writeFileSync(dest, zipSync({ 'mm.json': strToU8(JSON.stringify(shareData(p))),
        ...Object.fromEntries(Object.entries(configs(p)).map(([k, v]) => [`configs/${k}`, v])) }))
      return Object.keys(configs(p)).length
    },
    importFile: async (file, name) => {
      let zip, d
      try { zip = unzipSync(fs.readFileSync(file)); d = JSON.parse(strFromU8(zip['mm.json'])) } catch { throw new Error('Not a mod manager file') }
      const cfg = Object.fromEntries(Object.entries(zip).filter(([f]) => f.startsWith('configs/') && !f.endsWith('/')).map(([f, v]) => [f.slice(8), v]))
      return importData(d, name, cfg)
    },
    importCode: async (code, name, game) => {
      code = code.trim()
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(code)) return importR2(code, name, game)
      let d
      try { d = JSON.parse(zlib.inflateRawSync(Buffer.from(code.replace(/^MM1/, ''), 'base64url'))) } catch { throw new Error('Invalid share code') }
      return importData(d, name)
    },

    // nxm://<game>/mods/<id>/files/<fileId>?key=..&expires=.. from Nexus "Mod Manager Download".
    handleNxm: async (link, preferId) => {
      const u = new URL(link), m = u.pathname.match(/^\/mods\/(\d+)\/files\/(\d+)/)
      if (u.protocol !== 'nxm:' || !m) throw new Error('Unsupported Nexus link')
      const all = fs.readdirSync(root).filter(d => fs.existsSync(path.join(root, d, 'profile.json'))).map(load)
        .filter(p => p.type === 'nexus' && p.game === u.hostname)
      const p = all.find(p => p.id === preferId) || all[0]
      if (!p) throw new Error(`Make a Nexus profile for "${u.hostname}" first`)
      return install(p.id, 'nexus', m[1], m[2], { key: u.searchParams.get('key'), expires: u.searchParams.get('expires') })
    },
  }).map(([k, fn]) => [k, parallel.includes(k) ? fn : serial(fn)]))
}
