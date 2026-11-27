// Live share: owner publishes, changes reach followers automatically, only the owner can publish. GitHub gists are faked in memory.
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path')
const gists = {}, realFetch = global.fetch
global.fetch = async (url, init = {}) => {
  const m = String(url).match(/^https:\/\/api\.github\.com\/gists(?:\/(\w+))?$/)
  if (!m) return realFetch(url, init)
  const res = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  if (init.method === 'POST' || init.method === 'PATCH') {
    assert.equal(init.headers.authorization, 'Bearer tok', 'publishing needs the token')
    const id = m[1] || 'g' + (Object.keys(gists).length + 1), b = JSON.parse(init.body)
    gists[id] = { id, owner: { login: 'owner1' }, public: b.public, files: { 'modmanager.json': { content: b.files['modmanager.json'].content } } }
    return res(gists[id])
  }
  return gists[m[1]] ? res(gists[m[1]]) : res({}, 404)
}
const mk = name => { const r = fs.mkdtempSync(path.join(os.tmpdir(), name)); return require('./core')(path.join(r, 'profiles'), { emit: (e, d) => e === 'published' && published.push(d.pid) }) }
const published = [], owner = mk('own'), friend = mk('fr')
const wait = async (cond, ms = 15000) => { for (const end = Date.now() + ms; !cond();) { if (Date.now() > end) throw new Error('timeout'); await new Promise(r => setTimeout(r, 100)) } }

;(async () => {
  await owner.setSettings({ githubToken: 'tok' })
  let p = await owner.createProfile({ name: 'SMP', type: 'modrinth', mc: { version: '1.21.1', loader: 'fabric' } })
  p = await owner.install(p.id, 'modrinth', 'P7dR8mSH') // Fabric API
  p = await owner.publish(p.id)
  assert(p.publish && gists[p.publish].public && p.publishUser === 'owner1', 'published as public gist')

  let f = (await friend.follow(p.publish)).profile
  assert.equal(f.follow.owner, 'owner1')
  assert.equal((await friend.checkFollow(f.id)).changed, false)
  await assert.rejects(friend.publish(f.id), /Only owner1 can update/)

  // Owner adds a mod: auto-published, follower sees the change and syncs.
  await owner.install(p.id, 'modrinth', 'AANobbMI') // Sodium
  await wait(() => published.includes(p.id))
  const c = await friend.checkFollow(f.id)
  assert(c.changed && c.diff.add.length === 1, 'follower sees the new mod')
  f = (await friend.sync(f.id, `gist:${f.follow.gist}`, { remove: true })).profile
  assert.equal((await friend.checkFollow(f.id)).changed, false, 'synced')
  assert.deepEqual(f.mods.map(m => m.id).sort(), (await owner.listProfiles())[0].mods.map(m => m.id).sort())

  // Follower edits locally: not reported as an owner update; unfollow keeps the edit.
  f = await friend.uninstall(f.id, 'AANobbMI')
  const l = await friend.checkFollow(f.id)
  assert(!l.changed && l.diff.add.length === 1, 'local change, not an owner update')
  f = await friend.unfollow(f.id)
  assert(!f.follow && !f.mods.some(m => m.id === 'AANobbMI'))
  console.log('ok live share')
  process.exit(0)
})().catch(e => { console.error(e); process.exit(1) })
