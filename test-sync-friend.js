// Helper for test-sync.js: one "friend" (MM_SYNC_NAME) hosting or trying to host a synced world.
// node test-sync-friend.js <name> <root> <shared> <port> <host|try> [say-text] [hold-seconds]
const [, , name, root, shared, port, action] = process.argv
process.env.MM_SYNC_NAME = name
const path = require('path'), fs = require('fs')
const core = require('./core')(path.join(root, 'profiles'), { emit: (e, d) => e === 'slog' && console.log(`[${name}] ${d.line}`) })
const wait = async (fn, s = 240) => { for (let i = 0; i < s; i++) { if (await fn()) return true; await new Promise(r => setTimeout(r, 1000)) } return false }
;(async () => {
  let p = (await core.listProfiles())[0] || await core.createProfile({ name: 'Shared', type: 'modrinth', mc: { version: '1.21.1', loader: 'vanilla' } })
  if (!p.server?.syncDir) await core.setSyncDir(p.id, shared)
  if (action === 'host') {
    await core.serverStart(p.id, { eula: true, port: +port })
    await wait(async () => (await core.serverStatus(p.id)).online)
    if (process.argv[7]) core.serverCmd(p.id, `say ${process.argv[7]}`), await new Promise(r => setTimeout(r, 1500))
    const hold = +(process.argv[8] || 0); if (hold) await new Promise(r => setTimeout(r, hold * 1000))
    core.serverStop(p.id)
    await wait(async () => !(await core.serverStatus(p.id)).running, 60)
    await new Promise(r => setTimeout(r, 3000))
    console.log('RESULT', JSON.stringify(await core.syncStatus(p.id)))
  }
  if (action === 'try') console.log('RESULT', await core.serverStart(p.id, { eula: true, port: +port }).then(() => 'started', e => e.message))
  if (action === 'seed') console.log('RESULT', fs.existsSync(path.join(root, 'profiles', p.id, 'server', 'world', 'level.dat')), fs.readFileSync(path.join(root, 'profiles', p.id, 'server', 'server.properties'), 'utf8').match(/level-seed=.*|motd=.*/g))
  process.exit(0)
})().catch(e => { console.error('ERR', e.message); process.exit(1) })
