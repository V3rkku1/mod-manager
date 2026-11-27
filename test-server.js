// Starts a real Fabric 1.21.1 server with server-side mods only, pings it directly and through a local fake bore tunnel. Run: npm run test:server
const assert = require('assert'), fs = require('fs'), path = require('path'), net = require('net'), os = require('os')
const tunnel = require('./tunnel')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mm3-')), events = []
const core = require('./core')(path.join(tmp, 'profiles'), { emit: (e, d) => events.push([e, d]) })
// Fake bore server: control on 7835 (localhost), public port 40123.
function fakeBore() {
  const pending = new Map()
  net.createServer(c => tunnel.frames(c, (m, rest) => {
    if (m.Hello === 0) {
      tunnel.send(c, { Hello: 40123 })
      net.createServer(pub => { const id = 'id' + Math.random(); pending.set(id, pub); pub.pause(); tunnel.send(c, { Connection: id }) }).listen(40123)
    }
    if (m.Accept) { const pub = pending.get(m.Accept); if (rest.length) pub.write(rest); c.pipe(pub); pub.pipe(c); pub.resume(); return false }
  })).listen(7835)
}
// Minecraft server list ping (handshake + status request), returns JSON status.
const ping = (host, port) => new Promise((ok, fail) => {
  const varint = n => { const b = []; do { let x = n & 127; n >>>= 7; if (n) x |= 128; b.push(x) } while (n); return Buffer.from(b) }
  const pkt = d => Buffer.concat([varint(d.length), d])
  const s = net.connect(port, host, () => {
    const h = Buffer.from(host)
    s.write(pkt(Buffer.concat([varint(0), varint(767), varint(h.length), h, Buffer.from([port >> 8, port & 255]), varint(1)])))
    s.write(pkt(Buffer.from([0])))
  })
  let buf = Buffer.alloc(0)
  s.on('data', d => { buf = Buffer.concat([buf, d]); const t = buf.toString(); const i = t.indexOf('{'); if (i >= 0 && t.trim().endsWith('}')) { s.end(); ok(JSON.parse(t.slice(i, t.lastIndexOf('}') + 1))) } })
  s.on('error', fail); setTimeout(() => fail(new Error('ping timeout')), 15000)
})
;(async () => {
  fakeBore()
  let p = await core.createProfile({ name: 'Srv', type: 'modrinth', mc: { version: '1.21.1', loader: 'fabric' } })
  p = await core.install(p.id, 'modrinth', 'mOgUt4GM')   // Mod Menu (client-only) + fabric-api
  p = await core.install(p.id, 'modrinth', 'gvQqBUqZ')   // Lithium (both sides)
  await assert.rejects(core.serverStart(p.id, {}), /EULA/)
  await core.serverStart(p.id, { eula: true, maxMem: 2048, port: 25599 })
  for (let i = 0; i < 180 && !(await core.serverStatus(p.id)).online; i++) await new Promise(r => setTimeout(r, 1000))
  const st = await core.serverStatus(p.id)
  assert(st.online, 'server online: ' + st.log.slice(-5).join('\n'))
  const mods = fs.readdirSync(path.join(tmp, 'profiles', p.id, 'server', 'mods'))
  assert(mods.some(f => /lithium/i.test(f)) && !mods.some(f => /modmenu/i.test(f)), 'server-side mods only: ' + mods)
  const local = await ping('127.0.0.1', 25599)
  // Tunnel through fake bore (host override)
  const t = await tunnel.open(25599, { host: '127.0.0.1' })
  const remote = await ping('127.0.0.1', t.port)
  assert.strictEqual(remote.version.name, local.version.name, 'ping via tunnel')
  t.close()
  core.serverCmd(p.id, 'say hello')
  await new Promise(r => setTimeout(r, 1500))
  assert((await core.serverStatus(p.id)).log.some(l => l.includes('hello')), 'console command')
  core.serverStop(p.id)
  for (let i = 0; i < 30 && (await core.serverStatus(p.id)).running; i++) await new Promise(r => setTimeout(r, 1000))
  assert(!(await core.serverStatus(p.id)).running, 'stopped')
  console.log('ok', local.version.name, 'players max', local.players.max)
  process.exit(0)
})().catch(e => { console.error(e); process.exit(1) })
