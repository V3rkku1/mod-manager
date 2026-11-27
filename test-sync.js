// World sync between two "friends" on one machine through a shared folder: hand-off, version bump, host lock. Run: npm run test:sync
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os')
const { spawn, spawnSync } = require('child_process')
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-sync-')), shared = path.join(T, 'shared'); fs.mkdirSync(shared)
const friend = (...a) => ['test-sync-friend.js', a[0], path.join(T, a[0]), shared, ...a.slice(1)]
const result = out => JSON.parse(out.split('\n').find(l => l.startsWith('RESULT ')).slice(7))
;(async () => {
  const a1 = spawnSync('node', friend('Alice', '25731', 'host', 'hello'), { encoding: 'utf8' })
  assert.strictEqual(result(a1.stdout).meta.version, 1, 'Alice uploads v1')
  const bob = spawn('node', friend('Bob', '25732', 'host', 'hi', '45')); let bobOut = ''
  bob.stdout.on('data', d => bobOut += d)
  for (let i = 0; i < 120 && !bobOut.includes('Done ('); i++) await new Promise(r => setTimeout(r, 1000))
  assert(bobOut.includes('Downloading shared world v1'), 'Bob downloads v1')
  const a2 = spawnSync('node', friend('Alice', '25733', 'try'), { encoding: 'utf8' })
  assert(/Bob is hosting/.test(a2.stdout), 'lock blocks Alice: ' + a2.stdout)
  await new Promise(r => bob.on('exit', r))
  assert.strictEqual(result(bobOut).meta.version, 2, 'Bob uploads v2')
  console.log('ok world sync')
})().catch(e => { console.error(e); process.exit(1) })
