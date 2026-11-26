const { json, bytes, q, write } = require('../lib')
const { unzipSync } = require('fflate')
const TS = 'https://thunderstore.io'
const split = id => { const i = id.lastIndexOf('-'); return [id.slice(0, i), id.slice(i + 1)] }
const pkg = id => { const [ns, name] = split(id); return `${TS}/api/experimental/package/${q(ns)}/${q(name)}/` }
const SORT = { popular: 'most-downloaded', updated: 'last-updated', newest: 'newest', rated: 'top-rated' }

// Map a file in a Thunderstore zip to its place in a BepInEx install (r2modman-style layout).
// shortcut: assumes BepInEx loader layout; MelonLoader/other-loader games need their own routing.
const route = (id, f, isPack) => {
  if (isPack) return /^BepInExPack[^/]*\/./.test(f) ? f.slice(f.indexOf('/') + 1) : null
  const [top, ...rest] = f.split('/'), t = top.toLowerCase()
  if (rest.length && ['plugins', 'patchers', 'core', 'monomod'].includes(t)) return `BepInEx/${t}/${id}/${rest.join('/')}`
  if (rest.length && t === 'config') return `BepInEx/config/${rest.join('/')}`
  if (rest.length && t === 'bepinex') return f
  return `BepInEx/plugins/${id}/${f}`
}

module.exports = ({ files }) => ({
  games: async () => (await json(`${TS}/api/cyberstorm/community/?page_size=1000`)).results
    .filter(c => c.is_listed !== false).sort((a, b) => b.total_download_count - a.total_download_count)
    .map(c => ({ id: c.identifier, name: c.name, icon: c.community_icon_url, cover: c.cover_image_url, banner: c.hero_image_url })),

  // Sections (Mods, Modpacks, Libraries…) and categories this community uses.
  filters: async p => {
    const f = await json(`${TS}/api/cyberstorm/community/${q(p.game)}/filters/`)
    return { sections: f.sections.map(s => ({ id: s.uuid, name: s.name })), categories: f.package_categories.map(c => ({ id: c.id, name: c.name })) }
  },

  search: async (p, text, page, { sort, categories = [], section }) => {
    const cats = categories.filter(c => /^\d+$/.test(c)).map(c => `&included_categories=${c}`).join('')
    const r = await json(`${TS}/api/cyberstorm/listing/${q(p.game)}/?q=${q(text)}&ordering=${SORT[sort] || SORT.popular}&page=${page}&page_size=20${cats}${section ? `&section=${q(section)}` : ''}`)
    return { pages: Math.ceil(r.count / 20), items: r.results.map(m => ({ id: `${m.namespace}-${m.name}`, title: m.name.replace(/_/g, ' '), author: m.namespace, desc: m.description, icon: m.icon_url, downloads: m.download_count,
      tags: m.categories.map(c => c.name) })) }
  },

  async install(p, id, vid) {
    const v = vid ? await json(`${pkg(id)}${q(vid)}/`) : (await json(pkg(id))).latest
    const zip = unzipSync(await bytes(v.download_url))
    const names = Object.keys(zip).map(f => f.replace(/\\/g, '/'))
    const isPack = names.some(f => /^BepInExPack[^/]*\/BepInEx\//.test(f))
    const out = []
    Object.values(zip).forEach((data, n) => {
      const rel = !names[n].endsWith('/') && route(id, names[n], isPack)
      if (rel) write(files(p), rel, data), out.push(rel)
    })
    return {
      mod: { id, name: v.name, version: v.version_number, vid: v.version_number, icon: v.icon, files: out },
      deps: v.dependencies.map(d => ({ id: d.slice(0, d.lastIndexOf('-')), vid: d.slice(d.lastIndexOf('-') + 1) })),
    }
  },

  latest: async (p, m) => { const v = (await json(pkg(m.id))).latest; return { version: v.version_number, vid: v.version_number } },

  async details(p, id) {
    const [ns, name] = split(id)
    const [info, versions] = await Promise.all([json(pkg(id)), json(`${TS}/api/cyberstorm/package/${q(ns)}/${q(name)}/versions/`)])
    const readme = await json(`${pkg(id)}${q(info.latest.version_number)}/readme/`).catch(() => ({ markdown: info.latest.description }))
    return {
      title: info.name.replace(/_/g, ' '), author: info.owner, icon: info.latest.icon, summary: info.latest.description,
      body: readme.markdown, format: 'md', gallery: [], website: info.latest.website_url,
      versions: versions.sort((a, b) => b.datetime_created.localeCompare(a.datetime_created))
        .map(v => ({ vid: v.version_number, name: v.version_number, date: v.datetime_created, downloads: v.download_count })),
    }
  },

  url: (p, id) => { const [ns, name] = split(id); return `${TS}/c/${p.game}/p/${ns}/${name}/` },
})
