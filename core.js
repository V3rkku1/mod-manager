// Mod manager core: plain Node + fetch. Skipped: database, cache layer, download queue. Profiles are JSON files on disk.
const fs = require('fs'), path = require('path'), os = require('os'), zlib = require('zlib')
const { unzipSync } = require('fflate')

const TS = 'https://thunderstore.io', MR = 'https://api.modrinth.com/v2'
const get = async url => {
  const r = await fetch(url, { headers: { 'User-Agent': 'mod-manager/0.2' } })
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`)
  return r
}
const json = async url => (await get(url)).json()
const bytes = async url => new Uint8Array(await (await get(url)).arrayBuffer())
const q = s => encodeURIComponent(typeof s === 'string' ? s : JSON.stringify(s))
const MC_DIRS = { mod: 'mods', resourcepack: 'resourcepacks', shader: 'shaderpacks' }
const TS_ID = /^[\w.-]+-\w+$/, VER = /^[\w.+-]+$/, MR_ID = /^\w+$/
const SORT = { popular: ['most-downloaded', 'downloads'], updated: ['last-updated', 'updated'], newest: ['newest', 'newest'] }
const url = s => typeof s === 'string' && s.startsWith('https://') ? s : undefined

const minecraftDir = () => process.platform === 'win32' ? path.join(process.env.APPDATA || os.homedir(), '.minecraft')
  : process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Application Support/minecraft')
  : path.join(os.homedir(), '.minecraft')

// Resolve rel inside base; throws on zip-slip / absolute paths from untrusted archives or share codes.
const inside = (base, rel) => {
  const full = path.resolve(base, rel)
  if (!full.startsWith(path.resolve(base) + path.sep)) throw new Error(`Unsafe path: ${rel}`)
  return full
}
const write = (base, rel, data) => {
  const full = inside(base, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, data)
}
// Delete a file, then any parent dirs it leaves empty (up to base).
const remove = (base, rel) => {
  let full = inside(base, rel)
  fs.rmSync(full, { force: true })
  while ((full = path.dirname(full)) !== path.resolve(base)) {
    try { fs.rmdirSync(full) } catch { break }
  }
}

// Map a file in a Thunderstore zip to its place in a BepInEx install (r2modman-style layout).
const tsRoute = (id, f, isPack) => {
  if (isPack) return /^BepInExPack[^/]*\/./.test(f) ? f.slice(f.indexOf('/') + 1) : null
  const [top, ...rest] = f.split('/'), t = top.toLowerCase()
  if (rest.length && ['plugins', 'patchers', 'core', 'monomod'].includes(t)) return `BepInEx/${t}/${id}/${rest.join('/')}`
  if (rest.length && t === 'config') return `BepInEx/config/${rest.join('/')}`
  if (rest.length && t === 'bepinex') return f
  return `BepInEx/plugins/${id}/${f}`
}
// shortcut: assumes BepInEx loader layout; MelonLoader/other-loader games need their own routing.

module.exports = root => {
  fs.mkdirSync(root, { recursive: true })
  const dir = id => inside(root, id)
  const files = p => path.join(dir(p.id), 'files')
  const load = id => JSON.parse(fs.readFileSync(path.join(dir(id), 'profile.json'), 'utf8'))
  const save = p => (fs.writeFileSync(path.join(dir(p.id), 'profile.json'), JSON.stringify(p, null, 1)), p)

  const create = ({ name, type, game, mc, icon, banner }) => {
    if (type === 'thunderstore' ? !/^[\w-]+$/.test(game || '') : !(mc && VER.test(mc.version) && /^\w+$/.test(mc.loader)))
      throw new Error('Pick a game / Minecraft version')
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    fs.mkdirSync(dir(id), { recursive: true })
    return save({ id, name: String(name || 'Profile').slice(0, 40), type, game, mc: type === 'modrinth' ? mc : undefined,
      icon: url(icon), banner: url(banner), target: type === 'modrinth' ? minecraftDir() : '', mods: [], deployed: [] })
  }

  const tsSplit = id => { const i = id.lastIndexOf('-'); return [id.slice(0, i), id.slice(i + 1)] }
  const tsLatest = id => { const [ns, name] = tsSplit(id); return json(`${TS}/api/experimental/package/${q(ns)}/${q(name)}/`).then(r => r.latest) }
  const mrFilter = (p, folder) => `game_versions=${q([p.mc.version])}` + (folder === 'mods' ? `&loaders=${q([p.mc.loader])}` : '')
  const mrLatest = (p, id, folder) => json(`${MR}/project/${q(id)}/version?${mrFilter(p, folder)}`).then(r => r[0])

  async function tsInstall(p, id, version, deps) {
    if (p.mods.some(m => m.id === id)) return
    const [ns, name] = tsSplit(id)
    const v = version ? await json(`${TS}/api/experimental/package/${q(ns)}/${q(name)}/${q(version)}/`) : await tsLatest(id)
    if (deps) for (const d of v.dependencies) await tsInstall(p, d.slice(0, d.lastIndexOf('-')), d.slice(d.lastIndexOf('-') + 1), true)
    const zip = unzipSync(await bytes(v.download_url))
    const names = Object.keys(zip).map(f => f.replace(/\\/g, '/'))
    const isPack = names.some(f => /^BepInExPack[^/]*\/BepInEx\//.test(f))
    const out = []
    Object.values(zip).forEach((data, n) => {
      const rel = !names[n].endsWith('/') && tsRoute(id, names[n], isPack)
      if (rel) write(files(p), rel, data), out.push(rel)
    })
    p.mods.push({ id, name: v.name, version: v.version_number, icon: v.icon, files: out })
    save(p)
  }

  async function mrInstall(p, id, vid, deps) {
    if (p.mods.some(m => m.id === id)) return
    const proj = await json(`${MR}/project/${q(id)}`)
    const folder = MC_DIRS[proj.project_type]
    if (!folder) throw new Error(`Unsupported project type: ${proj.project_type}`)
    const v = vid ? await json(`${MR}/version/${q(vid)}`) : await mrLatest(p, id, folder)
    if (!v) throw new Error(`${proj.title} has no version for ${p.mc.loader} ${p.mc.version}`)
    if (deps) for (const d of v.dependencies) if (d.dependency_type === 'required' && d.project_id) await mrInstall(p, d.project_id, null, true)
    const f = v.files.find(f => f.primary) || v.files[0]
    const rel = `${folder}/${path.basename(f.filename)}`
    write(files(p), rel, await bytes(f.url))
    p.mods.push({ id: proj.id, name: proj.title, version: v.version_number, vid: v.id, icon: proj.icon_url, files: [rel] })
    save(p)
  }

  const install = (pid, id, version, deps = true) => {
    const p = load(pid)
    return (p.type === 'modrinth' ? mrInstall : tsInstall)(p, id, version, deps).then(() => p)
  }
  const uninstall = (pid, id) => {
    const p = load(pid), m = p.mods.find(m => m.id === id)
    if (m) for (const f of m.files) remove(files(p), f)
    p.mods = p.mods.filter(m => m.id !== id)
    return save(p)
  }

  // One op at a time: profile.json is read-modify-written.
  let chain = Promise.resolve()
  const serial = fn => (...a) => { const r = chain.then(() => fn(...a)); chain = r.catch(() => {}); return r }
  const parallel = ['listProfiles', 'communities', 'mcVersions', 'search', 'checkUpdates']

  return Object.fromEntries(Object.entries({
    listProfiles: () => fs.readdirSync(root).filter(d => fs.existsSync(path.join(root, d, 'profile.json'))).map(load),
    createProfile: create,
    updateProfile: (id, patch) => save({ ...load(id), ...(patch.name ? { name: String(patch.name).slice(0, 40) } : {}), ...(patch.target ? { target: patch.target } : {}) }),
    deleteProfile: id => fs.rmSync(dir(id), { recursive: true, force: true }),

    communities: async () => (await json(`${TS}/api/cyberstorm/community/?page_size=1000`)).results
      .filter(c => c.is_listed !== false)
      .map(c => ({ id: c.identifier, name: c.name, icon: c.community_icon_url, cover: c.cover_image_url, banner: c.hero_image_url, downloads: c.total_download_count }))
      .sort((a, b) => b.downloads - a.downloads),
    mcVersions: async () => (await json(`${MR}/tag/game_version`)).filter(v => v.version_type === 'release').map(v => v.version),

    search: async (pid, text, page = 1, kind = 'mod', sort = 'popular') => {
      const p = load(pid), [tsSort, mrSort] = SORT[sort] || SORT.popular
      if (p.type === 'thunderstore') {
        const r = await json(`${TS}/api/cyberstorm/listing/${q(p.game)}/?q=${q(text || '')}&ordering=${tsSort}&page=${page}&page_size=20`)
        return r.results.map(m => ({ id: `${m.namespace}-${m.name}`, title: m.name.replace(/_/g, ' '), author: m.namespace,
          desc: m.description, icon: m.icon_url, downloads: m.download_count }))
      }
      const facets = [[`project_type:${kind}`], [`versions:${p.mc.version}`], ...(kind === 'mod' ? [[`categories:${p.mc.loader}`]] : [])]
      const index = sort === 'popular' && text ? 'relevance' : mrSort
      const r = await json(`${MR}/search?query=${q(text || '')}&facets=${q(facets)}&index=${index}&limit=20&offset=${(page - 1) * 20}`)
      return r.hits.map(m => ({ id: m.project_id, title: m.title, author: m.author, desc: m.description, icon: m.icon_url, downloads: m.downloads }))
    },

    install: (pid, id) => install(pid, id, null),
    uninstall,
    setDisabled: (pid, id, disabled) => {
      const p = load(pid), m = p.mods.find(m => m.id === id)
      if (m) m.disabled = !!disabled
      return save(p)
    },
    // Returns { [modId]: newVersion } for mods with a newer compatible release.
    checkUpdates: async pid => {
      const p = load(pid)
      const latest = await Promise.all(p.mods.map(m => (p.type === 'modrinth'
        ? mrLatest(p, m.id, m.files[0].split('/')[0]).then(v => v && v.id !== m.vid && v.version_number)
        : tsLatest(m.id).then(v => v.version_number !== m.version && v.version_number)).catch(() => false)))
      return Object.fromEntries(p.mods.map((m, i) => [m.id, latest[i]]).filter(([, v]) => v))
    },
    update: async (pid, id) => {
      const was = load(pid).mods.find(m => m.id === id)
      uninstall(pid, id)
      const p = await install(pid, id, null)
      const m = p.mods.find(m => m.id === id)
      if (m && was?.disabled) m.disabled = true
      return save(p)
    },

    // Copy enabled mods into the game / .minecraft folder; removes what the previous deploy put there first.
    deploy: id => {
      const p = load(id)
      if (!p.target) throw new Error('Set the target folder first')
      for (const f of p.deployed || []) remove(p.target, f)
      p.deployed = p.mods.filter(m => !m.disabled).flatMap(m => m.files)
      for (const f of p.deployed) {
        fs.mkdirSync(path.dirname(inside(p.target, f)), { recursive: true })
        fs.copyFileSync(inside(files(p), f), inside(p.target, f))
      }
      return save(p)
    },

    // Share code: "MM1" + base64url(deflate(JSON)). Pinned versions so friends get exactly the same set.
    exportCode: id => {
      const p = load(id)
      const d = { n: p.name, t: p.type, g: p.game, mc: p.mc, i: p.icon, b: p.banner,
        m: p.mods.map(m => [m.id, p.type === 'modrinth' ? m.vid : m.version]) }
      return 'MM1' + zlib.deflateRawSync(JSON.stringify(d)).toString('base64url')
    },
    importCode: async (code, name) => {
      let d
      try { d = JSON.parse(zlib.inflateRawSync(Buffer.from(code.trim().replace(/^MM1/, ''), 'base64url'))) }
      catch { throw new Error('Invalid share code') }
      const idRe = d.t === 'modrinth' ? MR_ID : TS_ID, vRe = d.t === 'modrinth' ? MR_ID : VER
      if (!['thunderstore', 'modrinth'].includes(d.t) || !Array.isArray(d.m) || !d.m.every(e => idRe.test(e?.[0]) && vRe.test(e?.[1])))
        throw new Error('Invalid share code')
      const p = create({ name: name || d.n, type: d.t, game: d.g, mc: d.mc && { version: d.mc.version, loader: d.mc.loader }, icon: d.i, banner: d.b })
      const failed = []
      for (const [id, v] of d.m) await install(p.id, id, v, false).catch(e => failed.push(`${id}: ${e.message}`))
      return { profile: load(p.id), failed }
    },
  }).map(([k, fn]) => [k, parallel.includes(k) ? fn : serial(fn)]))
}
