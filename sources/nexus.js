const { json, bytes, q, write, extract } = require('../lib')
const GQL = 'https://api.nexusmods.com/v2/graphql', V1 = 'https://api.nexusmods.com/v1'
const SORT = { popular: 'endorsements', updated: 'updatedAt', newest: 'createdAt' }
const gql = (query, variables) => json(GQL, { 'content-type': 'application/json' }, { method: 'POST', body: JSON.stringify({ query, variables }) })
  .then(r => { if (r.errors) throw new Error(r.errors[0].message); return r.data })

module.exports = ({ files, settings }) => {
  const key = () => {
    const k = settings().nexusKey
    if (!k) throw new Error('Add your Nexus Mods API key in Settings (gear icon) first')
    return k
  }
  const modFiles = async (p, id) => (await gql('query($m:ID!,$g:ID!){modFiles(modId:$m,gameId:$g){fileId name version category date uri}}', { m: id, g: p.gameId })).modFiles
    .sort((a, b) => b.date - a.date)
  const mainFile = async (p, id) => { const l = await modFiles(p, id); return l.find(f => f.category === 'MAIN') || l[0] }

  return {
    games: async text => (text
      ? await gql('query($f:GamesSearchFilter){games(filter:$f,count:60,sort:[{downloads:{direction:DESC}}]){nodes{id name domainName}}}', { f: { name: [{ value: text, op: 'WILDCARD' }] } })
      : await gql('{games(count:60,sort:[{downloads:{direction:DESC}}]){nodes{id name domainName}}}')).games.nodes
      .map(g => ({ id: g.domainName, gameId: g.id, name: g.name, cover: `https://staticdelivery.nexusmods.com/Images/games/4_3/tile_${g.id}.jpg` })),

    search: async (p, text, page, { sort }) => {
      const filter = { gameDomainName: [{ value: p.game, op: 'EQUALS' }], ...(text ? { name: [{ value: text, op: 'WILDCARD' }] } : {}) }
      const r = await gql('query($f:ModsFilter,$s:[ModsSort!],$o:Int){mods(filter:$f,sort:$s,count:20,offset:$o){nodes{modId name summary author thumbnailUrl downloads}}}',
        { f: filter, s: [{ [SORT[sort] || SORT.popular]: { direction: 'DESC' } }], o: (page - 1) * 20 })
      return r.mods.nodes.map(m => ({ id: String(m.modId), title: m.name, author: m.author, desc: m.summary, icon: m.thumbnailUrl, downloads: m.downloads }))
    },

    // nxm = { key, expires } from a "Mod Manager Download" link; without it only Premium accounts get a link.
    async install(p, id, vid, nxm) {
      const apikey = key()
      const f = vid ? (await modFiles(p, id)).find(f => String(f.fileId) === String(vid)) : await mainFile(p, id)
      if (!f) throw new Error('Nexus file not found')
      const auth = nxm ? `?key=${q(nxm.key)}&expires=${q(nxm.expires)}` : ''
      let links
      try { links = await json(`${V1}/games/${q(p.game)}/mods/${q(id)}/files/${f.fileId}/download_link.json${auth}`, { apikey }) }
      catch (e) {
        if (e.status === 403) { const err = new Error('Free Nexus account: click "Mod Manager Download" on the mod page opened in your browser'); err.open = `https://www.nexusmods.com/${p.game}/mods/${id}?tab=files&file_id=${f.fileId}&nmm=1`; throw err }
        throw e
      }
      const info = (await gql('query($m:ID!,$g:ID!){mod(modId:$m,gameId:$g){name pictureUrl}}', { m: id, g: p.gameId })).mod
      const out = []
      for (const [rel, d] of Object.entries(await extract(f.uri, await bytes(links[0].URI)))) write(files(p), rel, d), out.push(rel)
      return { mod: { id: String(id), name: info.name, version: f.version || f.name, vid: String(f.fileId), icon: info.pictureUrl, files: out }, deps: [] }
    },

    latest: async (p, m) => { const f = await mainFile(p, m.id); return f && { version: f.version || f.name, vid: String(f.fileId) } },

    async details(p, id) {
      const [{ mod }, list] = await Promise.all([
        gql('query($m:ID!,$g:ID!){mod(modId:$m,gameId:$g){name author summary description pictureUrl}}', { m: id, g: p.gameId }),
        modFiles(p, id)])
      return {
        title: mod.name, author: mod.author, icon: mod.pictureUrl, summary: mod.summary, body: mod.description, format: 'bbcode',
        gallery: [mod.pictureUrl].filter(Boolean), website: `https://www.nexusmods.com/${p.game}/mods/${id}`,
        versions: list.map(f => ({ vid: String(f.fileId), name: f.version && !f.name.includes(f.version) ? `${f.name} ${f.version}` : f.name, date: new Date(f.date * 1000).toISOString(), tag: f.category })),
      }
    },

    url: (p, id) => `https://www.nexusmods.com/${p.game}/mods/${id}`,
  }
}
