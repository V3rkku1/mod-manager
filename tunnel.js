// Minimal client for bore (github.com/ekzhang/bore): exposes a local TCP port on bore.pub:<random port>.
// Protocol: JSON messages terminated by "\0" on control port 7835. No account or binary needed.
const net = require('net')
const CONTROL = 7835

function frames(sock, onMsg) {
  let buf = Buffer.alloc(0)
  const onData = d => {
    buf = Buffer.concat([buf, d])
    for (let i; (i = buf.indexOf(0)) >= 0;) {
      const raw = buf.subarray(0, i).toString(); buf = buf.subarray(i + 1)
      if (onMsg(JSON.parse(raw), buf) === false) { sock.off('data', onData); return }
    }
  }
  sock.on('data', onData)
}
const send = (sock, msg) => sock.write(JSON.stringify(msg) + '\0')

// Resolves { host, port, close() } once the server assigns a public port.
function open(localPort, { host = 'bore.pub', localHost = '127.0.0.1', onError } = {}) {
  return new Promise((resolve, reject) => {
    const ctl = net.connect(CONTROL, host)
    const conns = new Set()
    const close = () => { ctl.destroy(); conns.forEach(c => c.destroy()) }
    ctl.on('error', e => { reject(e); onError?.(e) })
    ctl.on('close', () => onError?.(new Error('Tunnel closed')))
    ctl.on('connect', () => send(ctl, { Hello: 0 }))
    frames(ctl, msg => {
      if (msg.Error) return reject(new Error(msg.Error))
      if (msg.Hello) return resolve({ host, port: msg.Hello, close })
      if (msg.Connection) {
        // Each player connection: new socket to the server, Accept(id), then pipe raw bytes to the local port.
        const remote = net.connect(CONTROL, host), local = net.connect(localPort, localHost)
        conns.add(remote); conns.add(local)
        const end = () => { remote.destroy(); local.destroy(); conns.delete(remote); conns.delete(local) }
        remote.on('error', end); local.on('error', end); remote.on('close', end); local.on('close', end)
        remote.on('connect', () => { send(remote, { Accept: msg.Connection }); remote.pipe(local); local.pipe(remote) })
      }
    })
  })
}

module.exports = { open, frames, send }
