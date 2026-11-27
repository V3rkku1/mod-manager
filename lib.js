// Shared helpers: HTTP, safe paths, archive extraction. Skipped: retry/backoff.
const fs = require('fs'), path = require('path')
const { unzipSync } = require('fflate')

const UA = 'mod-manager/0.4'
async function get(url, headers = {}, init = {}) {
  const r = await fetch(url, { ...init, headers: { 'User-Agent': UA, ...headers } })
  if (!r.ok) {
    const e = new Error(`HTTP ${r.status} for ${url.split('?')[0]}`)
    e.status = r.status
    throw e
  }
  return r
}
const json = (url, headers, init) => get(url, headers, init).then(r => r.json())
// Downloads over 256 KB report progress to the hook (download queue UI).
const progress = { hook: null }
let dlId = 0
const bytes = async (url, headers) => {
  const r = await get(url, headers), total = +r.headers.get('content-length') || 0
  if (!progress.hook || total < 256e3) return new Uint8Array(await r.arrayBuffer())
  const id = ++dlId, name = decodeURIComponent(url.split('?')[0].split('/').filter(Boolean).pop() || 'download'), start = Date.now(), chunks = []
  let got = 0, last = 0
  for await (const c of r.body) {
    chunks.push(c); got += c.length
    if (Date.now() - last > 250) last = Date.now(), progress.hook({ id, name, got, total, speed: got / ((Date.now() - start) / 1000 || 1) })
  }
  progress.hook({ id, name, got, total, done: true })
  return new Uint8Array(Buffer.concat(chunks))
}
const q = s => encodeURIComponent(typeof s === 'string' ? s : JSON.stringify(s))

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
// All files under dir as forward-slash relative paths.
const walk = dir => fs.existsSync(dir)
  ? fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter(d => d.isFile())
    .map(d => path.relative(dir, path.join(d.parentPath ?? d.path, d.name)).split(path.sep).join('/'))
  : []

const isZip = b => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04
const is7z = b => b[0] === 0x37 && b[1] === 0x7a && b[2] === 0xbc && b[3] === 0xaf
const isRar = b => b[0] === 0x52 && b[1] === 0x61 && b[2] === 0x72 && b[3] === 0x21

// Returns { 'rel/path': Uint8Array } for zip/7z/rar, or { name: data } for a plain file.
// Only .zip/.7z/.rar are unpacked: .jar/.ts4script are zips that must stay whole.
async function extract(name, data) {
  const archive = /\.(zip|7z|rar)$/i.test(name)
  if (archive && isZip(data)) {
    const out = {}
    for (const [f, d] of Object.entries(unzipSync(data))) if (!f.endsWith('/')) out[f.replace(/\\/g, '/')] = d
    return out
  }
  if (archive && (is7z(data) || isRar(data))) {
    const sz = await require('7z-wasm')({ print: () => {}, printErr: () => {} }) // fresh instance per archive = free MEMFS cleanup
    sz.FS.writeFile('/a', data)
    sz.FS.mkdir('/o')
    sz.callMain(['x', '/a', '-o/o', '-y'])
    const out = {}
    const rec = d => sz.FS.readdir(d).filter(n => n !== '.' && n !== '..').forEach(n => {
      const p = `${d}/${n}`
      sz.FS.isDir(sz.FS.stat(p).mode) ? rec(p) : out[p.slice(3)] = sz.FS.readFile(p)
    })
    rec('/o')
    if (!Object.keys(out).length) throw new Error(`Could not extract ${name}`)
    return out
  }
  return { [path.basename(name)]: data }
}

module.exports = { progress, get, json, bytes, q, inside, write, remove, walk, extract }
