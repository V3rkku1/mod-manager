// Unit check of the playit.gg API flow against a mocked API (no account or network needed). Run: node test-playit.js
const assert = require('assert')
const calls = []
let allocated = false
global.fetch = async (url, init) => {
  const route = url.replace('https://api.playit.gg', ''), body = JSON.parse(init.body)
  calls.push({ route, body, auth: init.headers.authorization })
  const ok = data => ({ status: 200, json: async () => ({ status: 'success', data }) })
  if (route === '/agents/rundata') return ok({ agent_id: 'agent-1' })
  if (route === '/tunnels/list') {
    const t = { id: 't1', name: 'mm-x', origin: { type: 'agent', data: { agent_id: 'agent-1', local_port: 25565 } },
      alloc: allocated ? { status: 'allocated', data: { assigned_domain: 'cool-name.joinmc.link', ip_hostname: '147.185.221.1', port_start: 41234 } } : { status: 'pending' } }
    allocated = true
    return ok({ tunnels: calls.some(c => c.route === '/tunnels/create') || body.tunnel_id ? [t] : [] })
  }
  if (route === '/tunnels/create') return ok({ id: 't1' })
  if (route === '/claim/setup') return ok(calls.filter(c => c.route === '/claim/setup').length > 1 ? 'UserAccepted' : 'WaitingForUser')
  if (route === '/claim/exchange') return ok({ secret_key: 'sek' })
  return { status: 404, json: async () => ({ status: 'error', data: { type: 'path-not-found', message: route } }) }
}
const pit = require('./playit')(require('os').tmpdir())
;(async () => {
  const c = await pit.claimStart()
  assert(/^[0-9a-f]{10}$/.test(c.code) && c.url.endsWith(c.code), 'claim code + url')
  assert.strictEqual(await pit.claimFinish(c.code, 10000), 'sek', 'exchange after approval')
  const addr = await pit.tunnel('sek', { name: 'mm-x', localPort: 25565, kind: 'java' })
  assert.strictEqual(addr, 'cool-name.joinmc.link', 'java uses domain (SRV)')
  const create = calls.find(c => c.route === '/tunnels/create')
  assert.deepStrictEqual(create.body.origin, { type: 'agent', data: { agent_id: 'agent-1', local_ip: '127.0.0.1', local_port: 25565 } })
  assert.strictEqual(create.body.tunnel_type, 'minecraft-java'); assert.strictEqual(create.body.port_type, 'tcp')
  assert(calls.filter(c => c.route !== '/claim/setup' && c.route !== '/claim/exchange').every(c => c.auth === 'Agent-Key sek'), 'auth header')
  calls.length = 0; allocated = true
  const b = await pit.tunnel('sek', { name: 'mm-x', localPort: 25565, kind: 'bedrock' })
  assert.strictEqual(b, '147.185.221.1:41234', 'udp uses ip:port')
  console.log('ok playit flow')
})().catch(e => { console.error(e); process.exit(1) })
