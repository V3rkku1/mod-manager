const path = require('path')
const { json, bytes, q, write } = require('../lib')
const { unzipSync } = require('fflate')
const MR = 'https://api.modrinth.com/v2'
const DIRS = { mod: 'mods', resourcepack: 'resourcepacks', shader: 'shaderpacks' }
const SORT = { popular: 'downloads', updated: 'updated', newest: 'newest' }
// .mrpack spec only allows these download hosts.
const PACK_HOSTS = /^https:\/\/(cdn\.modrinth\.com|github\.com|raw\.githubusercontent\.com|gitlab\.com)\//

const filter = (p, type) => `game_versions=${q([p.mc.version])}` + ((type === 'mod' || type === 'modpack') && p.mc.loader !== 'vanilla' ? `&loaders=${q([p.mc.loader])}` : '')

module.exports = ({ files, settings }) => {
  const latest = (p, id, type) => json(`${MR}/project/${q(id)}/version?${filter(p, type)}`).then(r => r[0])

  async function installPack(p, proj, v) {
    const f = v.files.find(f => f.primary) || v.files[0]
    return installPackData(p, unzipSync(await bytes(f.url)), { id: proj.id, name: proj.title, version: v.version_number, vid: v.id, icon: proj.icon_url })
  }
  // Installs an unpacked .mrpack (from Modrinth or a local file) as one mod entry.
  async function installPackData(p, zip, meta) {
    if (!zip['modrinth.index.json']) throw new Error('Not a Modrinth modpack (.mrpack)')
    const index = JSON.parse(new TextDecoder().decode(zip['modrinth.index.json']))
    const out = []
    const todo = index.files.filter(f => f.env?.client !== 'unsupported')
    for (let i = 0; i < todo.length; i += 8) await Promise.all(todo.slice(i, i + 8).map(async f => {
      const url = f.downloads.find(u => PACK_HOSTS.test(u))
      if (!url) throw new Error(`Modpack file from untrusted host: ${f.path}`)
      write(files(p), f.path, await bytes(url)); out.push(f.path)
    }))
    for (const [name, data] of Object.entries(zip)) {
      const m = name.match(/^(client-)?overrides\/(.+[^/])$/)
      if (m) write(files(p), m[2], data), out.push(m[2])
    }
    const mc = index.dependencies.minecraft, loader = Object.entries(index.dependencies).find(([k]) => k !== 'minecraft')
    return {
      mod: { ...meta, name: meta.name || index.name, files: [...new Set(out)], pack: true },
      deps: [],
      warn: `Modpack needs Minecraft ${mc}${loader ? ` with ${loader[0]} ${loader[1]}` : ''} in your launcher`,
    }
  }

  return {
    installPackData,
    search: async (p, text, page, { kind = 'mod', sort, category, env }) => {
      if (kind === 'following') {
        const token = settings().modrinthToken
        if (!token) throw new Error('Add your Modrinth token in Settings to see followed projects')
        const me = await json(`${MR}/user`, { authorization: token })
        const list = await json(`${MR}/user/${me.id}/follows`, { authorization: token })
        return list.filter(m => !text || m.title.toLowerCase().includes(text.toLowerCase())).slice((page - 1) * 20, page * 20)
          .map(m => ({ id: m.id, title: m.title, author: '', desc: m.description, icon: m.icon_url, downloads: m.downloads }))
      }
      const loaderFacet = (kind === 'mod' || kind === 'modpack') && p.mc.loader !== 'vanilla' ? [[`categories:${p.mc.loader}`]] : []
      const envFacet = env === 'client' ? [['client_side:required', 'client_side:optional']] : env === 'server' ? [['server_side:required', 'server_side:optional']] : []
      const facets = [[`project_type:${kind}`], [`versions:${p.mc.version}`], ...loaderFacet, ...(category ? [[`categories:${category}`]] : []), ...envFacet]
      const index = (!sort || sort === 'popular') && text ? 'relevance' : SORT[sort] || SORT.popular
      const r = await json(`${MR}/search?query=${q(text)}&facets=${q(facets)}&index=${index}&limit=20&offset=${(page - 1) * 20}`)
      return r.hits.map(m => ({ id: m.project_id, title: m.title, author: m.author, desc: m.description, icon: m.icon_url, downloads: m.downloads }))
    },

    async install(p, id, vid) {
      const proj = await json(`${MR}/project/${q(id)}`)
      const v = vid ? await json(`${MR}/version/${q(vid)}`) : await latest(p, id, proj.project_type)
      if (!v) throw new Error(`${proj.title} has no version for ${p.mc.loader} ${p.mc.version}`)
      if (proj.project_type === 'modpack') return installPack(p, proj, v)
      const dir = DIRS[proj.project_type]
      if (!dir) throw new Error(`Unsupported project type: ${proj.project_type}`)
      const f = v.files.find(f => f.primary) || v.files[0]
      const rel = `${dir}/${path.basename(f.filename)}`
      write(files(p), rel, await bytes(f.url))
      return {
        mod: { id: proj.id, name: proj.title, version: v.version_number, vid: v.id, icon: proj.icon_url, files: [rel] },
        deps: v.dependencies.filter(d => d.dependency_type === 'required' && d.project_id).map(d => ({ id: d.project_id })),
      }
    },

    latest: async (p, m) => {
      const type = m.pack ? 'modpack' : Object.keys(DIRS).find(k => m.files[0].startsWith(DIRS[k] + '/')) || 'mod'
      const v = await latest(p, m.id, type)
      return v && { version: v.version_number, vid: v.id }
    },

    async details(p, id) {
      const proj = await json(`${MR}/project/${q(id)}`)
      const versions = await json(`${MR}/project/${q(id)}/version?${filter(p, proj.project_type)}`)
      return {
        title: proj.title, author: '', icon: proj.icon_url, summary: proj.description, body: proj.body, format: 'md',
        gallery: proj.gallery.map(g => g.url), website: proj.source_url || proj.wiki_url,
        versions: versions.map(v => ({ vid: v.id, name: v.version_number, date: v.date_published, downloads: v.downloads })),
      }
    },

    categories: async kind => (await json(`${MR}/tag/category`)).filter(c => c.project_type === kind && c.header === 'categories').map(c => c.name).sort(),
    url: (p, id) => `https://modrinth.com/project/${id}`,
  }
}
