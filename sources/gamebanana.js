const { json, bytes, q, write, extract } = require('../lib')
const GB = 'https://gamebanana.com/apiv11'
const SORT = { popular: 'Generic_MostDownloaded', updated: 'Generic_LatestModified', newest: 'Generic_Newest' }
const img = m => { const i = m._aPreviewMedia?._aImages?.[0]; return i && `${i._sBaseUrl}/${i._sFile220 || i._sFile}` }
const card = m => ({ id: String(m._idRow), title: m._sName, author: m._aSubmitter?._sName, desc: m._aRootCategory?._sName || '', icon: img(m) })

module.exports = ({ files }) => {
  const profile = id => json(`${GB}/Mod/${q(id)}/ProfilePage`)
  const newest = m => [...(m._aFiles || [])].sort((a, b) => b._tsDateAdded - a._tsDateAdded)

  return {
    games: async text => text?.length > 1 ? (await json(`${GB}/Util/Game/NameMatch?_sName=${q(text)}`))._aRecords
      .map(g => ({ id: String(g._idRow), name: g._sName, icon: g._sIconUrl, cover: g._sBannerUrl, banner: g._sBannerUrl, wide: true })) : [],

    search: async (p, text, page, { sort }) => {
      const r = text
        ? await json(`${GB}/Util/Search/Results?_sModelName=Mod&_sOrder=best_match&_idGameRow=${q(p.game)}&_sSearchString=${q(text)}&_nPage=${page}`)
        : await json(`${GB}/Mod/Index?_nPage=${page}&_nPerpage=20&_aFilters%5BGeneric_Game%5D=${q(p.game)}&_sSort=${SORT[sort] || SORT.popular}`)
      return { pages: Math.ceil(r._aMetadata._nRecordCount / (r._aMetadata._nPerpage || 20)), items: r._aRecords.map(card) }
    },

    async install(p, id, vid) {
      const m = await profile(id)
      const f = vid ? m._aFiles?.find(f => String(f._idRow) === String(vid)) : newest(m)[0]
      if (!f) throw new Error(`${m._sName} has no downloadable files`)
      const out = []
      for (const [rel, d] of Object.entries(await extract(f._sFile, await bytes(f._sDownloadUrl)))) write(files(p), rel, d), out.push(rel)
      return { mod: { id: String(id), name: m._sName, version: f._sVersion || m._sVersion || f._sFile, vid: String(f._idRow), icon: img(m), files: out }, deps: [] }
    },

    latest: async (p, mod) => { const m = await profile(mod.id), f = newest(m)[0]; return f && { version: f._sVersion || m._sVersion || f._sFile, vid: String(f._idRow) } },

    async details(p, id) {
      const m = await profile(id)
      return {
        title: m._sName, author: m._aSubmitter?._sName, icon: img(m), summary: m._sDescription, body: m._sText, format: 'html',
        gallery: (m._aPreviewMedia?._aImages || []).map(i => `${i._sBaseUrl}/${i._sFile530 || i._sFile}`), website: m._sProfileUrl,
        versions: newest(m).map(f => ({ vid: String(f._idRow), name: f._sFile + (f._sDescription ? ` — ${f._sDescription}` : ''), date: new Date(f._tsDateAdded * 1000).toISOString(), downloads: f._nDownloadCount })),
      }
    },

    url: (p, id) => `https://gamebanana.com/mods/${id}`,
  }
}
