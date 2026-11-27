// Minecraft launcher: Mojang manifests + Java runtimes, Fabric/Quilt profiles, Forge/NeoForge installers.
// Skipped: legacy (<1.7) virtual assets, Forge <1.13 and NeoForge for 1.20.1 (different artifacts), log4j XML configs.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib')
const { spawn, execFileSync } = require('child_process')
const { unzipSync } = require('fflate')
const { json, bytes, walk } = require('./lib')

const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
const RUNTIMES = 'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json'
const OS = { win32: 'windows', darwin: 'osx', linux: 'linux' }[process.platform]
const ARCH = process.arch === 'ia32' ? 'x86' : process.arch
const RT_PLATFORM = { win32: process.arch === 'arm64' ? 'windows-arm64' : 'windows-x64', darwin: process.arch === 'arm64' ? 'mac-os-arm64' : 'mac-os', linux: 'linux' }[process.platform]
const sha1 = f => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex')
const mavenPath = name => {
  const [g, a, v, c] = name.split('@')[0].split(':'), ext = name.includes('@') ? name.split('@')[1] : 'jar'
  return `${g.replace(/\./g, '/')}/${a}/${v}/${a}-${v}${c ? '-' + c : ''}.${ext}`
}
const matchRule = (r, feat) => (!r.os || ((!r.os.name || r.os.name === OS) && (!r.os.arch || r.os.arch === ARCH)))
  && Object.entries(r.features || {}).every(([k, v]) => !!feat[k] === v)
const allowed = (rules, feat = {}) => !rules || rules.reduce((ok, r) => matchRule(r, feat) ? r.action === 'allow' : ok, false)

async function pool(items, n, fn) {
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]) }))
}

module.exports = base => {
  const dirs = { lib: path.join(base, 'libraries'), assets: path.join(base, 'assets'), ver: path.join(base, 'versions'), rt: path.join(base, 'runtime') }
  const verJson = id => path.join(dirs.ver, id, `${id}.json`)
  let manifest

  const inflight = new Map()
  function download(url, file, hash, force, size) {
    if (fs.existsSync(file) && !(size && fs.statSync(file).size !== size) && !(force && hash && sha1(file) !== hash)) return
    if (inflight.has(file)) return inflight.get(file)
    const job = (async () => {
      const data = await bytes(url)
      if (hash && crypto.createHash('sha1').update(data).digest('hex') !== hash) throw new Error(`Checksum mismatch: ${path.basename(file)}`)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const part = `${file}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.part`
      fs.writeFileSync(part, data); fs.renameSync(part, file)
    })().finally(() => inflight.delete(file))
    inflight.set(file, job)
    return job
  }

  const versions = async () => (manifest ??= await json(MANIFEST)).versions

  async function vanilla(id) {
    if (!fs.existsSync(verJson(id))) {
      const v = (await versions()).find(v => v.id === id)
      if (!v) throw new Error(`Unknown Minecraft version ${id}`)
      fs.mkdirSync(path.dirname(verJson(id)), { recursive: true })
      fs.writeFileSync(verJson(id), JSON.stringify(await json(v.url)))
    }
    return id
  }

  // Newest stable loader version for a Minecraft version.
  async function latestLoader(mc, loader) {
    if (loader === 'fabric' || loader === 'quilt') {
      const meta = loader === 'fabric' ? 'https://meta.fabricmc.net/v2' : 'https://meta.quiltmc.org/v3'
      return (await json(`${meta}/versions/loader/${mc}`)).map(l => l.loader).find(l => l.stable !== false && !/beta|pre|rc/i.test(l.version))?.version
    }
    if (loader === 'forge') return (p => p[`${mc}-recommended`] || p[`${mc}-latest`])((await json('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json')).promos)
    if (loader === 'neoforge') {
      const prefix = mc.split('.').slice(1).join('.').replace(/^(\d+)$/, '$1.0') + '.'
      return (await json('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge')).versions.filter(v => v.startsWith(prefix) && !v.includes('beta')).at(-1)
    }
  }

  // Installs the loader if needed and returns the version id to launch.
  async function installLoader(mc, loader, loaderVersion, log) {
    await vanilla(mc)
    if (loader === 'vanilla' || !loader) return { id: mc }
    if (loader === 'fabric' || loader === 'quilt') {
      const meta = loader === 'fabric' ? 'https://meta.fabricmc.net/v2' : 'https://meta.quiltmc.org/v3'
      const lv = loaderVersion || await latestLoader(mc, loader)
      if (!lv) throw new Error(`${loader} has no loader for ${mc}`)
      const cached = `${loader}-loader-${lv}-${mc}`
      if (fs.existsSync(verJson(cached))) return { id: cached, loaderVersion: lv } // repeat launch: no network
      const profile = await json(`${meta}/versions/loader/${mc}/${lv}/profile/json`)
      fs.mkdirSync(path.dirname(verJson(profile.id)), { recursive: true })
      fs.writeFileSync(verJson(profile.id), JSON.stringify(profile))
      return { id: profile.id, loaderVersion: lv }
    }
    const lv = loaderVersion || await latestLoader(mc, loader)
    let url
    if (loader === 'forge') {
      url = `https://maven.minecraftforge.net/net/minecraftforge/forge/${mc}-${lv}/forge-${mc}-${lv}-installer.jar`
    } else if (loader === 'neoforge') {
      url = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${lv}/neoforge-${lv}-installer.jar`
    } else throw new Error(`Unknown loader ${loader}`)
    if (!lv) throw new Error(`${loader} has no version for Minecraft ${mc}`)
    const installer = path.join(base, 'installers', path.basename(url))
    await download(url, installer)
    const id = JSON.parse(new TextDecoder().decode(unzipSync(fs.readFileSync(installer), { filter: f => f.name === 'version.json' })['version.json'])).id
    if (!fs.existsSync(verJson(id))) {
      log?.(`Running ${loader} installer ${lv}…`)
      const java = await runtime((await resolve(mc)).javaVersion)
      const lp = path.join(base, 'launcher_profiles.json')
      if (!fs.existsSync(lp)) fs.writeFileSync(lp, '{"profiles":{}}')
      await new Promise((ok, fail) => {
        const p = spawn(java, ['-jar', installer, '--installClient', base], { cwd: base })
        p.stdout.on('data', d => log?.(String(d).trimEnd())); p.stderr.on('data', d => log?.(String(d).trimEnd()))
        p.on('exit', c => c === 0 && fs.existsSync(verJson(id)) ? ok() : fail(new Error(`${loader} installer failed (exit ${c})`)))
      })
    }
    return { id, loaderVersion: lv }
  }

  // Version JSON with inheritsFrom merged (child libraries/args first).
  async function resolve(id) {
    const v = JSON.parse(fs.readFileSync(verJson(id), 'utf8'))
    if (!v.inheritsFrom) return v
    const parent = await resolve(await vanilla(v.inheritsFrom))
    const key = l => l.name.split(':').slice(0, 2).concat(l.name.split(':')[3] || []).join(':')
    // Loader libraries replace the parent's same library (other version); the parent's own list is kept as is, since it
    // holds per-OS variants (e.g. LWJGL 3.2.1 for macOS + 3.2.2 for others) and separate natives entries.
    const mine = new Set(v.libraries.filter(l => !l.natives).map(key)), libraries = [...v.libraries, ...parent.libraries.filter(l => l.natives || !mine.has(key(l)))]
    return { ...parent, ...v, libraries, jar: parent.jar || parent.id,
      arguments: v.arguments || parent.arguments ? { game: [...parent.arguments?.game || [], ...v.arguments?.game || []], jvm: [...parent.arguments?.jvm || [], ...v.arguments?.jvm || []] } : undefined,
      minecraftArguments: v.minecraftArguments || parent.minecraftArguments }
  }

  // Mojang-provided Java for this version; returns the java executable.
  async function runtime(javaVersion, force, progress, cancelled) {
    const component = javaVersion?.component || 'jre-legacy'
    const dir = path.join(dirs.rt, component), exe = path.join(dir, 'bin', process.platform === 'win32' ? 'javaw.exe' : 'java')
    if (fs.existsSync(exe) && !force) return exe
    const entry = (await json(RUNTIMES))[RT_PLATFORM]?.[component]?.[0]
    if (!entry) throw new Error(`No Java ${component} for this platform`)
    const files = Object.entries((await json(entry.manifest.url)).files).filter(([, f]) => f.type === 'file')
    let done = 0
    await pool(files, 16, async ([rel, f]) => {
      if (cancelled?.()) throw new Error('Stopped')
      const file = path.join(dir, rel)
      await download(f.downloads.raw.url, file, f.downloads.raw.sha1, force, f.downloads.raw.size)
      if (f.executable && process.platform !== 'win32') fs.chmodSync(file, 0o755)
      progress?.(`Java ${++done}/${files.length}`)
    })
    return exe
  }

  // Downloads everything for a version; returns the launch plan.
  async function prepare({ mc, loader, loaderVersion, force, log, progress, cancelled }) {
    const inst = await installLoader(mc, loader, loaderVersion, log)
    const v = await resolve(inst.id)
    const java = await runtime(v.javaVersion, force, progress, cancelled)
    const libs = v.libraries.filter(l => allowed(l.rules))
    const nativesDir = path.join(base, 'natives', inst.id)
    const jobs = [], classpath = [], natives = []
    for (const l of libs) {
      const a = l.downloads?.artifact
      if (a || !l.downloads) {
        const rel = a?.path || mavenPath(l.name), file = path.join(dirs.lib, rel)
        const url = a ? a.url : (l.url || 'https://libraries.minecraft.net/').replace(/\/?$/, '/') + rel
        if (url) jobs.push([url, file, a?.sha1, a?.size])
        if (l.name.includes(':natives-')) natives.push(file)
        if (!classpath.includes(file)) classpath.push(file)
      }
      const cls = l.natives?.[OS]?.replace('${arch}', ARCH === 'x64' ? '64' : '32'), n = cls && l.downloads?.classifiers?.[cls]
      if (n) jobs.push([n.url, path.join(dirs.lib, n.path), n.sha1, n.size]), natives.push(path.join(dirs.lib, n.path))
    }
    const vanillaJar = path.join(dirs.ver, v.jar || v.id, `${v.jar || v.id}.jar`)
    jobs.push([v.downloads.client.url, vanillaJar, v.downloads.client.sha1, v.downloads.client.size])
    const idxFile = path.join(dirs.assets, 'indexes', `${v.assetIndex.id}.json`)
    let index; try { if (!force) index = JSON.parse(fs.readFileSync(idxFile, 'utf8')) } catch {}
    if (!index?.objects) {
      index = await json(v.assetIndex.url)
      fs.mkdirSync(path.dirname(idxFile), { recursive: true }); fs.writeFileSync(idxFile, JSON.stringify(index))
    }
    for (const { hash, size } of Object.values(index.objects))
      jobs.push([`https://resources.download.minecraft.net/${hash.slice(0, 2)}/${hash}`, path.join(dirs.assets, 'objects', hash.slice(0, 2), hash), hash, size])
    let done = 0
    await pool(jobs.filter(j => j[0]), 24, async ([url, file, hash, size]) => {
      if (cancelled?.()) throw new Error('Stopped')
      await download(url, file, hash, force, size); if (++done % 50 === 0) progress?.(`Game files ${done}/${jobs.length}`)
    })
    // Forge expects versions/<id>/<id>.jar to be the client jar.
    const jar = path.join(dirs.ver, inst.id, `${inst.id}.jar`)
    if (!fs.existsSync(jar)) fs.copyFileSync(vanillaJar, jar)
    const fresh = force || !fs.existsSync(nativesDir)
    if (force) try { fs.rmSync(nativesDir, { recursive: true, force: true }) } catch {} // in use by a running game: keep it
    if (fresh) for (const f of natives) for (const [name, data] of Object.entries(unzipSync(fs.readFileSync(f))))
      if (!name.startsWith('META-INF') && !name.endsWith('/') && /\.(dll|so|dylib|jnilib)$/.test(name)) {
        fs.mkdirSync(nativesDir, { recursive: true }); fs.writeFileSync(path.join(nativesDir, path.basename(name)), data)
      }
    return { v, id: inst.id, loaderVersion: inst.loaderVersion, java, classpath: [...classpath, jar], nativesDir }
  }

  // Builds the java command line; account = { name, uuid, token, xuid }.
  function command(plan, { gameDir, account, opts = {}, quickPlay = {} }) {
    const { v } = plan, sep = path.delimiter
    const feat = { has_custom_resolution: !!(opts.width && opts.height), is_quick_play_singleplayer: !!quickPlay.world, is_quick_play_multiplayer: !!quickPlay.server }
    const vars = {
      auth_player_name: account.name, version_name: plan.id, game_directory: gameDir, assets_root: dirs.assets, game_assets: dirs.assets,
      assets_index_name: v.assetIndex.id, auth_uuid: account.uuid, auth_access_token: account.token, auth_session: account.token, clientid: '', auth_xuid: account.xuid || '',
      user_type: 'msa', version_type: v.type, natives_directory: plan.nativesDir, launcher_name: 'mod-manager', launcher_version: '1',
      classpath: plan.classpath.join(sep), classpath_separator: sep, library_directory: dirs.lib, user_properties: '{}',
      resolution_width: opts.width, resolution_height: opts.height, quickPlaySingleplayer: quickPlay.world, quickPlayMultiplayer: quickPlay.server, quickPlayPath: path.join(gameDir, 'quickPlay.json'),
    }
    const sub = s => s.replace(/\$\{(\w+)\}/g, (m, k) => vars[k] ?? m)
    const expand = list => list.flatMap(a => typeof a === 'string' ? [a] : allowed(a.rules, feat) ? [].concat(a.value) : []).map(sub)
    const jvm = v.arguments?.jvm ? expand(v.arguments.jvm) : [`-Djava.library.path=${plan.nativesDir}`, '-cp', vars.classpath]
    let game = v.arguments?.game ? expand(v.arguments.game) : sub(v.minecraftArguments).split(' ')
    if (!v.arguments && feat.has_custom_resolution) game.push('--width', opts.width, '--height', opts.height)
    if (quickPlay.server && !game.includes('--quickPlayMultiplayer')) { const [h, p = '25565'] = quickPlay.server.split(':'); game.push('--server', h, '--port', p) }
    if (opts.fullscreen) game.push('--fullscreen')
    const mem = [`-Xmx${opts.maxMem || 4096}M`, `-Xms${opts.minMem || 512}M`]
    const extra = (opts.jvmArgs || '').split(/\s+/).filter(Boolean)
    return { java: opts.java || plan.java, args: [...mem, '-Dlog4j2.formatMsgNoLookups=true', ...extra, ...jvm, v.mainClass, ...game.map(String)] }
  }

  // Spawns the game; returns the child process.
  function launch(plan, { gameDir, account, opts = {}, quickPlay, onLog, onExit }) {
    fs.mkdirSync(gameDir, { recursive: true })
    const { java, args } = command(plan, { gameDir, account, opts, quickPlay })
    const env = { ...process.env, ...Object.fromEntries((opts.env || '').split('\n').map(l => l.split('=')).filter(([k, v]) => k && v != null).map(([k, ...v]) => [k.trim(), v.join('=')])) }
    if (opts.preLaunch) execFileSync(opts.preLaunch, { cwd: gameDir, env, shell: true, stdio: 'ignore' })
    const [cmd, ...pre] = opts.wrapper ? [...opts.wrapper.split(/\s+/).filter(Boolean), java] : [java]
    const child = spawn(cmd, [...pre, ...args], { cwd: gameDir, env })
    const log = d => String(d).split(/\r?\n/).filter(Boolean).forEach(l => onLog?.(account.token?.length > 16 ? l.replaceAll(account.token, '<token>') : l))
    child.stdout.on('data', log); child.stderr.on('data', log)
    child.on('error', e => onLog?.(`Failed to start: ${e.message}`))
    child.on('exit', code => {
      if (opts.postExit) try { execFileSync(opts.postExit, { cwd: gameDir, env, shell: true, stdio: 'ignore' }) } catch {}
      onExit?.(code)
    })
    return child
  }

  // Dedicated server in dir; returns { java, args } to spawn with cwd = dir.
  async function prepareServer({ mc, loader, loaderVersion, dir, log }) {
    await vanilla(mc)
    const v = await resolve(mc), java = await runtime(v.javaVersion)
    fs.mkdirSync(dir, { recursive: true })
    if (!loader || loader === 'vanilla') {
      await download(v.downloads.server.url, path.join(dir, 'server.jar'), v.downloads.server.sha1)
      return { java, args: ['-jar', 'server.jar', 'nogui'] }
    }
    if (loader === 'paper' || loader === 'purpur') {
      const url = loader === 'paper' ? (await json(`https://fill.papermc.io/v3/projects/paper/versions/${mc}/builds/latest`)).downloads['server:default'].url
        : `https://api.purpurmc.org/v2/purpur/${mc}/latest/download`
      const jar = path.join(dir, `${loader}.jar`), stamp = jar + '.src'
      if (!fs.existsSync(stamp) || fs.readFileSync(stamp, 'utf8') !== url + mc) fs.writeFileSync(jar, await bytes(url)), fs.writeFileSync(stamp, url + mc)
      return { java, args: ['-jar', `${loader}.jar`, 'nogui'] }
    }
    const lv = loaderVersion || await latestLoader(mc, loader)
    if (loader === 'fabric') {
      const iv = (await json('https://meta.fabricmc.net/v2/versions/installer')).find(i => i.stable)?.version
      await download(`https://meta.fabricmc.net/v2/versions/loader/${mc}/${lv}/${iv}/server/jar`, path.join(dir, 'fabric-server-launch.jar'))
      return { java, args: ['-jar', 'fabric-server-launch.jar', 'nogui'] }
    }
    if (loader !== 'forge' && loader !== 'neoforge') throw new Error(`Servers for ${loader} are not supported yet`)
    const argsFile = () => walk(path.join(dir, 'libraries')).find(f => /(net\/minecraftforge\/forge|net\/neoforged\/neoforge)\/.*\/(win|unix)_args\.txt$/.test(f) && f.includes(process.platform === 'win32' ? 'win_args' : 'unix_args') && f.includes(lv))
    if (!argsFile()) {
      const url = loader === 'forge' ? `https://maven.minecraftforge.net/net/minecraftforge/forge/${mc}-${lv}/forge-${mc}-${lv}-installer.jar` : `https://maven.neoforged.net/releases/net/neoforged/neoforge/${lv}/neoforge-${lv}-installer.jar`
      const installer = path.join(base, 'installers', path.basename(url))
      await download(url, installer)
      log?.(`Installing ${loader} server ${lv}…`)
      await new Promise((ok, fail) => {
        const p = spawn(java, ['-jar', installer, '--installServer', dir], { cwd: dir })
        p.stdout.on('data', d => log?.(String(d).trimEnd())); p.stderr.on('data', d => log?.(String(d).trimEnd()))
        p.on('exit', c => c === 0 ? ok() : fail(new Error(`${loader} server installer failed (exit ${c})`)))
      })
    }
    const af = argsFile()
    if (!af) throw new Error(`${loader} server files not found after install`)
    return { java, args: [`@libraries/${af}`, 'nogui'] }
  }

  return { prepareServer, versions, latestLoader, prepare, launch, command, runtime, mavenPath, allowed }
}

// servers.dat is an uncompressed NBT compound; reads just names + IPs.
module.exports.readServers = file => {
  if (!fs.existsSync(file)) return []
  const b = fs.readFileSync(file)
  let o = 0
  const u16 = () => (o += 2, b.readUInt16BE(o - 2)), i32 = () => (o += 4, b.readInt32BE(o - 4)), str = () => { const n = u16(); o += n; return b.toString('utf8', o - n, o) }
  const payload = t => {
    switch (t) {
      case 1: return b[o++]
      case 2: return u16()
      case 3: return i32()
      case 4: o += 8; return 0
      case 5: o += 4; return 0
      case 6: o += 8; return 0
      case 7: { const n = i32(); o += n; return 0 }
      case 8: return str()
      case 9: { const et = b[o++], n = i32(); return Array.from({ length: n }, () => payload(et)) }
      case 10: { const obj = {}; for (let t2; (t2 = b[o++]) !== 0;) { const k = str(); obj[k] = payload(t2) } return obj }
      case 11: { const n = i32(); o += n * 4; return 0 }
      case 12: { const n = i32(); o += n * 8; return 0 }
    }
    throw new Error('Bad NBT')
  }
  try { o = 1; str(); return (payload(10).servers || []).map(s => ({ name: s.name, ip: s.ip })) } catch { return [] }
}
// Gzipped log -> text
module.exports.readLog = file => file.endsWith('.gz') ? zlib.gunzipSync(fs.readFileSync(file)).toString() : fs.readFileSync(file, 'utf8')
// Writes servers.dat (uncompressed NBT) with just name + ip per entry.
module.exports.writeServers = (file, list) => {
  const str = s => { const b = Buffer.from(String(s)), h = Buffer.alloc(2); h.writeUInt16BE(b.length); return Buffer.concat([h, b]) }
  const n = Buffer.alloc(4); n.writeInt32BE(list.length)
  fs.writeFileSync(file, Buffer.concat([Buffer.from([10]), str(''), Buffer.from([9]), str('servers'), Buffer.from([10]), n,
    ...list.flatMap(s => [Buffer.from([8]), str('name'), str(s.name), Buffer.from([8]), str('ip'), str(s.ip), Buffer.from([0])]), Buffer.from([0])]))
}
