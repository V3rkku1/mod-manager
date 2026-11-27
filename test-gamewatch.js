// A game started by another launcher (java ... --gameDir <profile folder>) is spotted, shown as running, and Stop ends it.
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), { spawn } = require('child_process')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gw')), ev = []
const core = require('./core')(path.join(tmp, 'profiles'), { emit: (e, d) => e === 'status' && ev.push(d.text) })
const until = async c => { for (let i = 0; i < 100 && !c(); i++) await new Promise(r => setTimeout(r, 200)); assert(c(), 'timeout') }
;(async () => {
  const p = await core.createProfile({ name: 'W', type: 'modrinth', mc: { version: '1.21.1', loader: 'fabric' } })
  fs.mkdirSync(p.target, { recursive: true })
  const watch = core.watchGame(p.id)
  // Stand-in for the game: its command line looks like Minecraft's.
  const game = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', 'java', '--gameDir', p.target])
  await until(() => ev.includes('Running'))
  assert.deepEqual(await core.running(), [p.id])
  core.stop(p.id)
  await until(() => ev.at(-1) === null)
  await watch
  assert(game.killed || game.exitCode !== null || game.signalCode, 'game stopped')
  assert.deepEqual(await core.running(), [])
  console.log('ok game watch')
})().catch(e => { console.error(e); process.exit(1) })
