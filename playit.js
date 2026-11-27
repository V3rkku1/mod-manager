// playit.gg tunnels: account link (claim flow) and tunnel setup via the HTTP API; traffic goes through the official agent binary.
// shortcut: agent pinned to v0.15.26 (supports `--secret <key> start`); newer 2.x agents use a daemon + IPC instead.
const fs = require('fs'), path = require('path'), crypto = require('crypto')
const { spawn } = require('child_process')
const { bytes } = require('./lib')
const API = 'https://api.playit.gg', AGENT = 'v0.15.26'

async function call(route, body, secret) {
  const r = await fetch(API + route, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(secret ? { authorization: `Agent-Key ${secret.trim()}` } : {}) },
    body: JSON.stringify(body),
  })
  if (r.status === 429) throw new Error('playit.gg: too many requests, try again in a minute')
  const j = await r.json().catch(() => ({}))
  if (j.status === 'success') return j.data
  const e = new Error(`playit.gg: ${typeof j.data === 'string' ? j.data : j.data?.message || j.data?.type || `HTTP ${r.status}`}`)
  e.code = typeof j.data === 'string' ? j.data : j.data?.type
  throw e
}

module.exports = dataDir => {
  const dir = path.join(dataDir, 'playit')
  let agent = null

  async function binary() {
    const name = process.platform === 'win32' ? 'playit-windows-x86_64-signed.exe' : process.platform === 'linux' ? 'playit-linux-amd64' : null
    if (!name) throw new Error('playit.gg agent is available for Windows and Linux')
    const exe = path.join(dir, `${AGENT}-${name}`)
    if (!fs.existsSync(exe)) {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(exe, await bytes(`https://github.com/playit-cloud/playit-agent/releases/download/${AGENT}/${name}`))
      if (process.platform !== 'win32') fs.chmodSync(exe, 0o755)
    }
    return exe
  }

  return {
    // Step 1: claim code + URL the user opens to approve this app on their (free) playit.gg account.
    claimStart: async () => {
      const code = crypto.randomBytes(5).toString('hex')
      await call('/claim/setup', { code, agent_type: 'self-managed', version: 'Mod Manager' })
      return { code, url: `https://playit.gg/claim/${code}` }
    },
    // Step 2: wait for approval, then exchange the code for the agent secret.
    claimFinish: async (code, timeoutMs = 600e3) => {
      if (!/^[0-9a-f]{10}$/.test(code)) throw new Error('Bad claim code')
      for (const end = Date.now() + timeoutMs; Date.now() < end;) {
        const st = await call('/claim/setup', { code, agent_type: 'self-managed', version: 'Mod Manager' })
        if (st === 'UserRejected') throw new Error('The link was rejected on playit.gg')
        if (st === 'UserAccepted') return (await call('/claim/exchange', { code })).secret_key
        await new Promise(r => setTimeout(r, 2000))
      }
      throw new Error('Timed out waiting for playit.gg approval')
    },

    // Makes sure a tunnel named `name` points at localPort; returns its public address once allocated.
    tunnel: async (secret, { name, localPort, kind = 'java' }) => {
      const run = await call('/agents/rundata', {}, secret)
      const type = { java: ['minecraft-java', 'tcp'], bedrock: ['minecraft-bedrock', 'udp'], udp: [null, 'udp'] }[kind]
      let list = (await call('/tunnels/list', { tunnel_id: null, agent_id: null }, secret)).tunnels
      let t = list.find(t => t.name === name)
      if (t && (t.origin?.data?.local_port !== localPort || t.origin?.data?.agent_id !== run.agent_id)) {
        await call('/tunnels/delete', { tunnel_id: t.id }, secret).catch(() => {})
        t = null
      }
      if (!t) {
        const { id } = await call('/tunnels/create', {
          name, tunnel_type: type[0], port_type: type[1], port_count: 1, enabled: true, alloc: null, firewall_id: null, proxy_protocol: null,
          origin: { type: 'agent', data: { agent_id: run.agent_id, local_ip: '127.0.0.1', local_port: localPort } },
        }, secret)
        t = { id }
      }
      for (let i = 0; i < 30; i++) {
        t = (await call('/tunnels/list', { tunnel_id: t.id, agent_id: null }, secret)).tunnels.find(x => x.id === t.id) || t
        if (t.alloc?.status === 'allocated') {
          const a = t.alloc.data
          // Java tunnels get an SRV record, so the bare domain works in the Minecraft server list.
          return kind === 'java' ? a.assigned_domain : `${a.ip_hostname || a.assigned_domain}:${a.port_start}`
        }
        if (t.alloc?.status === 'disabled') throw new Error(`playit.gg tunnel disabled: ${t.alloc.data?.reason || 'unknown reason'}`)
        await new Promise(r => setTimeout(r, 2000))
      }
      throw new Error('playit.gg did not assign an address in time')
    },

    // One shared agent process carries every tunnel of the account.
    startAgent: async (secret, onLog) => {
      if (agent && agent.exitCode === null) return
      agent = spawn(await binary(), ['--secret', secret.trim(), '-s', 'start'], { stdio: ['ignore', 'pipe', 'pipe'] })
      const log = d => String(d).split(/\r?\n/).filter(Boolean).forEach(l => onLog?.(`[playit] ${l.replaceAll(secret.trim(), '<secret>')}`))
      agent.stdout.on('data', log); agent.stderr.on('data', log)
      agent.on('exit', c => onLog?.(`[playit] agent stopped (${c})`))
    },
    stopAgent: () => { agent?.kill(); agent = null },
    ping: () => call('/claim/setup', { code: crypto.randomBytes(5).toString('hex'), agent_type: 'self-managed', version: 'Mod Manager ping' }),
  }
}
