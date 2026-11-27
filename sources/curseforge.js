const path = require('path')
const { json, bytes, q, write, extract } = require('../lib')
const CF = 'https://api.curseforge.com/v1', MC = 432
const CLASS = { mod: 6, resourcepack: 12, shader: 6552 }, DIRS = { 6: 'mods', 12: 'resourcepacks', 6552: 'shaderpacks' }
const LOADER = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 }
const SORT = { popular: 2, updated: 3, newest: 11 }

module.exports = ({ files, settings }) => {
  const raw = path => {
    const key = settings().curseforgeKey
    if (!key) throw new Error('Add your CurseForge API key in Settings (gear icon) first')
    return json(CF + path, { 'x-api-key': key })
  }
  const api = path => raw(path).then(r => r.data)
  const isMc = p => p.type === 'modrinth'
  const gameId = p => isMc(p) ? MC : p.game
  const fileFilter = p => isMc(p) ? `&gameVersion=${q(p.mc.version)}&modLoaderType=${LOADER[p.mc.loader] || 0}` : ''
  const latestFile = async (p, id, classId) => (await api(`/mods/${q(id)}/files?pageSize=1${classId === 6 ? fileFilter(p) : isMc(p) ? `&gameVersion=${q(p.mc.version)}` : ''}`))[0]

  return {
    games: async () => {
      const all = []
      for (let i = 0; ; i += 50) {
        const page = await api(`/games?index=${i}&pageSize=50`)
        all.push(...page); if (page.length < 50) break
      }
      return all.filter(g => g.id !== MC).map(g => ({ id: String(g.id), name: g.name, icon: g.assets?.iconUrl, cover: g.assets?.tileUrl, wide: true }))
    },

    search: async (p, text, page, { kind = 'mod', sort }) => {
      const mc = isMc(p) ? `&classId=${CLASS[kind] || 6}&gameVersion=${q(p.mc.version)}` + (kind === 'mod' ? `&modLoaderType=${LOADER[p.mc.loader]}` : '') : ''
      const r = await raw(`/mods/search?gameId=${gameId(p)}&searchFilter=${q(text)}&sortField=${SORT[sort] || 2}&sortOrder=desc&index=${(page - 1) * 20}&pageSize=20${mc}`)
      // shortcut: CurseForge caps index+pageSize at 10000.
      return { pages: Math.min(Math.ceil(r.pagination.totalCount / 20), 500), items: r.data.map(m => ({ id: String(m.id), title: m.name, author: m.authors?.[0]?.name, desc: m.summary, icon: m.logo?.thumbnailUrl, downloads: m.downloadCount })) }
    },

    async install(p, id, vid) {
      const m = await api(`/mods/${q(id)}`)
      const f = vid ? await api(`/mods/${q(id)}/files/${q(vid)}`) : await latestFile(p, id, m.classId)
      if (!f) throw new Error(`${m.name} has no file for this game version`)
      if (!f.downloadUrl) throw new Error(`${m.name}: the author blocks downloads outside the CurseForge site. Get it from ${m.links?.websiteUrl}`)
      const data = await bytes(f.downloadUrl), out = []
      if (isMc(p)) {
        const rel = `${DIRS[m.classId] || 'mods'}/${path.basename(f.fileName)}`
        write(files(p), rel, data); out.push(rel)
      } else for (const [rel, d] of Object.entries(await extract(f.fileName, data))) write(files(p), rel, d), out.push(rel)
      return {
        mod: { id: String(m.id), name: m.name, version: f.displayName, vid: String(f.id), icon: m.logo?.thumbnailUrl, files: out },
        deps: f.dependencies.filter(d => d.relationType === 3).map(d => ({ id: String(d.modId) })),
      }
    },

    latest: async (p, mod) => {
      const m = await api(`/mods/${q(mod.id)}`), f = await latestFile(p, mod.id, m.classId)
      return f && { version: f.displayName, vid: String(f.id) }
    },

    async details(p, id) {
      const [m, body] = await Promise.all([api(`/mods/${q(id)}`), api(`/mods/${q(id)}/description`)])
      const list = await api(`/mods/${q(id)}/files?pageSize=50${m.classId === 6 ? fileFilter(p) : ''}`)
      return {
        title: m.name, author: m.authors?.[0]?.name, icon: m.logo?.thumbnailUrl, summary: m.summary, body, format: 'html',
        gallery: (m.screenshots || []).map(s => s.url), website: m.links?.websiteUrl,
        versions: list.map(f => ({ vid: String(f.id), name: f.displayName, date: f.fileDate, downloads: f.downloadCount })),
      }
    },

    changelog: async (p, id, vid) => { const h = await api(`/mods/${q(id)}/files/${q(vid)}/changelog`); return h ? { html: h } : null },
    url: (p, id) => `https://www.curseforge.com/projects/${id}`,
  }
}
