// Mod manager core: profiles on disk + per-site sources. Skipped: database, cache layer, download queue.
const fs = require('fs'), path = require('path'), os = require('os'), zlib = require('zlib')
const { spawn, execFileSync } = require('child_process')
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
module.exports = (root, { emit = () => {}, encrypt = s => s, decrypt = s => s } = {}) => {
  fs.mkdirSync(root, { recursive: true })
  const mcl = MC(path.join(root, '..', 'minecraft'))
  const settingsFile = path.join(root, '..', 'settings.json')
  const settings = () => { try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')) } catch { return {} } }
  const dir = id => inside(root, id)
  const files = p => path.join(dir(p.id), 'files')
  const load = id => JSON.parse(fs.readFileSync(path.join(dir(id), 'profile.json'), 'utf8'))
  const save = p => (fs.writeFileSync(path.join(dir(p.id), 'profile.json'), JSON.stringify(p, null, 1)), p)
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

  // Installs a mod (+ required deps) into profile p in place. Returns warnings.
  async function installMod(p, src, id, vid, deps = true, nxm, auto) {
    if (!SOURCES[p.type].includes(src)) throw new Error(`${src} mods can't go in this profile`)
    if (p.mods.some(m => m.id === id)) return []
    const r = await S[src].install(p, id, vid, nxm)
    p.mods.push({ ...r.mod, src, ...(r.deps.length ? { deps: r.deps.map(d => d.id) } : {}), ...(r.incompat?.length ? { incompat: r.incompat } : {}), ...(auto ? { auto: true } : {}) }); save(p)
    const warns = r.warn ? [r.warn] : []
    if (deps) for (const d of r.deps) warns.push(...await installMod(p, src, d.id, d.vid, true, undefined, true).catch(e => [`Dependency ${d.id}: ${e.message}`]))
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
    m: p.mods.filter(m => m.src !== 'local').map(m => srcOf(p, m) === SOURCES[p.type][0] ? [m.id, vidOf(m)] : [m.id, vidOf(m), srcOf(p, m)]) })

  // Validates untrusted share data, creates the profile, installs pinned versions and writes shared configs.
  async function importData(d, name, cfg = {}) {
    if (!validData(d)) throw new Error('Invalid share code')
    const p = create({ name: name || d.n, type: d.t, game: d.g, gameId: d.gi, gameName: d.gn, mc: d.mc && { version: d.mc.version, loader: d.mc.loader }, icon: d.i, banner: d.b })
    const failed = []
    for (const [id, v, src = SOURCES[d.t][0]] of d.m) await installMod(p, src, id, v, false).catch(e => failed.push(`${id}: ${e.message}`))
    for (const [rel, data] of Object.entries(cfg)) write(files(p), rel, data), p.extra.push(rel)
    if (d.s && p.type === 'modrinth' && /^[\w.-]+:\d+$/.test(d.s)) addServer(p, d.s)
    save(p)
    return { profile: p, failed }
  }

  // r2modman-compatible profile codes (hosted by Thunderstore, includes configs).
  const r2Yaml = p => `profileName: ${JSON.stringify(p.name)}\ngame: ${p.game}\nmods:\n` + p.mods.map(m => {
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

  const setSettingsRaw = patch => { const s = { ...settings(), ...patch }; fs.writeFileSync(settingsFile, JSON.stringify(s, null, 1)); return s }
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
      if (m) uninstall(pid, id)
      p = load(pid)
      await installMod(p, src, id, v, false).catch(e => failed.push(`${id}: ${e.message}`))
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
  const isShaderPack = async data => { try { return Object.keys(unzipSync(data)).some(f => f.startsWith('shaders/')) } catch { return false } }

  const deployRaw = (id, { vanilla } = {}) => {
    const p = load(id)
    if (!p.target) throw new Error('Set the target folder first')
    for (const f of p.deployed || []) remove(p.target, f)
    const on = vanilla ? [] : p.mods.filter(m => !m.disabled)
    p.deployed = [...new Set([...on.flatMap(m => m.files), ...(vanilla ? [] : p.extra || [])])]
    for (const f of p.deployed) {
      fs.mkdirSync(path.dirname(inside(p.target, f)), { recursive: true })
      fs.copyFileSync(inside(files(p), f), inside(p.target, f))
    }
    // tModLoader loads only mods listed in Mods/enabled.json.
    if (p.type === 'terraria') write(p.target, 'Mods/enabled.json', JSON.stringify(on.flatMap(m => m.files).filter(f => f.endsWith('.tmod')).map(f => path.basename(f, '.tmod'))))
    p.extra = [] // shared configs apply once; afterwards the game's own files win
    return save(p)
  }

  // ---- Minecraft server internals ----
  const PROPS = ['motd', 'gamemode', 'difficulty', 'pvp', 'max-players', 'view-distance', 'simulation-distance', 'allow-flight', 'spawn-protection',
    'level-seed', 'level-name', 'hardcore', 'white-list', 'enforce-whitelist', 'allow-nether', 'spawn-monsters', 'enable-command-block', 'online-mode', 'server-port']
  const readProps = file => { try { return Object.fromEntries(fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])) } catch { return {} } }
  const lastLogs = {}, crashes = {}
  const GEYSER = { fabric: ['geyser', 'floodgate'], neoforge: ['geyser', 'floodgate'] }

  async function backupWorld(pid) {
    const sdir = path.join(dir(pid), 'server'), s = servers[pid]
    const level = readProps(path.join(sdir, 'server.properties'))['level-name'] || 'world'
    if (!fs.existsSync(path.join(sdir, level))) throw new Error('No world yet: start the server once')
    if (s?.online) { s.child.stdin.write('save-off\nsave-all flush\n'); await new Promise(r => setTimeout(r, 3000)) }
    try {
      // shortcut: whole world is zipped in memory; fine for normal worlds, slow for multi-GB ones.
      const zip = {}
      for (const d of [level, `${level}_nether`, `${level}_the_end`]) for (const f of walk(path.join(sdir, d))) if (!f.endsWith('session.lock')) zip[`${d}/${f}`] = fs.readFileSync(path.join(sdir, d, f))
      const name = `${level}-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}.zip`
      write(path.join(dir(pid), 'server-backups'), name, zipSync(zip, { level: 1 }))
      return name
    } finally { if (s?.online) s.child.stdin.write('save-on\n') }
  }

  async function startServer(pid, { eula, maxMem = 2048, port = 25565, online = true, geyser = false, autoRestart = false, backupOnStop = false } = {}) {
    if (!eula) throw new Error('Accept the Minecraft EULA first')
    if (servers[pid]) throw new Error('Server already running')
    let p = load(pid)
    if (p.type !== 'modrinth') throw new Error('Servers are for Minecraft profiles')
    p = save({ ...p, server: { maxMem: +maxMem, port: +port, online: !!online, geyser: !!geyser, autoRestart: !!autoRestart, backupOnStop: !!backupOnStop } })
    const sdir = path.join(dir(pid), 'server'), s = servers[pid] = { log: [], online: false, players: new Set() }
    const log = line => { s.log.push(line); if (s.log.length > 3000) s.log.shift(); emit('slog', { pid, line }) }
    const status = () => emit('sstatus', { pid })
    try {
      log('Preparing server files…')
      const plan = await mcl.prepareServer({ mc: p.mc.version, loader: p.mc.loader, loaderVersion: p.mc.loaderVersion, dir: sdir, log })
      // Server-side files only: skip Modrinth projects marked server_side "unsupported" and modpack files marked client-only.
      const on = p.mods.filter(m => !m.disabled)
      const want = on.flatMap(m => m.files.filter(f => (/^mods\/.+\.jar$/i.test(f) || (m.pack && /^(config|defaultconfigs|kubejs|scripts|datapacks)\//.test(f))) && !m.clientOnly?.includes(f)))
      // Look every jar up on Modrinth by SHA1 (works for packs, CurseForge and local files too) and skip client-only projects.
      const hash = Object.fromEntries(want.filter(f => f.endsWith('.jar')).map(f => [crypto.createHash('sha1').update(fs.readFileSync(inside(files(p), f))).digest('hex'), f]))
      const found = Object.keys(hash).length ? await json(`${MR}/version_files`, { 'content-type': 'application/json' }, { method: 'POST', body: JSON.stringify({ hashes: Object.keys(hash), algorithm: 'sha1' }) }).catch(() => ({})) : {}
      const ids = [...new Set(Object.values(found).map(v => v.project_id))]
      const side = {}
      for (let i = 0; i < ids.length; i += 100) for (const x of await json(`${MR}/projects?ids=${q(ids.slice(i, i + 100))}`).catch(() => [])) side[x.id] = x.server_side
      const clientOnly = new Set(Object.entries(found).filter(([, v]) => side[v.project_id] === 'unsupported').map(([h]) => hash[h]))
      fs.rmSync(path.join(sdir, 'mods'), { recursive: true, force: true })
      for (const f of want) if (!clientOnly.has(f)) write(sdir, f, fs.readFileSync(inside(files(p), f)))
      if (clientOnly.size) log(`Skipped ${clientOnly.size} client-only mods`)
      if (geyser) {
        if (!GEYSER[p.mc.loader]) throw new Error('Bedrock crossplay (Geyser) needs a Fabric or NeoForge profile')
        // Geyser + Floodgate and their required dependencies (e.g. Fabric API) unless the profile already has them.
        const have = new Set([...Object.values(found).map(v => v.project_id), ...on.map(m => m.id)]), todo = [...GEYSER[p.mc.loader]]
        while (todo.length) {
          const slug = todo.shift()
          const v = (await json(`${MR}/project/${slug}/version?loaders=${q([p.mc.loader])}&game_versions=${q([p.mc.version])}`))[0]
          if (!v) throw new Error(`${slug} has no build for ${p.mc.loader} ${p.mc.version}`)
          if (have.has(v.project_id)) continue
          have.add(v.project_id)
          const f = v.files.find(f => f.primary) || v.files[0]
          write(sdir, `mods/${path.basename(f.filename)}`, await lib.bytes(f.url))
          todo.push(...v.dependencies.filter(d => d.dependency_type === 'required' && d.project_id && !have.has(d.project_id)).map(d => d.project_id))
        }
        s.bedrock = `${(s.lanIp = lanIp())}:19132`
      }
      fs.writeFileSync(path.join(sdir, 'eula.txt'), 'eula=true\n')
      const propsFile = path.join(sdir, 'server.properties'), props = readProps(propsFile)
      fs.writeFileSync(propsFile, Object.entries({ motd: p.name.replace(/[\r\n]/g, ''), 'max-players': 10, ...props, 'server-port': +port, 'online-mode': !!online })
        .map(([k, v]) => `${k}=${v}`).join('\n') + '\n')
      const child = s.child = spawn(plan.java, [`-Xmx${+maxMem}M`, '-Dlog4j2.formatMsgNoLookups=true', ...plan.args], { cwd: sdir })
      const out = d => String(d).split(/\r?\n/).filter(Boolean).forEach(l => {
        log(l)
        if (!s.online && /Done \(/.test(l)) s.online = true, s.since = Date.now(), status()
        const j = l.match(/: (\w{1,16}) joined the game/), left = l.match(/: (\w{1,16}) left the game/)
        if (j) s.players.add(j[1]), status()
        if (left) s.players.delete(left[1]), status()
      })
      child.stdout.on('data', out); child.stderr.on('data', out)
      child.on('exit', async code => {
        s.tunnel?.close(); log(`Server stopped (code ${code})`)
        lastLogs[pid] = s.log; delete servers[pid]
        const opts = load(pid).server || {}
        if (opts.backupOnStop) await backupWorld(pid).then(n => log(`Backup saved: ${n}`)).catch(e => log(`Backup failed: ${e.message}`))
        status()
        // Auto-restart after a crash, or after the user pressed Restart.
        // At most 3 crash restarts within 10 minutes, so a broken mod doesn't loop forever.
        const recent = (crashes[pid] = [...(crashes[pid] || []), Date.now()].filter(t => Date.now() - t < 600e3))
        if (!s.restart && !s.stopping && opts.autoRestart && recent.length > 3) return log('Crashed 3 times in a row — not restarting. Check the console.')
        if (s.restart || (opts.autoRestart && !s.stopping)) {
          log(s.restart ? 'Restarting…' : 'Server crashed — restarting in 5 seconds…')
          setTimeout(() => startServer(pid, { ...opts, eula: true }).catch(e => emit('slog', { pid, line: `Restart failed: ${e.message}` })), s.restart ? 500 : 5000)
        }
      })
      s.lan = `${lanIp()}:${port}`
      status()
      return true
    } catch (e) { lastLogs[pid] = s.log; delete servers[pid]; status(); throw e }
  }
  const lanIp = () => Object.values(os.networkInterfaces()).flat().find(i => i.family === 'IPv4' && !i.internal)?.address || 'localhost'

  // One write at a time: profile.json is read-modify-written.
  let chain = Promise.resolve()
  const serial = fn => (...a) => { const r = chain.then(() => fn(...a)); chain = r.catch(() => {}); return r }
  const serialDeploy = (id, o) => serial(deployRaw)(id, o)
  const parallel = ['listProfiles', 'games', 'mcVersions', 'search', 'checkUpdates', 'details', 'getSettings', 'launch', 'exportCode', 'exportR2', 'exportFile',
    'preview', 'checkFollow', 'publish', 'analyzeCrash', 'javaList', 'conflicts', 'orphans', 'serverStatus', 'serverCmd', 'serverStop', 'serverStart', 'serverShare', 'inviteCode', 'serverRestart', 'serversRunning',
    'serverProps', 'serverPlayers', 'playerAction', 'backups', 'backup',
    'accounts', 'loginStart', 'loginFinish', 'filters', 'running', 'getLog', 'stop', 'play', 'repair', 'worlds', 'logFiles', 'readLog', 'exportMrpack']

  return Object.fromEntries(Object.entries({
    listProfiles: () => fs.readdirSync(root).filter(d => fs.existsSync(path.join(root, d, 'profile.json'))).map(load),
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
    deleteProfile: id => fs.rmSync(dir(id), { recursive: true, force: true }),
    getSettings: settings,
    setSettings: patch => {
      const pick = ['curseforgeKey', 'nexusKey', 'nxmHandler', 'modrinthToken', 'msClientId', 'theme', 'githubToken'].filter(k => k in patch)
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
    deploy: (id, o) => deployRaw(id, o),

    findGame: id => {
      const p = load(id)
      let found = p.type === 'modrinth' ? fs.existsSync(minecraftDir()) && minecraftDir() : p.type === 'terraria' ? tmlDir() : null
      if (!found && p.type === 'terraria') throw new Error('tModLoader folder not found — start tModLoader once, or pick Documents/My Games/Terraria/tModLoader')
      if (!found) {
        const games = steamGames(), n = norm(p.gameName || p.game)
        found = (games.find(g => norm(g.name) === n) || games.find(g => norm(g.name).includes(n) || n.includes(norm(g.name))))?.dir
      }
      if (!found) throw new Error(process.platform === 'win32' ? 'Game not found in your Steam libraries — pick the folder manually' : 'Auto-find works on Windows only')
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
      const g = t && steamGames().find(g => (t + path.sep).startsWith(g.dir.toLowerCase() + path.sep))
      if (!g) throw new Error('Not a Steam game folder — start the game yourself')
      steamRun(g.appid)
    },

    // ---- Mod management extras ----
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
      for (const m of on) for (const f of m.files) (owner[f] ||= []).push(m.name)
      for (const [file, names] of Object.entries(owner)) if (names.length > 1 && !/\/config\//i.test(`/${file}`)) out.push({ type: 'file', file, mods: names })
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
      const r = await syncData(pid, d, drop, cfg)
      if (rev && r.profile.follow && `gist:${r.profile.follow.gist}` === String(input).trim()) r.profile = save({ ...r.profile, follow: { ...r.profile.follow, rev } })
      return r
    },

    // Live share via a secret GitHub Gist: the publisher needs a token with "gist" scope; friends only read.
    publish: async pid => {
      const p = load(pid), token = settings().githubToken
      if (!token) throw new Error('Add a GitHub token (gist scope) in Settings to live-share')
      const body = JSON.stringify({ description: `Mod Manager: ${p.name}`, public: false, files: { 'modmanager.json': { content: JSON.stringify(shareData(p)) } } })
      const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' }
      const r = p.publish
        ? await json(`https://api.github.com/gists/${q(p.publish)}`, headers, { method: 'PATCH', body }).catch(e => e.status === 404 ? null : Promise.reject(e))
        : null
      const g = r || await json('https://api.github.com/gists', headers, { method: 'POST', body })
      return save({ ...p, publish: g.id }).publish
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
      const s = servers[pid], p = load(pid)
      return { running: !!s, online: !!s?.online, address: s?.address, lan: s?.lan, bedrock: s?.bedrock, players: s ? [...s.players] : [],
        since: s?.since, log: s?.log || lastLogs[pid] || [], opts: p.server || {} }
    },
    serverCmd: (pid, cmd) => { servers[pid]?.child.stdin.write(String(cmd).replace(/\n/g, ' ') + '\n'); return true },
    serverStop: pid => { const s = servers[pid]; if (s) s.stopping = true, s.child.stdin.write('stop\n'); return true },
    serversRunning: () => Object.keys(servers),
    serverStart: (pid, opts = {}) => startServer(pid, opts),
    serverRestart: async pid => {
      const s = servers[pid]; if (!s) throw new Error('Server is not running')
      s.restart = true; s.stopping = true; s.child.stdin.write('stop\n'); return true
    },

    // server.properties editor (whitelisted keys only).
    serverProps: pid => readProps(path.join(dir(pid), 'server', 'server.properties')),
    setServerProps: (pid, patch) => {
      const file = path.join(dir(pid), 'server', 'server.properties'), cur = readProps(file)
      for (const [k, v] of Object.entries(patch)) if (PROPS.includes(k)) cur[k] = String(v).replace(/[\r\n]/g, ' ').slice(0, 200)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, Object.entries(cur).map(([k, v]) => `${k}=${v}`).join('\n') + '\n')
      return cur
    },

    // Players: online (from log), ops / whitelist / bans (server json files); actions go through the console.
    serverPlayers: pid => {
      const sdir = path.join(dir(pid), 'server'), names = f => { try { return JSON.parse(fs.readFileSync(path.join(sdir, f), 'utf8')).map(x => x.name) } catch { return [] } }
      return { online: [...(servers[pid]?.players || [])], ops: names('ops.json'), whitelist: names('whitelist.json'), banned: names('banned-players.json') }
    },
    playerAction: (pid, action, name) => {
      const cmd = { op: 'op', deop: 'deop', kick: 'kick', ban: 'ban', pardon: 'pardon', allow: 'whitelist add', disallow: 'whitelist remove' }[action]
      if (!cmd || !/^[A-Za-z0-9_]{1,16}$/.test(name)) throw new Error('Invalid player action')
      if (!servers[pid]) throw new Error('Start the server to manage players')
      servers[pid].child.stdin.write(`${cmd} ${name}\n`)
      if (action === 'allow' || action === 'disallow') servers[pid].child.stdin.write('whitelist reload\n')
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
      const sdir = path.join(dir(pid), 'server'), level = readProps(path.join(sdir, 'server.properties'))['level-name'] || 'world'
      const zip = unzipSync(fs.readFileSync(inside(path.join(dir(pid), 'server-backups'), name)))
      for (const d of [level, `${level}_nether`, `${level}_the_end`]) fs.rmSync(inside(sdir, d), { recursive: true, force: true })
      for (const [f, data] of Object.entries(zip)) if (!f.endsWith('/')) write(sdir, f, data)
      return true
    },
    deleteBackup: (pid, name) => {
      if (!/^[\w.-]+\.zip$/.test(name)) throw new Error('Bad backup name')
      fs.rmSync(inside(path.join(dir(pid), 'server-backups'), name), { force: true }); return true
    },
    // Public address for friends outside your network.
    serverShare: async pid => {
      const s = servers[pid]
      if (!s) throw new Error('Start the server first')
      if (s.address) return s.address
      const port = +s.lan.split(':')[1]
      s.tunnel = await tunnel.open(port, { onError: () => { s.address = null; emit('sstatus', { pid }) } })
      s.address = `${s.tunnel.host}:${s.tunnel.port}`
      emit('sstatus', { pid })
      return s.address
    },
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
    stop: pid => { if (running[pid]) running[pid].stopped = true, running[pid].child.kill(); return true },

    // Prepare (download game, loader, Java), deploy mods into the instance folder and start Minecraft.
    play: async (pid, quickPlay = {}, { vanilla } = {}) => {
      if (running[pid]) throw new Error('Already running')
      let p = load(pid)
      if (p.type !== 'modrinth') throw new Error('Only Minecraft profiles launch from here')
      const acct = await activeAccount()
      const status = text => emit('status', { pid, text })
      const log = line => { (logs[pid] ||= []).push(line); if (logs[pid].length > 5000) logs[pid].shift(); emit('log', { pid, line }) }
      logs[pid] = []
      status('Preparing…')
      const plan = await mcl.prepare({ mc: p.mc.version, loader: p.mc.loader, loaderVersion: p.mc.loaderVersion, log, progress: status })
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
      running[pid] = { child }
      status('Running')
      return true
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
        const name = path.basename(file), data = fs.readFileSync(file), out = []
        let rel
        if (p.type === 'modrinth') {
          rel = /\.jar$/i.test(name) ? `mods/${name}` : /\.mrpack$/i.test(name) ? null : (await isShaderPack(data)) ? `shaderpacks/${name}` : `resourcepacks/${name}`
          if (/\.mrpack$/i.test(name)) {
            const r = await S.modrinth.installPackData(p, unzipSync(data), { id: `local:${name}`, name: name.replace(/\.mrpack$/i, ''), version: 'local' })
            p.mods = p.mods.filter(m => m.id !== r.mod.id); p.mods.push({ ...r.mod, src: 'local' }); continue
          }
          write(files(p), rel, data); out.push(rel)
        } else if (p.type === 'terraria' && /\.tmod$/i.test(name)) {
          rel = `Mods/${name}`; write(files(p), rel, data); out.push(rel)
        } else if (p.type === 'thunderstore' && /\.dll$/i.test(name)) {
          rel = `BepInEx/plugins/${name}`; write(files(p), rel, data); out.push(rel)
        } else for (const [r, d] of Object.entries(await require('./lib').extract(name, data))) write(files(p), r, d), out.push(r)
        p.mods = p.mods.filter(m => m.id !== `local:${name}`)
        p.mods.push({ id: `local:${name}`, src: 'local', name, version: 'local', files: out })
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
        for (const rel of m.files) zip[`overrides/${rel}`] = fs.readFileSync(inside(files(p), rel))
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
        const r = await S.modrinth.installPackData(p, zip, { id: `local:${path.basename(src)}`, name: index.name, version: index.versionId || 'local' })
        p.mods.push({ ...r.mod, src: 'local' })
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
        const n = f.replace(/\.disabled$/i, ''), rel = `mods/${n}`
        write(files(p), rel, fs.readFileSync(path.join(modsDir, f)))
        p.mods.push({ id: `local:${n}`, src: 'local', name: n, version: 'local', files: [rel], disabled: f.endsWith('.disabled') || undefined })
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
