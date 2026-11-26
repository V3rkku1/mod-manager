// Steam Workshop for Terraria (tModLoader, app 1281930).
// Browse: the Workshop page's embedded JSON. Download: Valve's steamcmd with an anonymous login (Windows only).
const fs = require('fs'), path = require('path')
const { spawn } = require('child_process')
const { get, bytes, q, write, walk, extract } = require('../lib')
const APP = 1281930
const TAGS = ['New Content', 'Quality of Life', 'Utilities', 'Library', 'Gameplay Tweaks', 'Visual Tweaks', 'Audio Tweaks', 'Player Character', 'Custom World Gen', 'Translation']
const SORT = { popular: 'totaluniquesubscribers', updated: 'lastupdated', newest: 'mostrecent', rated: 'toprated' }
// Values in the page are JSON-escaped twice.
const un = s => JSON.parse(`"${JSON.parse(`"${s}"`).replace(/\\?"/g, '\\"')}"`)
const ITEM = /\{\\"publishedfileid\\":\\"(\d+)\\",\\"creator\\":\\"\d+\\",\\"consumer_appid\\":\d+,.*?\\"preview_url\\":\\"(.*?)\\",\\"title\\":\\"(.*?)\\",\\"short_description\\":\\"(.*?)\\",\\"workshop_accepted.*?\\"time_updated\\":(\d+)/g

module.exports = ({ files, dataDir }) => {
  const details = async id => {
    const r = await get('https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/', {}, { method: 'POST', body: new URLSearchParams({ itemcount: '1', 'publishedfileids[0]': id }) })
    const d = (await r.json()).response.publishedfiledetails[0]
    if (d.result !== 1 || d.consumer_app_id !== APP) throw new Error('Workshop item not found')
    return d
  }
  // "Required items" listed on the item's Workshop page.
  const required = async id => {
    const html = await (await get(`https://steamcommunity.com/sharedfiles/filedetails/?id=${q(id)}`)).text()
    const block = html.split('id="RequiredItems"')[1]?.split('</div>\n\t\t\t</div>')[0] || ''
    return [...new Set([...block.matchAll(/filedetails\/\?id=(\d+)/g)].map(m => m[1]))].filter(x => x !== String(id))
  }

  async function steamcmd() {
    if (process.platform !== 'win32') throw new Error('Workshop downloads need Windows (steamcmd)')
    const dir = path.join(dataDir, 'steamcmd'), exe = path.join(dir, 'steamcmd.exe')
    if (!fs.existsSync(exe)) for (const [f, d] of Object.entries(await extract('steamcmd.zip', await bytes('https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip')))) write(dir, f, d)
    return exe
  }
  const download = (exe, id) => new Promise((ok, fail) => {
    const out = path.join(dataDir, 'workshop')
    const p = spawn(exe, ['+force_install_dir', out, '+login', 'anonymous', '+workshop_download_item', String(APP), String(id), '+quit'])
    let log = ''
    p.stdout.on('data', d => log += d); p.stderr.on('data', d => log += d)
    p.on('error', fail)
    p.on('exit', () => {
      const dir = path.join(out, 'steamapps', 'workshop', 'content', String(APP), String(id))
      if (/Success\. Downloaded item/.test(log) && fs.existsSync(dir)) ok(dir)
      else fail(new Error(`steamcmd could not download ${id}: ${log.trim().split('\n').at(-1)}`))
    })
  })
  // Newest tModLoader version folder wins; a .tmod at the root is the fallback.
  const pickTmod = dir => {
    const list = walk(dir).filter(f => f.endsWith('.tmod'))
    const ver = f => f.includes('/') ? f.split('/')[0].split('.').map(n => n.padStart(6, '0')).join('.') : ''
    return list.sort((a, b) => ver(b).localeCompare(ver(a)))[0]
  }

  return {
    filters: async () => ({ categories: TAGS.map(t => ({ id: t, name: t })) }),

    search: async (p, text, page, { sort, categories = [] }) => {
      const tags = categories.filter(t => TAGS.includes(t)).map(t => `&requiredtags%5B%5D=${q(t)}`).join('')
      const html = await (await get(`https://steamcommunity.com/workshop/browse/?appid=${APP}&searchtext=${q(text)}&browsesort=${text ? 'textsearch' : SORT[sort] || SORT.popular}&section=readytouseitems&days=-1&p=${page}${tags}`)).text()
      const items = [...html.matchAll(ITEM)].map(m => ({ id: m[1], icon: un(m[2]), title: un(m[3]), desc: un(m[4]), author: '' }))
      return { pages: Math.min(+html.match(/\\"total_pages\\":(\d+)/)?.[1] || 1, 1000), items }
    },

    async install(p, id) {
      const [d, deps, exe] = await Promise.all([details(id), required(id).catch(() => []), steamcmd()])
      const dir = await download(exe, id), tmod = pickTmod(dir)
      if (!tmod) throw new Error(`${d.title}: no .tmod file in the download`)
      const rel = `Mods/${path.basename(tmod)}`
      write(files(p), rel, fs.readFileSync(path.join(dir, tmod)))
      return {
        mod: { id: String(id), name: d.title, version: new Date(d.time_updated * 1000).toLocaleDateString('en-CA'), vid: String(d.time_updated), icon: d.preview_url, files: [rel] },
        deps: deps.map(id => ({ id })),
      }
    },

    latest: async (p, m) => { const d = await details(m.id); return { version: new Date(d.time_updated * 1000).toLocaleDateString('en-CA'), vid: String(d.time_updated) } },

    async details(p, id) {
      const d = await details(id)
      return {
        title: d.title, author: '', icon: d.preview_url, summary: `${d.subscriptions?.toLocaleString?.() ?? 0} subscribers`, body: d.description.replace(/\n/g, '<br>'), format: 'bbcode',
        gallery: [d.preview_url].filter(Boolean), website: `https://steamcommunity.com/sharedfiles/filedetails/?id=${id}`,
        versions: [{ vid: String(d.time_updated), name: 'Latest', date: new Date(d.time_updated * 1000).toISOString() }],
      }
    },

    url: (p, id) => `https://steamcommunity.com/sharedfiles/filedetails/?id=${id}`,
  }
}
