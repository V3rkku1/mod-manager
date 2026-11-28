// Friends, online status and shared groups on public GitHub gists (the Settings GitHub token, gist scope).
// Skipped: an own server. Status and group changes arrive within a couple of minutes instead of instantly.
const { json, get, q } = require('./lib')
const GH = 'https://api.github.com', PRESENCE = 'mm-presence.json', groupFile = id => `mm-group-${id}.json`
const USER = /^[a-z\d][a-z\d-]{0,38}$/i

// Last change wins per key (a mod, a member); ties go to the larger name so every app picks the same entry.
const lww = (...maps) => {
  const o = {}
  for (const m of maps) for (const [k, v] of Object.entries(m || {})) { const c = o[k]; if (!c || v.t > c.t || (v.t === c.t && String(v.by) > String(c.by))) o[k] = v }
  return o
}

module.exports = getToken => {
  const ids = {}, logins = {} // gist ids by "user/file", login by token
  const h = () => {
    const t = getToken()
    if (!t) throw new Error('Add a GitHub token (gist scope) in Settings → Mod sites to use friends and groups')
    return { authorization: `Bearer ${t}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' }
  }
  const me = async () => logins[getToken()] ||= (await json(`${GH}/user`, h())).login
  const key = (u, f) => `${u}/${f}`.toLowerCase()
  // shortcut: looks at a user's newest 100 gists; page through them if someone keeps more.
  const gistId = async (u, f) => ids[key(u, f)] ||= (await json(`${GH}/users/${q(u)}/gists?per_page=100`, h())).find(g => g.files?.[f])?.id
  async function read(u, f) {
    const id = await gistId(u, f); if (!id) return null
    const g = await json(`${GH}/gists/${q(id)}`, h()), file = g.files?.[f]
    if (!file || g.owner?.login?.toLowerCase() !== u.toLowerCase()) return null // only the member's own gist counts
    try { return JSON.parse(file.truncated ? await (await get(file.raw_url)).text() : file.content) } catch { return null }
  }
  async function write(f, data, description) {
    const u = await me(), body = JSON.stringify({ description, public: true, files: { [f]: { content: JSON.stringify(data) } } })
    const id = await gistId(u, f)
    const g = (id && await json(`${GH}/gists/${q(id)}`, h(), { method: 'PATCH', body }).catch(e => e.status === 404 ? null : Promise.reject(e)))
      || await json(`${GH}/gists`, h(), { method: 'POST', body })
    ids[key(u, f)] = g.id
  }
  return {
    me, user: n => json(`${GH}/users/${q(n)}`, h()),
    presence: u => read(u, PRESENCE), setPresence: d => write(PRESENCE, d, 'Mod Manager: online status'),
    group: (u, id) => read(u, groupFile(id)), setGroup: (id, d) => write(groupFile(id), d, `Mod Manager group: ${d.n}`),
  }
}
Object.assign(module.exports, { lww, USER })
