// Mod manager core: profiles on disk + per-site sources. Skipped: database, cache layer, download queue.
const fs = require('fs'), path = require('path'), os = require('os'), zlib = require('zlib')
const { spawn, execFileSync } = require('child_process')
const { zipSync, unzipSync, strToU8, strFromU8 } = require('fflate')
const { json, get, q, inside, write, remove, walk } = require('./lib')

const TS = 'https://thunderstore.io', MR = 'https://api.modrinth.com/v2'
// Which sites each profile type can install from; first is the default.
const SOURCES = { thunderstore: ['thunderstore'], modrinth: ['modrinth', 'curseforge'], curseforge: ['curseforge'], nexus: ['nexus'], gamebanana: ['gamebanana'] }
const ID = { thunderstore: /^[\w.-]+-\w+$/, modrinth: /^\w+$/, curseforge: /^\d+$/, nexus: /^\d+$/, gamebanana: /^\d+$/ }
const GAME = { thunderstore: /^[\w-]+$/, curseforge: /^\d+$/, nexus: /^\w+$/, gamebanana: /^\d+$/ }
const VER = /^[\w.+-]+$/
const CONFIG_DIR = { thunderstore: 'BepInEx/config', modrinth: 'config' }
const url = s => typeof s === 'string' && s.startsWith('https://') ? s : undefined
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

module.exports = root => {
  fs.mkdirSync(root, { recursive: true })
  const settingsFile = path.join(root, '..', 'settings.json')
  const settings = () => { try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')) } catch { return {} } }
  const dir = id => inside(root, id)
  const files = p => path.join(dir(p.id), 'files')
  const load = id => JSON.parse(fs.readFileSync(path.join(dir(id), 'profile.json'), 'utf8'))
  const save = p => (fs.writeFileSync(path.join(dir(p.id), 'profile.json'), JSON.stringify(p, null, 1)), p)
  const ctx = { files, settings }
  const S = Object.fromEntries(Object.keys(ID).map(k => [k, require(`./sources/${k}`)(ctx)]))
  const srcOf = (p, m) => m.src || SOURCES[p.type][0]
  const vidOf = m => m.vid ?? m.version

  const create = ({ name, type, game, gameId, gameName, mc, icon, banner }) => {
    if (!SOURCES[type]) throw new Error('Unknown profile type')
    if (type === 'modrinth' ? !(mc && VER.test(mc.version) && /^\w+$/.test(mc.loader)) : !GAME[type].test(game || '') || (type === 'nexus' && !/^\d+$/.test(gameId)))
      throw new Error('Pick a game first')
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    fs.mkdirSync(dir(id), { recursive: true })
    return save({ id, name: String(name || 'Profile').slice(0, 40), type, game, gameId: gameId && String(gameId), gameName: gameName && String(gameName).slice(0, 80),
      mc: type === 'modrinth' ? mc : undefined, icon: url(icon), banner: url(banner),
      target: type === 'modrinth' ? minecraftDir() : '', mods: [], extra: [], deployed: [] })
  }

  // Installs a mod (+ required deps) into profile p in place. Returns warnings.
  async function installMod(p, src, id, vid, deps = true, nxm) {
    if (!SOURCES[p.type].includes(src)) throw new Error(`${src} mods can't go in this profile`)
    if (p.mods.some(m => m.id === id)) return []
    const r = await S[src].install(p, id, vid, nxm)
    p.mods.push({ ...r.mod, src }); save(p)
    const warns = r.warn ? [r.warn] : []
    if (deps) for (const d of r.deps) warns.push(...await installMod(p, src, d.id, d.vid, true).catch(e => [`Dependency ${d.id}: ${e.message}`]))
    return warns
  }
  const uninstall = (pid, id) => {
    const p = load(pid), m = p.mods.find(m => m.id === id)
    if (m) for (const f of m.files) remove(files(p), f)
    p.mods = p.mods.filter(m => m.id !== id)
    return save(p)
  }
  // Install (or switch to) a version; returns the profile with transient warnings.
  const install = async (pid, src, id, vid, nxm) => {
    if (load(pid).mods.some(m => m.id === id)) uninstall(pid, id)
    const p = load(pid), warn = await installMod(p, src, id, vid, true, nxm)
    return { ...p, warn }
  }

  const configs = p => {
    const rel = CONFIG_DIR[p.type]
    return rel && p.target ? Object.fromEntries(walk(path.join(p.target, rel)).map(f => [`${rel}/${f}`, fs.readFileSync(path.join(p.target, rel, f))])) : {}
  }
  const shareData = p => ({ n: p.name, t: p.type, g: p.game, gi: p.gameId, gn: p.gameName, mc: p.mc, i: p.icon, b: p.banner,
    m: p.mods.map(m => srcOf(p, m) === SOURCES[p.type][0] ? [m.id, vidOf(m)] : [m.id, vidOf(m), srcOf(p, m)]) })

  // Validates untrusted share data, creates the profile, installs pinned versions and writes shared configs.
  async function importData(d, name, cfg = {}) {
    const ok = SOURCES[d?.t] && Array.isArray(d.m) && d.m.every(([id, v, src = SOURCES[d.t][0]] = []) =>
      SOURCES[d.t].includes(src) && ID[src].test(id) && VER.test(v))
    if (!ok) throw new Error('Invalid share code')
    const p = create({ name: name || d.n, type: d.t, game: d.g, gameId: d.gi, gameName: d.gn, mc: d.mc && { version: d.mc.version, loader: d.mc.loader }, icon: d.i, banner: d.b })
    const failed = []
    for (const [id, v, src = SOURCES[d.t][0]] of d.m) await installMod(p, src, id, v, false).catch(e => failed.push(`${id}: ${e.message}`))
    for (const [rel, data] of Object.entries(cfg)) write(files(p), rel, data), p.extra.push(rel)
    save(p)
    return { profile: p, failed }
  }

  // r2modman-compatible profile codes (hosted by Thunderstore, includes configs).
  const r2Yaml = p => `profileName: ${JSON.stringify(p.name)}\ngame: ${p.game}\nmods:\n` + p.mods.map(m => {
    const [major = 0, minor = 0, patch = 0] = vidOf(m).split('.').map(Number)
    return `  - name: ${m.id}\n    version:\n      major: ${major}\n      minor: ${minor}\n      patch: ${patch}\n    enabled: ${!m.disabled}\n`
  }).join('')
  async function importR2(key, name, game) {
    const text = await (await get(`${TS}/api/experimental/legacyprofile/get/${q(key)}/`)).text()
    const zip = unzipSync(Buffer.from(text.replace(/^#r2modman\s*/, ''), 'base64'))
    const yaml = strFromU8(zip['export.r2x'] || new Uint8Array())
    const g = yaml.match(/^game:\s*([\w-]+)/m)?.[1] || game
    if (!g) throw new Error('This r2modman code has no game: select a Thunderstore profile of that game first, then import')
    const mods = [...yaml.matchAll(/- name: (\S+)\s+version:\s+major: (\d+)\s+minor: (\d+)\s+patch: (\d+)/g)].map(m => [m[1], `${m[2]}.${m[3]}.${m[4]}`])
    const cfg = Object.fromEntries(Object.entries(zip).filter(([f]) => f !== 'export.r2x' && !f.endsWith('/')))
    const n = yaml.match(/^profileName:\s*(.+)$/m)?.[1]?.replace(/^"|"$/g, '')
    return importData({ n, t: 'thunderstore', g, m: mods }, name, cfg)
  }

  // One write at a time: profile.json is read-modify-written.
  let chain = Promise.resolve()
  const serial = fn => (...a) => { const r = chain.then(() => fn(...a)); chain = r.catch(() => {}); return r }
  const parallel = ['listProfiles', 'games', 'mcVersions', 'search', 'checkUpdates', 'details', 'getSettings', 'launch', 'exportCode', 'exportR2', 'exportFile']

  return Object.fromEntries(Object.entries({
    listProfiles: () => fs.readdirSync(root).filter(d => fs.existsSync(path.join(root, d, 'profile.json'))).map(load),
    createProfile: create,
    updateProfile: (id, patch) => save({ ...load(id), ...(patch.name ? { name: String(patch.name).slice(0, 40) } : {}), ...(patch.target ? { target: patch.target } : {}) }),
    deleteProfile: id => fs.rmSync(dir(id), { recursive: true, force: true }),
    getSettings: settings,
    setSettings: patch => {
      const s = { ...settings(), ...Object.fromEntries(['curseforgeKey', 'nexusKey', 'nxmHandler'].filter(k => k in patch).map(k => [k, patch[k]])) }
      fs.writeFileSync(settingsFile, JSON.stringify(s, null, 1)); return s
    },

    games: (type, text) => S[type].games(text),
    mcVersions: async () => (await json(`${MR}/tag/game_version`)).filter(v => v.version_type === 'release').map(v => v.version),
    search: (pid, src, text = '', page = 1, opts = {}) => S[src].search(load(pid), text, page, opts),
    details: async (pid, src, id) => { const p = load(pid); return { ...await S[src].details(p, id), url: S[src].url(p, id) } },
    pageUrl: (pid, src, id) => S[src].url(load(pid), id),

    install,
    uninstall,
    setDisabled: (pid, id, disabled) => {
      const p = load(pid), m = p.mods.find(m => m.id === id)
      if (m) m.disabled = !!disabled
      return save(p)
    },
    // Returns { [modId]: newVersion } for mods with a newer compatible release.
    checkUpdates: async pid => {
      const p = load(pid)
      const latest = await Promise.all(p.mods.map(m => S[srcOf(p, m)].latest(p, m).catch(() => null)))
      return Object.fromEntries(p.mods.map((m, i) => [m.id, latest[i]]).filter(([m, v], i) => v && v.vid !== vidOf(p.mods[i])).map(([id, v]) => [id, v.version]))
    },
    update: async (pid, id) => {
      const was = load(pid).mods.find(m => m.id === id)
      if (!was) throw new Error('Mod not installed')
      const p = await install(pid, srcOf(load(pid), was), id, null)
      const m = p.mods.find(m => m.id === id)
      if (m && was.disabled) m.disabled = true, save(p)
      return p
    },

    // Copy enabled mods + shared configs into the target folder; removes what the previous deploy put there first.
    deploy: id => {
      const p = load(id)
      if (!p.target) throw new Error('Set the target folder first')
      for (const f of p.deployed || []) remove(p.target, f)
      p.deployed = [...new Set([...p.mods.filter(m => !m.disabled).flatMap(m => m.files), ...(p.extra || [])])]
      for (const f of p.deployed) {
        fs.mkdirSync(path.dirname(inside(p.target, f)), { recursive: true })
        fs.copyFileSync(inside(files(p), f), inside(p.target, f))
      }
      p.extra = [] // shared configs apply once; afterwards the game's own files win
      return save(p)
    },

    findGame: id => {
      const p = load(id)
      let found = p.type === 'modrinth' ? fs.existsSync(minecraftDir()) && minecraftDir() : null
      if (!found) {
        const games = steamGames(), n = norm(p.gameName || p.game)
        found = (games.find(g => norm(g.name) === n) || games.find(g => norm(g.name).includes(n) || n.includes(norm(g.name))))?.dir
      }
      if (!found) throw new Error(process.platform === 'win32' ? 'Game not found in your Steam libraries — pick the folder manually' : 'Auto-find works on Windows only')
      return save({ ...p, target: found })
    },
    launch: id => {
      const p = load(id)
      if (process.platform !== 'win32') throw new Error('Launch works on Windows only')
      const run = (cmd, args) => spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref()
      if (p.type === 'modrinth') {
        const exe = ['ProgramFiles(x86)', 'ProgramFiles'].map(k => process.env[k] && path.join(process.env[k], 'Minecraft Launcher', 'MinecraftLauncher.exe')).find(f => f && fs.existsSync(f))
        return exe ? run(exe, []) : run('explorer.exe', ['shell:AppsFolder\\Microsoft.4297127D64EC6_8wekyb3d8bbwe!Minecraft'])
      }
      const t = path.normalize(p.target || '').toLowerCase()
      const g = t && steamGames().find(g => (t + path.sep).startsWith(g.dir.toLowerCase() + path.sep))
      if (!g) throw new Error('Not a Steam game folder — start the game yourself')
      run('explorer.exe', [`steam://rungameid/${g.appid}`])
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
