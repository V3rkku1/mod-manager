// Mod manager core: profiles on disk + per-site sources. Skipped: database, cache layer, download queue.
const fs = require('fs'), path = require('path'), os = require('os'), zlib = require('zlib')
const { spawn, execFileSync } = require('child_process')
const { zipSync, unzipSync, strToU8, strFromU8 } = require('fflate')
const { json, get, q, inside, write, remove, walk } = require('./lib')
const MC = require('./mc'), auth = require('./auth')

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
    m: p.mods.filter(m => m.src !== 'local').map(m => srcOf(p, m) === SOURCES[p.type][0] ? [m.id, vidOf(m)] : [m.id, vidOf(m), srcOf(p, m)]) })

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

  const setSettingsRaw = patch => { const s = { ...settings(), ...patch }; fs.writeFileSync(settingsFile, JSON.stringify(s, null, 1)); return s }
  const cleanLaunch = o => Object.fromEntries(Object.entries({
    maxMem: +o.maxMem || undefined, minMem: +o.minMem || undefined, width: +o.width || undefined, height: +o.height || undefined, fullscreen: !!o.fullscreen || undefined,
    java: o.java, jvmArgs: o.jvmArgs, env: o.env, preLaunch: o.preLaunch, wrapper: o.wrapper, postExit: o.postExit,
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
  const isShaderPack = async data => { try { return Object.keys(unzipSync(data)).some(f => f.startsWith('shaders/')) } catch { return false } }

  const deployRaw = id => {
    const p = load(id)
    if (!p.target) throw new Error('Set the target folder first')
    for (const f of p.deployed || []) remove(p.target, f)
    p.deployed = [...new Set([...p.mods.filter(m => !m.disabled).flatMap(m => m.files), ...(p.extra || [])])]
    for (const f of p.deployed) {
      fs.mkdirSync(path.dirname(inside(p.target, f)), { recursive: true })
      fs.copyFileSync(inside(files(p), f), inside(p.target, f))
    }
    // tModLoader loads only mods listed in Mods/enabled.json.
    if (p.type === 'terraria') write(p.target, 'Mods/enabled.json', JSON.stringify(p.mods.filter(m => !m.disabled).flatMap(m => m.files).filter(f => f.endsWith('.tmod')).map(f => path.basename(f, '.tmod'))))
    p.extra = [] // shared configs apply once; afterwards the game's own files win
    return save(p)
  }

  // One write at a time: profile.json is read-modify-written.
  let chain = Promise.resolve()
  const serial = fn => (...a) => { const r = chain.then(() => fn(...a)); chain = r.catch(() => {}); return r }
  const serialDeploy = id => serial(deployRaw)(id)
  const parallel = ['listProfiles', 'games', 'mcVersions', 'search', 'checkUpdates', 'details', 'getSettings', 'launch', 'exportCode', 'exportR2', 'exportFile',
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
      const pick = ['curseforgeKey', 'nexusKey', 'nxmHandler', 'modrinthToken', 'msClientId', 'theme'].filter(k => k in patch)
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
      const latest = await Promise.all(p.mods.map(m => m.src === 'local' ? null : S[srcOf(p, m)].latest(p, m).catch(() => null)))
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
    deploy: deployRaw,

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
    launch: id => {
      const p = load(id)
      if (process.platform !== 'win32') throw new Error('Launch works on Windows only')
      const run = (cmd, args) => spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref()
      if (p.type === 'modrinth') {
        const exe = ['ProgramFiles(x86)', 'ProgramFiles'].map(k => process.env[k] && path.join(process.env[k], 'Minecraft Launcher', 'MinecraftLauncher.exe')).find(f => f && fs.existsSync(f))
        return exe ? run(exe, []) : run('explorer.exe', ['shell:AppsFolder\\Microsoft.4297127D64EC6_8wekyb3d8bbwe!Minecraft'])
      }
      if (p.type === 'terraria') return run('explorer.exe', ['steam://rungameid/1281930'])
      const t = path.normalize(p.target || '').toLowerCase()
      const g = t && steamGames().find(g => (t + path.sep).startsWith(g.dir.toLowerCase() + path.sep))
      if (!g) throw new Error('Not a Steam game folder — start the game yourself')
      run('explorer.exe', [`steam://rungameid/${g.appid}`])
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
    play: async (pid, quickPlay = {}) => {
      if (running[pid]) throw new Error('Already running')
      let p = load(pid)
      if (p.type !== 'modrinth') throw new Error('Only Minecraft profiles launch from here')
      const acct = await activeAccount()
      const status = text => emit('status', { pid, text })
      const log = line => { (logs[pid] ||= []).push(line); if (logs[pid].length > 5000) logs[pid].shift(); emit('log', { pid, line }) }
      logs[pid] = []
      status('Preparing…')
      const plan = await mcl.prepare({ mc: p.mc.version, loader: p.mc.loader, loaderVersion: p.mc.loaderVersion, log, progress: status })
      p = await serialDeploy(pid)
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
