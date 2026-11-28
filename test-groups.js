// Shared groups + friends between two users, against an in-memory fake of the GitHub gist API (mods come from Modrinth).
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-grp-'))
const realFetch = global.fetch, gists = {}, users = { 'tok-a': 'alice', 'tok-b': 'bob' }
let n = 0
global.fetch = async (url, init = {}) => {
  if (!url.startsWith('https://api.github.com')) return realFetch(url, init)
  const me = users[(init.headers?.authorization || '').replace('Bearer ', '')], p = new URL(url).pathname, res = (x, status = 200) => new Response(JSON.stringify(x), { status })
  if (p === '/user') return res({ login: me })
  let m
  if ((m = p.match(/^\/users\/([^/]+)\/gists$/))) return res(Object.values(gists).filter(g => g.owner.login === m[1]))
  if ((m = p.match(/^\/users\/([^/]+)$/))) return Object.values(users).includes(m[1]) ? res({ login: m[1] }) : res({}, 404)
  const files = () => Object.fromEntries(Object.entries(JSON.parse(init.body).files).map(([k, v]) => [k, { content: v.content }]))
  if (p === '/gists' && init.method === 'POST') { const g = { id: `g${++n}`, owner: { login: me }, files: files() }; gists[g.id] = g; return res(g, 201) }
  if ((m = p.match(/^\/gists\/(\w+)$/))) {
    const g = gists[m[1]]; if (!g) return res({}, 404)
    if (init.method === 'PATCH') { assert.strictEqual(g.owner.login, me, 'only the owner writes a gist'); g.files = files() }
    return res(g)
  }
  return res({}, 404)
}
const A = require('./core')(path.join(tmp, 'a', 'profiles')), B = require('./core')(path.join(tmp, 'b', 'profiles'))
const ids = c => c.listProfiles()[0].mods.map(m => m.id).sort()
;(async () => {
  await A.setSettings({ githubToken: 'tok-a' }); await B.setSettings({ githubToken: 'tok-b' })
  assert.strictEqual(await B.friendAdd('alice'), 'alice'); await A.friendAdd('bob')
  await assert.rejects(A.friendAdd('nobody-here'))
  let pa = await A.createProfile({ name: 'Our pack', type: 'modrinth', mc: { version: '1.20.1', loader: 'fabric' } })
  await A.install(pa.id, 'modrinth', 'AANobbMI') // Sodium
  const gid = (await A.groupCreate(pa.id)).profile.shared.id
  await A.groupInvite(pa.id, 'bob')
  const fb = await B.friends()
  assert.deepStrictEqual(fb.invites.map(i => [i.from, i.group]), [['alice', gid]], 'bob sees the invite')
  assert(fb.friends[0].online && fb.friends[0].mutual, 'alice online, added bob back')
  const pb = (await B.groupJoin('alice', gid)).profile
  assert.deepStrictEqual(ids(B), ['AANobbMI'], 'bob got the pack')
  assert.strictEqual((await B.friends()).invites.length, 0, 'invite gone after joining')
  // Bob adds Lithium and switches Sodium off; Alice gets both.
  await B.install(pb.id, 'modrinth', 'gvQqBUqZ'); await B.setDisabled(pb.id, 'AANobbMI', true)
  await B.groupSync(pb.id)
  const ra = await A.groupSync(pa.id)
  assert.deepStrictEqual(ids(A), ['AANobbMI', 'gvQqBUqZ'])
  assert(A.listProfiles()[0].mods.find(m => m.id === 'AANobbMI').disabled, 'disable synced')
  assert(ra.changes.length >= 2 && ra.changes.every(c => c.by === 'bob'), 'changes credited to bob')
  // Alice removes Bob's mod (anyone edits everything); Bob loses it.
  await A.uninstall(pa.id, 'gvQqBUqZ'); await A.groupSync(pa.id); await B.groupSync(pb.id)
  assert.deepStrictEqual(ids(B), ['AANobbMI'], 'removal synced')
  // Nothing changed: a sync writes nothing.
  const before = JSON.stringify(gists); await A.groupSync(pa.id); assert.strictEqual(JSON.stringify(gists), before, 'idle sync is read-only')
  // Alice removes Bob from the group: his profile stays, unshared.
  await A.groupKick(pa.id, 'bob'); const rb = await B.groupSync(pb.id)
  assert(rb.left && !B.listProfiles()[0].shared && ids(B).length === 1, 'kicked: profile kept, no longer shared')
  console.log('ok groups')
})().catch(e => { console.error(e); process.exit(1) })
