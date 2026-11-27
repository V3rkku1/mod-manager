// Vanilla DOM renderer. Skipped: framework, router, state library; native <dialog> for modals, SVG sprite for icons.
const $ = s => document.querySelector(s)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
const fmt = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : n ?? ''
const ic = (name, cls = 'i') => `<svg class="${cls}"><use href="#i-${name}"/></svg>`
const SRC = { thunderstore: 'Thunderstore', modrinth: 'Modrinth', curseforge: 'CurseForge', nexus: 'Nexus Mods', gamebanana: 'GameBanana', workshop: 'Steam Workshop', terraria: 'tModLoader' }
const TERRARIA = { name: 'Terraria', icon: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1281930/header.jpg', banner: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1281930/header.jpg' }
const PICK_TYPES = ['thunderstore', 'curseforge', 'nexus', 'gamebanana']
let profiles = [], cur = null, tab = 'browse', page = 1, timer, updates = {}, picked = null
const gameCache = {}
if (window.platform === 'darwin') document.body.classList.add('mac')

// action = { label, fn } adds a button (e.g. Undo) to the toast.
const toast = (msg, err, action) => {
  const t = document.createElement('div')
  t.className = 'toast' + (err ? ' err' : '')
  t.innerHTML = ic(err ? 'alert' : 'check') + `<span>${esc(msg)}</span>`
  if (action) { const b = document.createElement('button'); b.textContent = action.label; b.onclick = () => { t.remove(); action.fn() }; t.append(b) }
  $('#toasts').append(t); setTimeout(() => t.remove(), err ? 8000 : action ? 7000 : 3500)
}
const run = async fn => {
  try { return await fn() } catch (e) { const m = e.message.replace(/^Error invoking remote method '\w+': (Error: )?/, ''); m === 'Stopped' ? toast('Cancelled') : toast(m, true) }
}
const setProfile = p => { profiles = profiles.map(x => x.id === p.id ? p : x); if (cur?.id === p.id) cur = p }
const defSrc = p => ({ modrinth: 'modrinth', terraria: 'workshop' })[p.type] || p.type
const curSrc = () => cur.type === 'modrinth' ? $('#src').value : defSrc(cur)
const srcOf = m => m.src || defSrc(cur)
const warn = p => p?.warn?.forEach(w => toast(w, true))

// Last profile + tab (per-device convenience, so localStorage is fine).
const remember = () => { try { if (cur) localStorage.setItem('mm.last', JSON.stringify({ id: cur.id, tab })) } catch {} }
async function refresh(id) {
  profiles = await api.listProfiles()
  if (id === undefined && !cur && remembering) { try { const l = JSON.parse(localStorage.getItem('mm.last')); if (profiles.some(p => p.id === l.id)) id = l.id, tab = l.tab || tab } catch {} }
  cur = profiles.find(p => p.id === (id ?? cur?.id)) || profiles[0] || null
  render()
}

const avatar = p => p.icon ? `<img src="${esc(p.icon)}" alt="">` : p.type === 'modrinth' ? ic('grass', '') : esc(p.name.slice(0, 2).toUpperCase())
const hours = s => s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m` : `${Math.floor(s / 60)}m`
const ago = t => { const m = (Date.now() - t) / 60e3; return m < 60 ? 'just now' : m < 1440 ? `${Math.round(m / 60)}h ago` : m < 2 * 1440 ? 'yesterday' : `${Math.round(m / 1440)}d ago` }
const meta = p => (p.type === 'modrinth' ? `Minecraft ${p.mc.version} · ${p.mc.loader}` : `${p.gameName || p.game} · ${SRC[p.type]}`) + (p.playtime ? ` · ${hours(p.playtime)} played` : '') + (p.lastPlayed ? ` · last ${ago(p.lastPlayed)}` : '')
const TITLES = { browse: ['Browse', 'compass'], installed: ['Installed', 'package'], worlds: ['Worlds', 'globe'], logs: ['Logs', 'terminal'], server: ['Server', 'server'], options: ['Options', 'sliders'] }
const SITE = 'https://v3rkku1.github.io/mod-manager/', LINK = SITE + 'join.html#'
let selected = new Set()
let lxName = 'GTA 6', lxView = false, lxOn = false // the Recomps (Launcher-X) instance: its name, whether its page is open, whether it was added
let setupLeft = 0, running = new Set(), status = {}, filterCache = {}, chips = new Set(), pages = 1, remembering = true

function render() {
  const groups = [...new Set(profiles.map(p => p.group || ''))].sort()
  $('#rail').innerHTML = groups.map(g => (g ? `<div class="sep"></div><div class="rail-group" title="${esc(g)}">${esc(g)}</div>` : '')
    + profiles.filter(p => (p.group || '') === g).map(p => `<button class="pfp ${p.id === cur?.id && !lxView ? 'on' : ''} ${running.has(p.id) ? 'playing' : ''}" data-id="${p.id}" data-tip="${esc(p.name)}">${avatar(p)}${Object.keys(updates[p.id] || {}).length ? `<i class="rbadge">${Object.keys(updates[p.id]).length}</i>` : ''}</button>`).join('')).join('')
    + (lxOn ? `<button class="pfp lx ${lxView ? 'on' : ''}" id="lxOpen" data-tip="${esc(lxName)} (recomps)">${esc(lxName.split(/\s+/).map(w => /^\d/.test(w) ? w : w[0]).join('').slice(0, 3).toUpperCase())}</button>` : '')
    + (profiles.length || lxOn ? '<div class="sep"></div>' : '')
    + `<button class="pfp add" id="add" data-tip="New profile">${ic('plus')}</button>`
    + `<button class="pfp gear" id="settings" data-tip="${setupLeft ? 'Finish setup' : 'Settings'}">${ic('gear')}${setupLeft ? `<i class="rbadge">${setupLeft}</i>` : ''}</button>`
  $('#app').classList.toggle('empty', !cur && !lxView)
  document.body.classList.toggle('lxv', lxView)
  if (lxView) return drawLx()
  if (!cur) return
  const mc = cur.type === 'modrinth'
  document.body.classList.toggle('mc', mc)
  document.body.classList.toggle('mc-banner', mc && !cur.banner)
  document.body.classList.toggle('mr', mc && curSrc() === 'modrinth' && !['following'].includes($('#kind').value))
  $('#kind option[value=following]').hidden = curSrc() !== 'modrinth'
  if (!mc && !['browse', 'installed', 'options'].includes(tab)) tab = 'browse'
  playButton()
  $('#banner').style.backgroundImage = cur.banner ? `url("${encodeURI(cur.banner)}")` : ''
  $('#pname').textContent = cur.name
  $('#pmeta').textContent = meta(cur)
  $('#target').textContent = cur.target || 'Not set'
  $('#target').title = cur.target || ''
  $('#target').classList.toggle('unset', !cur.target)
  $('#kind option[value=modpack]').hidden = curSrc() === 'curseforge'
  if (curSrc() === 'curseforge' && $('#kind').value === 'modpack') $('#kind').value = 'mod'
  $('#q').placeholder = `Search ${SRC[curSrc()]}`
  updateBadges()
  document.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === tab))
  $('main').className = tab
  $('#title').textContent = TITLES[tab][0]
  $('main .hd use').setAttribute('href', '#i-' + TITLES[tab][1])
  const list = $('#list'); list.classList.remove('enter'); void list.offsetWidth; list.classList.add('enter')
  ;({ browse: search, installed: showInstalled, worlds: showWorlds, logs: showLogs, server: showServer, options: showOptions })[tab]()
  remember()

}

function updateBadges() {
  const n = Object.keys(updates[cur.id] || {}).length
  $('#count').textContent = n || cur.mods.length || ''
  $('#count').classList.toggle('upd', !!n)
  $('#updAll').hidden = !n
  $('#updAll').lastChild.textContent = ` Update all (${n})`
}

const installedBtn = `<span class="a">${ic('check')} Installed</span><span class="b">${ic('trash')} Remove</span>`
const card = (m, src, installed) => `<div class="mod" data-id="${esc(m.id)}" data-src="${src}">
  ${m.icon ? `<img src="${esc(m.icon)}" alt="" loading="lazy" decoding="async">` : '<div class="noicon"></div>'}
  <div class="body"><div class="top"><b>${esc(m.title)}</b>${m.author ? `<small>by ${esc(m.author)}</small>` : ''}
  ${m.downloads != null ? `<small>${ic('download', 'i sm')} ${fmt(m.downloads)}</small>` : ''}${(m.tags || []).slice(0, 3).map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div><p>${esc(m.desc)}</p></div>
  <div class="actions">
    <button class="icon fav ${isFav(src, m.id) ? 'on' : ''}" data-act="fav" title="Favorite">${ic('star')}</button>
    <button class="icon" data-act="link" title="Open mod page">${ic('external')}</button>
    <button class="act ${installed ? 'done' : ''}" data-act="toggle">${installed ? installedBtn : `${ic('download')} Install`}</button>
  </div></div>`

const row = m => {
  const up = updates[cur.id]?.[m.id], src = srcOf(m)
  const parents = cur.mods.filter(x => x.deps?.includes(m.id)).map(x => x.name)
  return `<div class="mod ${m.disabled ? 'off' : ''} ${selected.has(m.id) ? 'sel' : ''}" data-id="${esc(m.id)}" data-src="${src}">
  <input type="checkbox" class="pick" data-act="select" ${selected.has(m.id) ? 'checked' : ''} title="Select">
  ${m.icon ? `<img src="${esc(m.icon)}" alt="" loading="lazy" decoding="async">` : '<div class="noicon"></div>'}
  <div class="body"><div class="top"><b>${esc(m.name)}</b><span class="tag">${esc(m.version)}</span>
  ${src === 'local' ? '<span class="tag">Local file</span>' : cur.type === 'modrinth' ? `<span class="tag src ${src}">${SRC[src]}</span>` : ''}${m.pack ? '<span class="tag pack">Modpack</span>' : ''}
  ${up ? `<span class="tag upd">→ ${esc(up.version ?? up)}</span>` : ''}${m.pinned ? `<span class="tag">${ic('key', 'i sm')} Pinned</span>` : ''}</div>
  <p>${m.note ? `📝 ${esc(m.note)} · ` : ''}${parents.length ? `Needed by ${esc(parents.join(', '))} · ` : m.deps?.length ? `Uses ${m.deps.length} dependenc${m.deps.length === 1 ? 'y' : 'ies'} · ` : ''}${m.files.length} file${m.files.length === 1 ? '' : 's'}</p></div>
  <div class="actions">
    ${up ? `<button class="icon" data-act="changes" title="What's new">${ic('file')}</button><button class="upd" data-act="update">${ic('up')} Update</button>` : ''}
    ${m.pack ? `<button class="icon" data-act="split" title="Show the mods in this pack separately">${ic('package')}</button>` : ''}
    ${m.pack && src !== 'local' ? `<button class="icon" data-act="unlink" title="Unlink from modpack (stop pack updates)">${ic('x')}</button>` : ''}
    ${src === 'local' ? '' : `<button class="icon" data-act="link" title="Open mod page">${ic('external')}</button>`}
    <button class="icon ${m.pinned ? 'on' : ''}" data-act="pin" title="${m.pinned ? 'Unpin (allow updates)' : 'Pin this version (skip updates)'}">${ic('key')}</button>
    <button class="icon" data-act="note" title="Note">${ic('pencil')}</button>
    <button class="icon" data-act="remove" title="Remove">${ic('trash')}</button>
    <input type="checkbox" class="switch" data-act="enable" title="Enabled" ${m.disabled ? '' : 'checked'}>
  </div></div>`
}

// Search results are cached for 3 minutes and the next page is prefetched, so paging and tab switches are instant.
const searchCache = new Map()
const searchArgs = (pg = page) => [cur.id, curSrc(), $('#q').value, pg, { kind: $('#kind').value, sort: $('#sort').value, categories: [...chips], section: $('#section').value, env: $('#env').value }]
function cachedSearch(args) {
  const key = JSON.stringify(args), hit = searchCache.get(key)
  if (hit && Date.now() - hit.t < 180e3) return hit.p
  const p = api.search(...args); searchCache.set(key, { t: Date.now(), p })
  p.catch(() => searchCache.delete(key))
  if (searchCache.size > 200) searchCache.delete(searchCache.keys().next().value)
  return p
}
async function search(keepPage) {
  const id = cur.id, src = curSrc()
  if (!keepPage) page = 1
  const args = searchArgs(), key = JSON.stringify(args)
  if (!searchCache.has(key)) $('#list').innerHTML = '<div class="skel"></div>'.repeat(6)
  loadFilters()
  const res = favMode ? { pages: 1, items: favList() } : await run(() => cachedSearch(args))
  if (cur?.id !== id || tab !== 'browse' || JSON.stringify(searchArgs()) !== key) return
  if (res && page < res.pages) (window.requestIdleCallback || setTimeout)(() => cachedSearch(searchArgs(page + 1)).catch(() => {}))
  if (!res) return $('#list').innerHTML = `<div class="hint">${ic('alert')}Couldn't load mods.</div>`
  const have = new Set(cur.mods.map(m => m.id))
  pages = Math.max(1, res.pages || 1)
  $('#list').innerHTML = (res.items.map(m => card(m, src, have.has(m.id))).join('') || `<div class="hint">${ic('search')}No mods found.</div>`) + pager()
  $('#list').scrollTop = 0
}
// Page numbers: first, last, and two around the current page.
function pager() {
  if (pages < 2) return ''
  const nums = [...new Set([1, page - 2, page - 1, page, page + 1, page + 2, pages])].filter(n => n >= 1 && n <= pages).sort((a, b) => a - b)
  const btn = (n, label = n, cls = '') => `<button data-page="${n}" class="${cls}" ${n < 1 || n > pages ? 'disabled' : ''}>${label}</button>`
  return `<nav class="pager">${btn(page - 1, '‹')}${nums.map((n, i) => (n - (nums[i - 1] || n) > 1 ? '<span>…</span>' : '') + btn(n, n, n === page ? 'on' : '')).join('')}${btn(page + 1, '›')}
    <input id="jump" type="number" min="1" max="${pages}" placeholder="Page" title="Jump to page (1–${pages})"></nav>`
}
async function loadFilters() {
  const src = curSrc(), kind = $('#kind').value, key = `${cur.id}:${src}:${kind}`
  const f = filterCache[key] ??= await api.filters(cur.id, src, kind).catch(() => ({}))
  if (curSrc() !== src) return
  $('#chips').innerHTML = (f.categories || []).map(c => `<button class="chip ${chips.has(c.id) ? 'on' : ''}" data-chip="${esc(c.id)}">${esc(c.name)}</button>`).join('')
  if ((f.categories || []).length > 12) $('#chips').insertAdjacentHTML('beforeend', `<button class="chip more" data-more>${$('#chips').classList.contains('open') ? 'Less' : 'More…'}</button>`)
  $('#chips').hidden = !f.categories?.length
  const sec = $('#section'), v = sec.value
  sec.innerHTML = '<option value="">All sections</option>' + (f.sections || []).map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')
  sec.value = v; sec.hidden = !f.sections?.length
}

function showInstalled() {
  if (instFor !== cur.id) instFind = '', instShow = 'all', instFor = cur.id
  allOffLabel()
  selected = new Set([...selected].filter(id => cur.mods.some(m => m.id === id)))
  const bulk = selected.size ? `<div class="bulk"><b>${selected.size} selected</b><button data-bulk="update">${ic('up')} Update</button><button data-bulk="enable">${ic('check')} Enable</button>
    <button data-bulk="disable">${ic('x')} Disable</button><button data-bulk="remove" class="danger">${ic('trash')} Remove</button><button data-bulk="none" class="icon">Clear</button></div>` : ''
  const bar = cur.mods.length > 3 ? `<div class="ifilter"><div class="search">${ic('search')}<input id="ifind" type="search" placeholder="Filter ${cur.mods.length} mods" value="${esc(instFind)}" autocomplete="off"></div>
    <select id="ishow">${[['all', 'All'], ['on', 'Enabled'], ['off', 'Disabled'], ['upd', 'Has update']].map(([v, l]) => `<option value="${v}" ${instShow === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>` : ''
  $('#list').innerHTML = '<div id="banners"></div>' + bar + bulk + (cur.mods.map(row).join('')
    || `<div class="hint">${ic('package')}<b>No mods yet</b><span>Find some in Browse.</span></div>`)
  filterInstalled()
  banners()
}
// Installed list filter: by name and enabled / disabled / has update. Kept while switching tabs.
let instFind = '', instShow = 'all', instFor
function filterInstalled() {
  const q = instFind.toLowerCase(), upd = updates[cur.id] || {}
  for (const el of document.querySelectorAll('#list .mod')) {
    const m = cur.mods.find(x => x.id === el.dataset.id); if (!m) continue
    el.hidden = !(m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q))
      || (instShow === 'on' && m.disabled) || (instShow === 'off' && !m.disabled) || (instShow === 'upd' && !upd[m.id])
  }
}
$('#list').addEventListener('input', e => { if (e.target.id === 'ifind') instFind = e.target.value, filterInstalled() })
$('#list').addEventListener('change', e => { if (e.target.id === 'ishow') instShow = e.target.value, filterInstalled() })
const diffText = d => [d.add.length && `+${d.add.length} new`, d.change.length && `${d.change.length} changed (${esc(d.change.slice(0, 3).join(', '))}${d.change.length > 3 ? '…' : ''})`,
  d.remove.length && `-${d.remove.length} removed (${esc(d.remove.slice(0, 3).join(', '))}${d.remove.length > 3 ? '…' : ''})`].filter(Boolean).join(' · ')
// Conflicts + "friend updated the pack" banners above the installed list.
async function banners() {
  const id = cur.id, [c, f] = await Promise.all([api.conflicts(id).catch(() => []), cur.follow ? api.checkFollow(id).catch(() => null) : null])
  if (cur?.id !== id || tab !== 'installed') return
  const d = f?.diff, n = d ? d.add.length + d.change.length + d.remove.length : 0
  $('#banners').innerHTML = (c.length ? `<div class="banner warn">${ic('alert')}<div><b>${c.length} problem${c.length > 1 ? 's' : ''}</b>${c.slice(0, 4).map(x => `<p>${x.type === 'file' ? `${esc(x.mods.join(' + '))} both write <code>${esc(x.file)}</code> — <b>${esc(x.winner)}</b> wins ${x.ids.slice(0, -1).map((id, i) => `<button class="linkish" data-win="${esc(id)}" data-after="${esc(x.ids.at(-1))}">Use ${esc(x.mods[i])}</button>`).join(' ')}` : x.type === 'missing' ? `${esc(x.mods.join(', '))} need${x.mods.length > 1 ? '' : 's'} <b>${esc(x.depName)}</b> ${x.disabled ? `(switched off) <button class="linkish" data-depon="${esc(x.dep)}">Turn on</button>` : `<button class="linkish" data-depadd="${esc(x.dep)}">Install it</button>`}`
      : x.type === 'duplicate' ? `${esc(x.files.join(' and '))} look like the same mod twice — switch one off`
      : `${esc(x.mods.join(' and '))} are incompatible`}</p>`).join('')}${c.some(x => x.type === 'file') ? '<small class="muted">Lower in the list wins. Change order with these buttons, then Deploy.</small>' : ''}</div></div>` : '')
    + (n ? `<div class="banner${f.changed ? '' : ' warn'}">${ic('refresh')}<div><b>${f.changed ? `${esc(f.owner || 'Your friend')} updated this pack` : `You changed ${esc(f.owner || 'your friend')}'s pack`}</b>
      <p>${diffText(d)}</p>${f.changed ? '' : '<p>Only the owner can change the shared list. Sync puts it back, or unfollow to keep your changes.</p>'}</div>
      ${f.changed ? '' : '<button id="unfollow">Unfollow</button>'}<button class="primary" id="syncFollow">Sync now</button></div>` : '')
}

async function checkUpdates(quiet) {
  const id = cur.id, b = $('#checkUpd')
  b.disabled = true
  const res = await run(() => api.checkUpdates(id))
  b.disabled = false
  if (!res) return
  updates[id] = res
  if (cur?.id !== id) return
  updateBadges()
  if (tab === 'installed') showInstalled()
  if (!quiet) toast(Object.keys(res).length ? `${Object.keys(res).length} update(s) available` : 'Everything is up to date')
}

// Rail: Discord-style tooltips + navigation
$('#rail').onmouseover = e => {
  const b = e.target.closest('[data-tip]'), tip = $('#tip')
  if (!b) return tip.hidden = true
  const r = b.getBoundingClientRect()
  tip.textContent = b.dataset.tip; tip.hidden = false
  tip.style.left = r.right + 14 + 'px'; tip.style.top = r.top + r.height / 2 + 'px'
}
$('#rail').onmouseleave = () => $('#tip').hidden = true
$('#rail').onclick = e => {
  const b = e.target.closest('button'); if (!b) return
  if (b.id === 'add') return openNew()
  if (b.id === 'lxOpen') { lxView = true; lxEdit = null; tab = 'lxprojects'; return render() }
  lxView = false
  if (b.id === 'settings') return openSettings(setupLeft ? 'setup' : 'appearance')
  cur = profiles.find(p => p.id === b.dataset.id); tab = 'browse'; $('#q').value = ''; chips.clear(); $('#section').value = ''; render()
}
$('#tabs').onclick = e => {
  const b = e.target.closest('[data-tab]'); if (!b) return
  tab = b.dataset.tab; render()
  if (tab === 'installed' && !updates[cur.id] && cur.mods.length) checkUpdates(true)
}
$('#q').oninput = () => { clearTimeout(timer); timer = setTimeout(() => search(), 300) }
$('#sort').onchange = $('#section').onchange = $('#env').onchange = () => search()
$('#kind').onchange = () => { chips.clear(); render() }
$('#chips').onclick = e => {
  if (e.target.closest('[data-more]')) { $('#chips').classList.toggle('open'); e.target.textContent = $('#chips').classList.contains('open') ? 'Less' : 'More…'; return }
  const c = e.target.closest('[data-chip]')?.dataset.chip; if (!c) return; chips.has(c) ? chips.delete(c) : chips.add(c); search() }
$('#allOff').onclick = () => run(async () => {
  const off = cur.mods.some(m => !m.disabled)
  setProfile(await api.setAllDisabled(cur.id, off)); showInstalled(); allOffLabel()
  toast(off ? 'All mods disabled — Deploy/Play now runs the game without mods' : 'All mods enabled')
})
const allOffLabel = () => { const off = cur.mods.length && cur.mods.every(m => m.disabled); $('#allOff').lastChild.textContent = off ? ' Enable all' : ' Disable all' }
$('#src').onchange = () => { chips.clear(); render() }
$('#list').addEventListener('keydown', e => { if (e.target.id === 'jump' && e.key === 'Enter') { const n = Math.min(pages, Math.max(1, +e.target.value || 1)); page = n; search(true) } })
$('#checkUpd').onclick = () => checkUpdates()
$('#updAll').onclick = async () => {
  const id = cur.id, ids = Object.keys(updates[id] || {}), b = $('#updAll')
  b.disabled = true
  await api.snapshot(id, `Before updating ${ids.length} mod${ids.length === 1 ? "" : "s"}`).catch(() => {})
  for (const [i, mod] of ids.entries()) {
    b.lastChild.textContent = ` Updating ${i + 1}/${ids.length}…`
    const p = await run(() => api.update(id, mod))
    if (p) setProfile(p), warn(p), delete updates[id][mod]
  }
  b.disabled = false
  if (cur?.id === id) render()
  toast('Updates finished — deploy to apply them')
}

async function doInstall(src, modId, vid) {
  const p = await fm(await run(() => api.install(cur.id, src, modId, vid)))
  if (p) setProfile(p), warn(p)
  return p
}

$('#list').onclick = async e => {
  const pg = e.target.closest('[data-page]'); if (pg) return page = +pg.dataset.page, search(true)
  const bk = e.target.closest('[data-bulk]')?.dataset.bulk
  if (bk) return bulkAction(bk)
  const dp = e.target.closest('[data-depon], [data-depadd]')
  if (dp) { dp.disabled = true; const p = await run(() => dp.dataset.depon ? api.setDisabled(cur.id, dp.dataset.depon, false) : api.install(cur.id, 'modrinth', dp.dataset.depadd)); if (p) setProfile(p.profile || p), showInstalled(); return }
  const w = e.target.closest('[data-win]'); if (w) { const p = await run(() => api.moveMod(cur.id, w.dataset.win, w.dataset.after)); if (p) setProfile(p), showInstalled(), toast('Order changed — Deploy to apply'); return }
  if (e.target.id === 'unfollow') return confirm('Stop following? The pack stays, with your changes, and no longer gets your friend\'s updates.') && run(async () => { setProfile(await api.unfollow(cur.id)); render(); toast('Unfollowed — this pack is yours now') })
  if (e.target.id === 'syncFollow') return run(async () => { e.target.disabled = true; const r = await api.sync(cur.id, `gist:${cur.follow.gist}`, { remove: true }); setProfile(r.profile); render(); toast(r.failed.length ? `Synced, ${r.failed.length} failed` : 'Synced with your friend', !!r.failed.length) })
  const el = e.target.closest('.mod'); if (!el || tab === 'server') return
  const modId = el.dataset.id, src = el.dataset.src
  if (e.target.closest('.body')) return src !== 'local' && openDetails(src, modId)
  const b = e.target.closest('[data-act]')
  if (!b || b.dataset.act === 'enable' || b.dataset.act === 'select') return
  const id = cur.id, act = b.dataset.act
  if (act === 'pin') { const m = cur.mods.find(m => m.id === modId); const p = await run(() => api.updateMod(id, modId, { pinned: !m.pinned })); if (p) setProfile(p), showInstalled(); return }
  if (act === 'note') { const m = cur.mods.find(m => m.id === modId), n = await ask('Note for ' + m.name, m.note || ''); if (n !== null) { const p = await run(() => api.updateMod(id, modId, { note: n })); if (p) setProfile(p), showInstalled() } return }
  if (act === 'link') return api.openExternal(await api.pageUrl(id, src, modId))
  if (act === 'fav') { toggleFav(src, el, modId); b.classList.toggle('on', isFav(src, modId)); if (favMode) search(); return }
  if (act === 'changes') { const m = cur.mods.find(m => m.id === modId), up = updates[id]?.[modId]; return showChanges(src, modId, m.name, up.vid, up.version) }
  if (act === 'split') { b.disabled = true; const p = await run(() => api.splitPack(id, modId)); if (p) setProfile(p), showInstalled(); return }
  if (act === 'unlink') { const p = await run(() => api.unlinkPack(id, modId)); if (p) setProfile(p), showInstalled(); return }
  const remove = act === 'remove' || (act === 'toggle' && b.classList.contains('done'))
  const was = remove && cur.mods.find(m => m.id === modId)
  const html = b.innerHTML
  b.disabled = true
  b.innerHTML = `${ic('refresh', 'i spin')} ${act === 'update' ? 'Updating' : remove ? 'Removing' : 'Installing'}…`
  const p = act === 'update' ? await fm(await run(() => api.update(id, modId))) : remove ? await run(() => api.uninstall(id, modId)) : await doInstall(src, modId)
  if (!p) return b.disabled = false, b.innerHTML = html
  if (act === 'update') delete updates[id]?.[modId], warn(p)
  if (was && was.src !== 'local') toast(`Removed ${was.name}`, false, { label: 'Undo', fn: async () => { const q = await doInstall(srcOf(was), was.id, was.vid ?? was.version); if (q && cur?.id === id) render() } })
  setProfile(p)
  if (cur?.id !== id) return
  updateBadges()
  if (tab === 'installed') return showInstalled(), remove && askOrphans()
  b.disabled = false
  b.classList.toggle('done', !remove)
  b.innerHTML = remove ? `${ic('download')} Install` : installedBtn
  if (!remove) toast(`Installed ${el.querySelector('b').textContent}`)
}
$('#list').onchange = async e => {
  if (e.target.dataset.act === 'select') { const id = e.target.closest('.mod').dataset.id; e.target.checked ? selected.add(id) : selected.delete(id); return showInstalled() }
  if (e.target.dataset.act !== 'enable') return
  const p = await run(() => api.setDisabled(cur.id, e.target.closest('.mod').dataset.id, !e.target.checked))
  if (p) setProfile(p), e.target.closest('.mod').classList.toggle('off', !e.target.checked)
}

// Mod details
const bbcode = s => s
  .replace(/\[url\](.*?)\[\/url\]/gi, '<a href="$1">$1</a>').replace(/\[url=([^\]]+)\]/gi, '<a href="$1">').replace(/\[\/url\]/gi, '</a>')
  .replace(/\[img[^\]]*\](.*?)\[\/img\]/gi, '<img src="$1">')
  .replace(/\[(\/?)(b|i|u|s)\]/gi, '<$1$2>')
  .replace(/\[size=(\d)\]/gi, '<span class="sz$1">').replace(/\[\/size\]/gi, '</span>')
  .replace(/\[\/?(color|font)[^\]]*\]/gi, '')
  .replace(/\[center\]/gi, '<div class="center">').replace(/\[\/center\]/gi, '</div>')
  .replace(/\[quote[^\]]*\]/gi, '<blockquote>').replace(/\[\/quote\]/gi, '</blockquote>')
  .replace(/\[code\]/gi, '<pre><code>').replace(/\[\/code\]/gi, '</code></pre>')
  .replace(/\[(\/?)h([1-3])\]/gi, '<$1h$2>').replace(/\[(\/?)strike\]/gi, '<$1s>').replace(/\[\/?noparse\]/gi, '').replace(/\[hr\]\[\/hr\]|\[hr\]/gi, '<hr>')
  .replace(/\[olist\]/gi, '<ol>').replace(/\[\/olist\]/gi, '</ol>')
  .replace(/\[list=1\]/gi, '<ol>').replace(/\[list\]/gi, '<ul>').replace(/\[\/list\]/gi, '</ul>')
  .replace(/\[\*\]/g, '<li>').replace(/\[\/\*\]/g, '</li>')
  .replace(/\[spoiler\]/gi, '<details><summary>Spoiler</summary>').replace(/\[\/spoiler\]/gi, '</details>')
  .replace(/\[(youtube|line)\][^[]*(\[\/youtube\])?/gi, '<hr>')
// Upgrade http media to https (CSP only allows https images).
DOMPurify.addHook('afterSanitizeAttributes', n => n.getAttribute?.('src')?.startsWith('http://') && n.setAttribute('src', 'https://' + n.getAttribute('src').slice(7)))
const toHtml = d => DOMPurify.sanitize(d.format === 'md' ? marked.parse(d.body || '') : d.format === 'bbcode' ? bbcode(d.body || '') : d.body || '',
  { FORBID_ATTR: ['style'], FORBID_TAGS: ['style', 'form', 'input', 'button'] })

let detail = null
async function openDetails(src, modId) {
  const dlg = $('#detailDlg')
  $('#detail').innerHTML = '<div class="dbody"><div class="skel"></div><div class="skel"></div></div>'
  dlg.showModal()
  const d = await run(() => api.details(cur.id, src, modId))
  if (!d) return dlg.close()
  detail = { ...d, src, id: modId }
  renderDetails('desc')
}
function renderDetails(pane) {
  const d = detail, inst = cur.mods.find(m => m.id === d.id)
  $('#detail').innerHTML = `<div class="dhead">
    ${d.icon ? `<img src="${esc(d.icon)}" alt="">` : '<div class="noicon"></div>'}
    <div><h2>${esc(d.title)}</h2><p>${d.author ? `by ${esc(d.author)} · ` : ''}${esc(d.summary)}</p></div>
    <div class="actions"><button class="icon" data-href="${esc(d.url)}" title="Open in browser">${ic('external')}</button>
    ${inst && d.src === 'nexus' ? `<button data-endorse ${inst.endorsed ? 'disabled' : ''}>${ic('check')} ${inst.endorsed ? 'Endorsed' : 'Endorse'}</button>` : ''}
    ${inst ? `<button class="act done" data-ver="remove">${installedBtn}</button>` : `<button class="act" data-ver="">${ic('download')} Install latest</button>`}</div></div>
    <div class="dtabs"><button data-pane="desc" class="${pane === 'desc' ? 'on' : ''}">Description</button>
    <button data-pane="vers" class="${pane === 'vers' ? 'on' : ''}">Versions (${d.versions.length})</button></div>
    <div class="dbody">${pane === 'desc'
      ? (d.gallery.length ? `<div class="gallery">${d.gallery.map(g => `<img src="${esc(g)}" alt="" loading="lazy">`).join('')}</div>` : '') + `<div class="desc">${toHtml(d)}</div>`
      : `<div class="vers">${d.versions.map(v => `<div class="ver"><div><b>${esc(v.name)}</b><small>${v.date ? new Date(v.date).toLocaleDateString() : ''}${v.tag ? ' · ' + esc(v.tag) : ''}${v.downloads != null ? ` · ${fmt(v.downloads)} downloads` : ''}</small></div>
        ${inst && String(inst.vid ?? inst.version) === String(v.vid) ? `<span class="tag">Installed</span>` : `<button data-ver="${esc(v.vid)}">${ic('download')} Install</button>`}<button class="icon" data-chg="${esc(v.vid)}" data-chgname="${esc(v.name)}" title="What changed">${ic('file')}</button></div>`).join('') || '<p class="muted">No versions for this game version / loader.</p>'}</div>`}</div>`
}
$('#detail').onclick = async e => {
  const chg = e.target.closest('[data-chg]'); if (chg) return showChanges(detail.src, detail.id, detail.title, chg.dataset.chg, chg.dataset.chgname)
  const t = e.target.closest('[data-pane]'); if (t) return renderDetails(t.dataset.pane)
  if (e.target.closest('[data-endorse]')) { const p = await run(() => api.endorse(cur.id, detail.id)); if (p) setProfile(p), toast('Endorsed — thanks the author'), renderDetails($('.dtabs .on').dataset.pane); return }
  if (e.target.matches('.gallery img')) {
    const z = document.createElement('div'); z.id = 'zoom'; z.innerHTML = `<img src="${esc(e.target.src)}" alt="">`
    z.onclick = () => z.remove(); return $('#detailDlg').append(z)
  }
  const b = e.target.closest('[data-ver]'); if (!b) return
  const { src, id } = detail, pane = $('.dtabs .on').dataset.pane
  b.disabled = true; b.innerHTML = `${ic('refresh', 'i spin')} Working…`
  const p = b.dataset.ver === 'remove' ? await run(() => api.uninstall(cur.id, id)) : await doInstall(src, id, b.dataset.ver || null)
  if (p) setProfile(p), toast(b.dataset.ver === 'remove' ? 'Removed' : `Installed ${detail.title}`), render()
  renderDetails(pane)
}

// External links anywhere (descriptions, settings help) open in the browser.
document.addEventListener('click', e => {
  const a = e.target.closest('a[href], [data-href]'); if (!a) return
  e.preventDefault()
  const href = a.dataset.href || a.getAttribute('href')
  if (/^https:\/\//.test(href)) api.openExternal(href)
})

// Sidebar actions
$('#rename').onclick = () => {
  const n = $('#pname'); n.contentEditable = true; n.focus()
  getSelection().selectAllChildren(n)
}
$('#pname').onkeydown = e => { if (e.key === 'Enter') e.preventDefault(), e.target.blur(); if (e.key === 'Escape') e.target.textContent = cur.name, e.target.blur() }
$('#pname').onblur = async e => {
  e.target.contentEditable = false
  const name = e.target.textContent.trim()
  if (!name || name === cur.name) return e.target.textContent = cur.name
  const p = await run(() => api.updateProfile(cur.id, { name })); if (p) setProfile(p), render()
}
$('#pick').onclick = async () => {
  const dir = await api.pickFolder()
  if (dir) await run(async () => { setProfile(await api.updateProfile(cur.id, { target: dir })); render() })
}
$('#find').onclick = () => run(async () => { const p = await api.findGame(cur.id); setProfile(p); render(); toast(`Found ${p.target}`) })
$('#open').onclick = async () => api.openFolder(`${await api.profilesDir()}/${cur.id}/files`)
const deploy = async () => {
  if (!cur.target) throw new Error('Set the target folder first (target icon next to TARGET FOLDER)')
  const p = await api.deploy(cur.id); setProfile(p); return p
}
$('#deploy').onclick = () => run(async () => { const p = await deploy(); toast(`Deployed ${p.deployed.length} files`) })
$('#play').onclick = () => run(async () => {
  const id = cur.id
  if (cur.type !== 'modrinth') { await deploy(); await api.launch(id); return toast('Mods deployed — starting game') }
  if (running.has(id) || status[id]) return api.stop(id)
  await startGame(id)
})
// Starts Minecraft for profile `id`, optionally straight into a world or server ({ world } / { server }).
async function startGame(id, quick = {}) {
  const p = profiles.find(x => x.id === id)
  // Followed pack: offer the friend's latest mod list first, so everyone joins with the same mods.
  const f = p.follow && await api.checkFollow(id).catch(() => null)
  if (f?.changed && confirm(`${f.owner || 'Your friend'} updated this pack (${diffText(f.diff).replace(/&#\d+;/g, '')}). Sync before playing?`)) {
    status[id] = 'Syncing…'; playButton()
    try { const r = await api.sync(id, `gist:${p.follow.gist}`, { remove: true }); setProfile(r.profile) } finally { delete status[id]; playButton() }
  }
  // Missing required mods, incompatible pairs or a mod twice usually crash the game: ask first.
  const bad = (await api.conflicts(id).catch(() => [])).filter(x => x.type !== 'file')
  if (bad.length && !confirm(`This profile may crash:\n${bad.slice(0, 5).map(x => x.type === 'missing' ? `• ${x.mods.join(', ')} need ${x.depName}${x.disabled ? ' (switched off)' : ''}`
    : x.type === 'duplicate' ? `• Same mod twice: ${x.files.join(' and ')}` : `• ${x.mods.join(' and ')} are incompatible`).join('\n')}\n\nFix it in Installed, or press OK to play anyway.`)) {
    tab = 'installed'; return render()
  }
  status[id] = 'Preparing…'; playButton()
  try {
    // No Microsoft account linked: play through the launcher picked in Settings (official Minecraft Launcher by default).
    if (!(await api.accounts()).length) {
      const launcher = (await api.getSettings()).launcher
      if (launcher === 'custom') return await api.playCustom(id, quick)
      if (['prism', 'multimc'].includes(launcher)) return await api.playPrism(id, quick)
      const r = await api.playOfficial(id)
      return toast(r.launched ? `Opened Minecraft Launcher — pick "${r.profile}" and press Play${quick.server ? `, then join ${quick.server} under Multiplayer` : ''}. This button turns to Stop once the game runs.` : `Added "${r.profile}" to the Minecraft Launcher`)
    }
    await api.play(id, quick); running.add(id)
  } finally { if (!running.has(id)) delete status[id]; playButton() }
}
$('#del').onclick = () => confirm(`Delete profile "${cur.name}" and its downloaded mods?\nFiles already deployed stay in the target folder.`)
  && run(async () => { await api.deleteProfile(cur.id); cur = null; await refresh() })
document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => b.closest('dialog').close())

// Share
$('#share').onclick = () => run(async () => {
  $('#code').value = await api.exportCode(cur.id)
  $('#invite').value = LINK + 'import/' + $('#code').value
  // Followed pack: pass on the owner's link; only the owner can publish changes.
  const gid = cur.follow?.gist || cur.publish
  $('#live').value = gid ? LINK + 'follow/' + gid : ''
  $('#makeLive').hidden = !!cur.follow; $('#liveNote').textContent = cur.follow ? `Only ${cur.follow.owner || 'the owner'} can change this pack. Friends you send this link follow them too.`
    : cur.publish ? 'Mod changes reach your friends automatically.' : ''
  $('#makeLive').lastChild.textContent = cur.publish ? ' Update' : ' Publish'; $('[data-copy=live]').hidden = !gid; profileLink()
  $('#r2code').value = ''; $('[data-copy=r2code]').hidden = true; $('#makeR2').hidden = false
  $('.tsOnly').hidden = cur.type !== 'thunderstore'
  $('#shareDlg').showModal(); $('#code').select()
})
$('#shareDlg').addEventListener('click', e => {
  const b = e.target.closest('[data-copy]'); if (!b) return
  navigator.clipboard.writeText($('#' + b.dataset.copy).value).then(() => toast('Copied — paste it to your friends'))
})
$('#makeLive').onclick = async () => {
  const b = $('#makeLive'); b.disabled = true
  const np = await run(() => api.publish(cur.id)); b.disabled = false
  if (!np) return
  setProfile(np); $('#liveNote').textContent = 'Mod changes reach your friends automatically.'; $('#live').value = LINK + 'follow/' + cur.publish; $('[data-copy=live]').hidden = false; b.lastChild.textContent = ' Update'; profileLink()
  toast('Live share updated — friends see a Sync button')
}
const profileLink = () => { const a = $('#myPage'); a.hidden = !cur.publishUser; a.dataset.href = SITE + '#u/' + cur.publishUser }
$('#makeR2').onclick = async () => {
  const b = $('#makeR2'); b.disabled = true
  const key = await run(() => api.exportR2(cur.id)); b.disabled = false
  if (key) $('#r2code').value = key, b.hidden = true, $('[data-copy=r2code]').hidden = false
}
$('#saveFile').onclick = async () => {
  const file = await api.saveFile(`${cur.name.replace(/[^\w -]/g, '')}.mmpack`); if (!file) return
  const n = await run(() => api.exportFile(cur.id, file))
  if (n != null) toast(`Saved with ${n} config file${n === 1 ? '' : 's'}`)
}

// Settings (+ live preview of appearance; Cancel reverts)
const LOOK = { theme: 'midnight', accent: '#5865f2', density: 'comfy', scale: 100, motion: true, descs: true }
let look = { ...LOOK }, lookSaved = true
function applyLook(l) {
  const r = document.documentElement
  Object.assign(r.dataset, { theme: l.theme, density: l.density, motion: l.motion ? 'on' : 'off', descs: l.descs ? 'on' : 'off' })
  r.style.setProperty('--accent', l.accent)
  document.body.style.zoom = l.scale / 100
  const cs = getComputedStyle(r); api.titlebar?.(cs.getPropertyValue('--rail').trim(), cs.getPropertyValue('--muted').trim()).catch?.(() => {})
}
const lookFrom = f => ({ theme: f.elements.theme.value || 'midnight', accent: f.elements.accent.value || $('#accentPick').value, density: f.elements.density.value || 'comfy',
  scale: +f.elements.scale.value || 100, motion: f.elements.motion.checked, descs: f.elements.descs.checked })
async function openSettings(section = 'appearance') {
  const s = await api.getSettings(), f = $('#settingsForm'), el = f.elements
  el.curseforgeKey.value = s.curseforgeKey || ''; el.nexusKey.value = s.nexusKey || ''; el.nxmHandler.checked = !!s.nxmHandler
  el.msClientId.value = s.msClientId || ''; el.prismPath.value = s.prismPath || ''; el.launcher.value = s.launcher || 'official'; el.customCmd.value = s.customCmd || ''; el.autoStart.checked = !!s.autoStart; el.updateMode.value = s.updateMode || (s.autoUpdate === false ? 'manual' : 'auto'); el.hardlink.checked = s.deployMode === 'hardlink'; el.rememberLast.checked = s.rememberLast !== false
  el.githubToken.value = s.githubToken || ''; el.modrinthToken.value = s.modrinthToken || ''; el.maxMem.value = s.launch?.maxMem || ''
  el.theme.value = look.theme; el.density.value = look.density; el.scale.value = look.scale; el.motion.checked = look.motion; el.descs.checked = look.descs
  el.accent.value = look.accent; $('#accentPick').value = look.accent; $('#scaleOut').textContent = look.scale + '%'
  $('#login').hidden = true; showAccounts(); showPlayit(); lookSaved = false
  setSection(section); $('#settingsDlg').showModal(); if (section === 'setup') showSetup()
}
const setSection = sec => {
  document.querySelectorAll('.setnav [data-sec]').forEach(b => b.classList.toggle('on', b.dataset.sec === sec))
  document.querySelectorAll('.setbody section').forEach(x => x.hidden = x.dataset.sec !== sec)
}
$('.setnav').onclick = e => { const b = e.target.closest('[data-sec]'); if (b) setSection(b.dataset.sec), b.dataset.sec === 'setup' && showSetup() }
$('#settingsForm').addEventListener('input', e => {
  if (e.target.id === 'accentPick') $('#settingsForm').elements.accent.forEach(r => r.checked = false)
  if (e.target.closest('[data-sec=appearance]')) { const l = lookFrom($('#settingsForm')); $('#scaleOut').textContent = l.scale + '%'; applyLook(l) }
})
$('#settingsDlg').addEventListener('close', () => { if (!lookSaved) applyLook(look) })
$('#settingsForm').onsubmit = async e => {
  e.preventDefault()
  const f = e.target, el = f.elements, l = lookFrom(f)
  if (await run(() => api.saveSettings({ curseforgeKey: el.curseforgeKey.value.trim(), nexusKey: el.nexusKey.value.trim(), nxmHandler: el.nxmHandler.checked,
    msClientId: el.msClientId.value.trim(), prismPath: el.prismPath.value.trim(), launcher: el.launcher.value, customCmd: el.customCmd.value.trim(), autoStart: el.autoStart.checked, updateMode: el.updateMode.value, deployMode: el.hardlink.checked ? 'hardlink' : 'copy', rememberLast: el.rememberLast.checked,
    githubToken: el.githubToken.value.trim(), modrinthToken: el.modrinthToken.value.trim(), launch: { maxMem: el.maxMem.value }, ...l }))) {
    look = l; lookSaved = true; applyLook(look); $('#settingsDlg').close(); toast('Settings saved'); Object.keys(gameCache).forEach(k => delete gameCache[k]); searchCache.clear()
  }
}

// New profile dialog
const newType = () => $('#newForm').elements.type.value
async function showGames() {
  const t = newType(), text = $('#gameQ').value.trim()
  if (!PICK_TYPES.includes(t)) return
  const local = t === 'thunderstore' || t === 'curseforge'
  let list = local ? gameCache[t] : null
  if (!list) {
    $('#games').innerHTML = t === 'gamebanana' && text.length < 2 ? '<p class="muted">Type a game name to search GameBanana</p>' : '<p class="muted">Loading games…</p>'
    if (t === 'gamebanana' && text.length < 2) return
    list = await run(() => api.games(t, local ? '' : text))
    if (newType() !== t) return
    if (!list) return $('#games').innerHTML = `<p class="muted">${t === 'curseforge' ? 'Add your CurseForge API key in Settings first.' : 'Could not load games.'}</p>`
    if (local) gameCache[t] = list
  }
  if (local) list = list.filter(g => g.name.toLowerCase().includes(text.toLowerCase()))
  $('#games').innerHTML = list.map(g =>
    `<button type="button" class="game ${g.wide ? 'wide' : ''} ${g.id === picked?.id ? 'on' : ''}" data-id="${esc(g.id)}"><img src="${esc(g.cover || g.icon)}" alt="" loading="lazy"><span>${esc(g.name)}</span></button>`
  ).join('') || '<p class="muted">No games found</p>'
  $('#games').list = list
}
$('#gameQ').oninput = () => { clearTimeout(timer); timer = setTimeout(showGames, newType() === 'thunderstore' || newType() === 'curseforge' ? 0 : 350) }
$('#newForm').onchange = e => { if (e.target.name === 'type') picked = null, $('#gameQ').value = '', showGames() }
$('#games').onclick = e => {
  const b = e.target.closest('.game'); if (!b) return
  picked = $('#games').list.find(g => g.id === b.dataset.id)
  document.querySelectorAll('.game').forEach(g => g.classList.toggle('on', g === b))
}
async function openNew(mode = 'thunderstore') {
  $('#newForm').reset(); picked = null; $('#impPreview').hidden = true
  $(`[name=type][value=${mode}]`).checked = true
  $('#newDlg').showModal(); showGames()
  if (!$('#vers').options.length) loadVersions()
}
$('#start').onclick = () => openNew()
$('#startImport').onclick = () => openNew('import')

// Starter mod sets (Modrinth slugs) for new Minecraft profiles; mods with no build for that version are skipped.
const TEMPLATES = {
  perf: { fabric: ['sodium', 'lithium', 'ferrite-core', 'entityculling', 'immediatelyfast', 'modernfix'], quilt: ['sodium', 'lithium', 'ferrite-core', 'entityculling', 'modernfix'],
    forge: ['embeddium', 'ferrite-core', 'entityculling', 'modernfix'], neoforge: ['embeddium', 'ferrite-core', 'entityculling', 'modernfix'] },
  plus: { all: ['appleskin', 'jade', 'mouse-tweaks', 'xaeros-minimap'], fabric: ['modmenu'], quilt: ['modmenu'] },
}
async function addTemplate(pid, t, loader) {
  const slugs = [...(TEMPLATES.perf[loader] || []), ...(t === 'plus' ? [...TEMPLATES.plus.all, ...(TEMPLATES.plus[loader] || [])] : [])]
  let ok = 0
  for (const [i, s] of slugs.entries()) {
    toast(`Adding starter mods ${i + 1}/${slugs.length}…`)
    const p = await api.install(pid, 'modrinth', s).catch(() => null)
    if (p) ok++, setProfile(p.profile || p)
  }
  if (cur?.id === pid) render()
  toast(`Added ${ok} starter mods${ok < slugs.length ? ` (${slugs.length - ok} have no build for this version)` : ''}`)
}
async function created(res) {
  $('#newDlg').close(); tab = res.profile ? 'installed' : 'browse'; $('#q').value = ''
  if (res.failed?.length) toast(`Imported, but ${res.failed.length} failed: ${res.failed.join('; ')}`, true)
  else if (res.profile) toast(`Imported ${res.profile.mods.length} mods${res.profile.extra?.length ? ` + ${res.profile.extra.length} configs` : ''}`)
  const p = res.profile || res
  await refresh(p.id)
  if (!p.target && window.platform === 'win32') {
    const f = await api.findGame(p.id).catch(() => null)
    if (f) setProfile(f), render(), toast(`Found game folder: ${f.target}`)
  }
}
async function importWith(btn, fn) {
  const html = btn.innerHTML; btn.disabled = true; btn.textContent = 'Importing…'
  const res = await run(fn)
  btn.disabled = false; btn.innerHTML = html
  if (res) created(res)
}
// Buttons are looked up directly: e.currentTarget is null after an await.
$('#importFile').onclick = async () => {
  const file = await api.openFile(['mmpack', 'mrpack']); if (!file) return
  const name = $('#newForm').elements.name.value.trim()
  importWith($('#importFile'), () => /\.mrpack$/i.test(file) ? api.importInstance(file, name) : api.importFile(file, name))
}
$('#importFolder').onclick = async () => {
  const dir = await api.pickFolder(); if (dir) importWith($('#importFolder'), () => api.importInstance(dir, $('#newForm').elements.name.value.trim()))
}
$('#newForm').onsubmit = async e => {
  e.preventDefault()
  const f = Object.fromEntries(new FormData(e.target)), btn = $('#createBtn'), name = f.name.trim()
  if (PICK_TYPES.includes(f.type) && !picked) return toast('Pick a game first', true)
  if (f.type === 'import' && !f.code.trim()) return toast('Paste a share code first', true)
  if (f.type === 'recomp') return run(async () => {
    const c = await api.lxSave({ enabled: true, name: name || 'GTA 6' })
    lxOn = true; lxName = c.name; lxView = true; lxEdit = null; tab = 'lxprojects'; $('#newDlg').close(); render()
  })
  btn.disabled = true; btn.textContent = f.type === 'import' ? 'Importing mods…' : 'Creating…'
  const into = f.type === 'import' && $('#impInto')?.value
  const res = await run(() => into ? api.sync(into, f.code, { remove: !!$('#impRemove')?.checked })
    : f.type === 'import' ? api.importCode(f.code, name, cur?.type === 'thunderstore' ? cur.game : null)
    : f.type === 'terraria' ? api.createProfile({ name: name || 'Terraria', type: 'terraria', game: 'terraria', gameName: 'Terraria', icon: TERRARIA.icon, banner: TERRARIA.banner })
    : f.type === 'modrinth' ? api.createProfile({ name: name || `Minecraft ${f.version}`, type: 'modrinth', mc: { version: f.version, loader: f.loader } })
    : api.createProfile({ name: name || picked.name, type: f.type, game: picked.id, gameId: picked.gameId, gameName: picked.name,
      icon: picked.icon || picked.cover, banner: picked.banner || picked.cover }))
  btn.disabled = false; btn.textContent = 'Create'
  if (res) created(res)
  if (res && f.type === 'modrinth' && f.template && f.loader !== 'vanilla') addTemplate(res.id, f.template, f.loader)
}

// App self-update: main process downloads it, we offer a restart.
// Bar in the title bar: download progress, then "Restart to update" + "What's new" (the GitHub release notes, shown as plain text).
window.onUpdateReady?.((v, notes) => {
  const b = $('#updBar'); b.hidden = false; b.disabled = false; b.dataset.ready = 1
  b.querySelector('span').textContent = `Restart to update to ${v}`
  b.onclick = () => api.installUpdate()
  // Block tags to line breaks, then text only (DOMParser only parses: nothing in the notes runs).
  const html = (notes || '').replace(/<li[^>]*>/gi, '• ').replace(/<\/(p|h\d|li|ul|ol|div)>|<br\s*\/?>/gi, '\n')
  const text = new DOMParser().parseFromString(html, 'text/html').body.textContent.replace(/\n{3,}/g, '\n\n').trim()
  $('#updNotes').hidden = !text
  $('#updNotes').onclick = () => { $('#notesTitle').textContent = `What's new in ${v}`; $('#notesText').textContent = text; $('#notesDlg').showModal() }
})
const appUpdateProgress = d => {
  const b = $('#updBar'); if (b.dataset.ready) return
  b.hidden = false
  if (d.available) { b.disabled = false; b.querySelector('span').textContent = `Update ${d.available} available — download`; b.onclick = () => { b.onclick = null; api.downloadUpdate(); appUpdateProgress({ percent: 0 }) }; return }
  b.disabled = true; b.querySelector('span').textContent = `Downloading update · ${d.percent}%`
}
// After an update: say so once.
api.appVersion?.().then(v => {
  let last; try { last = localStorage.lastVersion; localStorage.lastVersion = v } catch {}
  if (last && last !== v) toast(`Updated to ${v}`)
  $('#appVer').textContent = `Version ${v}`
}).catch(() => {})
$('#checkUpd2').onclick = () => run(async () => {
  const r = await api.checkUpdate()
  toast(r.dev ? 'Updates work in the installed app only' : r.latest && r.latest !== r.current ? `Update ${r.latest} found — see the bar at the top` : `You have the latest version (${r.current})`)
})
// Nexus "Mod Manager Download" links
window.onNxm?.(link => run(async () => {
  toast('Downloading from Nexus Mods…')
  const p = await fm(await api.handleNxm(link, cur?.id))
  warn(p); await refresh(p.id); toast(`Installed from Nexus: ${p.mods.at(-1)?.name}`)
}))

// ---- Minecraft launcher UI ----
function playButton() {
  const b = $('#play'), id = cur?.id
  if (!b || !cur) return
  const st = status[id], isRun = running.has(id)
  b.classList.toggle('stop', isRun)
  // Preparing: progress fill + "Cancel" on hover/click; running: Stop.
  const m = st?.match(/(\d+)\/(\d+)/), pct = m ? Math.round(m[1] / m[2] * 100) : null
  b.disabled = false; b.classList.toggle('prep', !!st && !isRun)
  b.style.setProperty('--pct', pct == null ? '0%' : pct + '%')
  b.title = isRun ? 'Stop the game (Ctrl+P)' : st ? 'Cancel' : 'Deploy and start the game (Ctrl+P)'
  b.innerHTML = isRun ? `${ic('stop')} Stop` : st ? `${ic('refresh', 'i spin')} <span id="pplay">${esc(st)}${pct == null ? '' : ` · ${pct}%`}</span><span class="cancel">${ic('x')} Cancel</span>` : `${ic('play')} Play`
}
window.onEvent?.((e, d) => {
  if (e === 'status') {
    if (d.text === null) {
      running.delete(d.pid); delete status[d.pid]
      if (d.exit) crashHelp(d.pid, d.exit)
      api.listProfiles().then(ps => { ps.forEach(setProfile); if (cur?.id === d.pid) $('#pmeta').textContent = meta(cur) })
    } else if (d.text === 'Running') running.add(d.pid), delete status[d.pid]
    else status[d.pid] = d.text
    if (cur?.id === d.pid) playButton()
    document.querySelector(`#rail [data-id="${d.pid}"]`)?.classList.toggle('playing', running.has(d.pid))
  }
  if (e === 'dl') dlUpdate(d)
  if (e === 'published') toast('Your friends got the updated mod list')
  if (e === 'toast') toast(d.text, d.error)
  if (e === 'appUpdate') appUpdateProgress(d)
  if ((e === 'slog' || e === 'sstatus') && cur?.id === d.pid && tab === 'server') e === 'slog' ? appendTo($('#slog'), d.line) : srvTab !== 'settings' && showServer()
  if (e === 'log' && cur?.id === d.pid && tab === 'logs' && $('#logsel')?.value === 'live') appendLog(d.line)
})

const logClass = l => /ERROR|Exception|FATAL/.test(l) ? 'e' : /WARN/.test(l) ? 'w' : ''
function appendLog(line) {
  const v = $('#logview'), stick = v.scrollTop + v.clientHeight >= v.scrollHeight - 30
  const div = document.createElement('div'); div.textContent = line; div.className = logClass(line); v.append(div)
  if (v.childElementCount > 5000) v.firstChild.remove()
  if (stick) v.scrollTop = v.scrollHeight
}
async function showLogs() {
  const files = await run(() => api.logFiles(cur.id)) || []
  $('#list').innerHTML = `<div class="logbar"><select id="logsel"><option value="live">Live game output</option>${files.map(f => `<option value="${esc(f.rel)}">${esc(f.rel)} — ${new Date(f.time).toLocaleString()}</option>`).join('')}</select>
    <button id="logcopy">${ic('copy')} Copy</button><button id="logshare">${ic('share')} Share</button><button id="logdir">${ic('folder')} Folder</button></div><div id="logview"></div>`
  const load = async () => {
    const v = $('#logview'); v.textContent = ''
    const sel = $('#logsel').value
    const lines = sel === 'live' ? await api.getLog(cur.id) : (await run(() => api.readLog(cur.id, sel)) || '').split(/\r?\n/)
    v.innerHTML = lines.map(l => `<div class="${logClass(l)}">${esc(l)}</div>`).join('') || '<div>No output yet. Press Play.</div>'
    v.scrollTop = v.scrollHeight
  }
  $('#logsel').onchange = load
  $('#logcopy').onclick = () => navigator.clipboard.writeText($('#logview').innerText).then(() => toast('Log copied'))
  $('#logdir').onclick = () => api.openProfileFolder(cur.id, 'logs')
  $('#logshare').onclick = async () => {
    if (!confirm('Upload the game log to mclo.gs (public link)? Logs can contain your username and paths.')) return
    const url = await run(() => api.shareLog(cur.id, 'game')); if (url) navigator.clipboard.writeText(url), toast(`Log link copied: ${url}`)
  }
  load()
}

async function showWorlds() {
  const id = cur.id, w = await run(() => api.worlds(id))
  if (!w || cur.id !== id || tab !== 'worlds') return
  $('#list').innerHTML = `<div class="section"><h4>SINGLEPLAYER</h4><div class="wgrid">${w.worlds.map(x => `<div class="world">
      ${x.icon ? `<img src="${x.icon}" alt="">` : '<div class="noicon"></div>'}<div><b>${esc(x.name)}</b><small>${new Date(x.modified).toLocaleDateString()}</small></div>
      <button data-world="${esc(x.name)}" title="Play this world">${ic('play')}</button></div>`).join('') || '<p class="muted">No worlds yet.</p>'}</div></div>
    <div class="section"><h4>SERVERS</h4><div class="wgrid">${w.servers.map(x => `<div class="world"><div class="noicon"></div><div><b>${esc(x.name)}</b><small>${esc(x.ip)}</small></div>
      <button data-server="${esc(x.ip)}" title="Join">${ic('play')}</button><button class="icon" data-rmserver="${esc(x.ip)}" title="Remove">${ic('trash')}</button></div>`).join('') || '<p class="muted">No servers saved.</p>'}</div>
    <div class="row addsrv"><input name="sname" placeholder="Name (optional)" maxlength="40"><input name="sip" placeholder="Server address, e.g. play.example.com" maxlength="120"><button id="addServer">${ic('plus')} Add server</button></div>
    <p class="muted small">Quick join needs Minecraft 1.20+ for worlds. With the official launcher, the game opens and you pick the server under Multiplayer.</p></div>
    <button id="savesdir">${ic('folder')} Open saves folder</button>`
}

async function showOptions() {
  const o = cur.launch || {}
  if (cur.type !== 'modrinth') return $('#list').innerHTML = `<form class="opts" id="optsForm">
    <label>STEAM LAUNCH ARGUMENTS <span class="muted small">(used by Play)</span><input name="args" value="${esc(o.args || '')}" placeholder="-windowed -nosplash"></label>
    <div class="row"><button class="primary">${ic('check')} Save options</button><button type="button" id="playVanilla">${ic('play')} Play without mods</button></div>
    <p class="muted small">"Play without mods" removes this profile's files from the game folder and starts the game. Your mod list is kept; press Deploy or Play to bring the mods back.</p></form>` + await gameExtras()
  const javas = await api.javaList().catch(() => [])
  $('#list').innerHTML = `<form class="opts" id="optsForm">
    <div class="row"><label>MAX MEMORY (MB)<input name="maxMem" type="number" min="512" step="512" value="${o.maxMem || ''}" placeholder="Default"></label>
      <label>MIN MEMORY (MB)<input name="minMem" type="number" min="256" step="256" value="${o.minMem || ''}" placeholder="512"></label></div>
    <div class="row"><label>WINDOW WIDTH<input name="width" type="number" value="${o.width || ''}" placeholder="854"></label>
      <label>WINDOW HEIGHT<input name="height" type="number" value="${o.height || ''}" placeholder="480"></label></div>
    <label class="check"><input type="checkbox" name="fullscreen" class="switch" ${o.fullscreen ? 'checked' : ''}> Start in fullscreen</label>
    <label>JAVA <select id="javaPick"><option value="">Automatic (recommended)</option>${javas.map(j => `<option value="${esc(j.path)}" ${o.java === j.path ? 'selected' : ''}>${esc(j.label)} — ${esc(j.path)}</option>`).join('')}<option value="custom" ${o.java && !javas.some(j => j.path === o.java) ? 'selected' : ''}>Custom path…</option></select>
      <input name="java" value="${esc(o.java || '')}" placeholder="Path to java / javaw.exe" ${o.java && !javas.some(j => j.path === o.java) ? '' : 'hidden'}></label>
    <label>JVM ARGUMENTS<input name="jvmArgs" value="${esc(o.jvmArgs || '')}" placeholder="-XX:+UseG1GC"></label>
    <label>ENVIRONMENT VARIABLES <span class="muted small">(KEY=value per line)</span><textarea name="env" rows="3">${esc(o.env || '')}</textarea></label>
    <label>PRE-LAUNCH COMMAND<input name="preLaunch" value="${esc(o.preLaunch || '')}"></label>
    <label>WRAPPER COMMAND<input name="wrapper" value="${esc(o.wrapper || '')}" placeholder="e.g. gamemoderun"></label>
    <label>POST-EXIT COMMAND<input name="postExit" value="${esc(o.postExit || '')}"></label>
    <div class="row"><button class="primary">${ic('check')} Save options</button><button type="button" id="playVanilla">${ic('play')} Play without mods</button></div>
    <h4 class="muted">INSTANCE</h4>
    <div class="row"><button type="button" id="optRepair">${ic('wrench')} Repair game files</button><button type="button" id="optExport">${ic('file')} Export .mrpack</button>
      <button type="button" id="optDup">${ic('copy')} Duplicate</button><button type="button" id="optDir">${ic('folder')} Open folder</button></div>
    <p class="muted small">Loader: ${esc(cur.mc.loader)} ${esc(cur.mc.loaderVersion || '(latest on first launch)')} · Game folder: ${esc(cur.target)}</p></form>`
}

$('#list').addEventListener('click', async e => {
  const t = e.target.closest('button'); if (!t) return
  const id = cur.id
  if (t.dataset.world || t.dataset.server) {
    if (running.has(id) || status[id]) return toast('Already running', true)
    return run(() => startGame(id, t.dataset.world ? { world: t.dataset.world } : { server: t.dataset.server }))
  }
  if (t.dataset.rmserver) { const w = await run(() => api.removeServer(id, t.dataset.rmserver)); if (w) showWorlds(); return }
  if (t.id === 'addServer') {
    const f = t.closest('.section'), name = f.querySelector('[name=sname]').value.trim(), ip = f.querySelector('[name=sip]').value.trim()
    if (!ip) return toast('Type the server address', true)
    if (await run(() => api.addServer(id, name || ip, ip))) showWorlds(), toast('Server saved — it also shows in Minecraft\'s Multiplayer list')
    return
  }
  if (t.id === 'savesdir') api.openProfileFolder(id, 'saves')
  if (t.id === 'optRepair') { t.disabled = true; await run(() => api.repair(id)) && toast('Game files repaired'); t.disabled = false }
  if (t.id === 'optExport') { const f = await api.saveFile(`${cur.name.replace(/[^\w -]/g, '')}.mrpack`, 'mrpack'); if (f) { const n = await run(() => api.exportMrpack(id, f)); if (n != null) toast(`Exported (${n} Modrinth downloads, rest bundled)`) } }
  if (t.id === 'optDup') { const p = await run(() => api.duplicate(id)); if (p) await refresh(p.id), toast('Duplicated') }
  if (t.id === 'optDir') api.openProfileFolder(id)
  if (t.id === 'playVanilla') run(async () => {
    if (cur.type !== 'modrinth') { await api.launch(id, { vanilla: true }); return toast('Starting the game without mods') }
    status[id] = 'Preparing…'; playButton()
    try { await api.play(id, {}, { vanilla: true }); running.add(id) } finally { if (!running.has(id)) delete status[id]; playButton() }
  })
  if (t.id === 'srvStart') serverStart(t)
  if (t.id === 'srvStop') api.serverStop(id)
  if (t.id === 'srvShare') { t.disabled = true; const a = await run(() => api.serverShare(id)); t.disabled = false; if (a) showServer() }
  if (t.id === 'srvInvite') { const c = await run(() => api.inviteCode(id)); if (c) navigator.clipboard.writeText(LINK + 'import/' + c).then(() => toast('Invite link copied — friends get the mods and the server in their list')) }
  if (t.dataset.copyText) navigator.clipboard.writeText(t.dataset.copyText).then(() => toast('Copied'))
})
$('#list').addEventListener('submit', async e => {
  if (e.target.id !== 'optsForm') return
  e.preventDefault()
  const f = Object.fromEntries(new FormData(e.target)); if (e.target.fullscreen) f.fullscreen = e.target.fullscreen.checked
  if ($('#javaPick') && $('#javaPick').value !== 'custom') f.java = $('#javaPick').value
  const p = await run(() => api.updateProfile(cur.id, { launch: f })); if (p) setProfile(p), toast('Options saved')
})


// Local files: button + drag and drop
const addPaths = paths => paths.length && run(async () => { let p; for (const f of paths) p = await fm(await api.addLocal(cur.id, [f])); setProfile(p); tab = 'installed'; render(); toast(`Added ${paths.length} file(s)`) })
$('#addFiles').onclick = () => $('#fileInput').click()
$('#fileInput').onchange = e => { addPaths([...e.target.files].map(filePath)); e.target.value = '' }
let dragDepth = 0
document.addEventListener('dragenter', e => { if (cur && e.dataTransfer.types.includes('Files')) dragDepth++, $('#drop').hidden = false })
document.addEventListener('dragleave', () => { if (--dragDepth <= 0) dragDepth = 0, $('#drop').hidden = true })
document.addEventListener('dragover', e => e.preventDefault())
document.addEventListener('drop', e => { e.preventDefault(); dragDepth = 0; $('#drop').hidden = true; if (cur) addPaths([...e.dataTransfer.files].map(filePath)) })

// Rail context menu
let ctxId = null
$('#rail').oncontextmenu = e => {
  const b = e.target.closest('[data-id]'); if (!b) return
  e.preventDefault(); ctxId = b.dataset.id
  const m = $('#ctx'); m.hidden = false; m.style.left = e.clientX + 'px'; m.style.top = Math.min(e.clientY, innerHeight - 220) + 'px'
}
document.addEventListener('click', e => { if (!e.target.closest('#ctx')) $('#ctx').hidden = true })
const ask = (title, value = '') => new Promise(res => {
  const d = $('#askDlg'); $('#askTitle').textContent = title; $('#askInput').value = value
  $('#askForm').onsubmit = e => { e.preventDefault(); d.close(); res($('#askInput').value) }
  d.onclose = () => res(null); d.showModal(); $('#askInput').select()
})
$('#ctx').onclick = async e => {
  const a = e.target.closest('[data-ctx]')?.dataset.ctx; if (!a) return
  $('#ctx').hidden = true
  const p = profiles.find(p => p.id === ctxId); if (!p) return
  if (a === 'duplicate') { const d = await run(() => api.duplicate(p.id)); if (d) refresh(d.id) }
  if (a === 'icon') { $('#iconInput').dataset.id = p.id; $('#iconInput').click() }
  if (a === 'group') { const g = await ask('Group name (empty = none)', p.group || ''); if (g !== null) { await run(() => api.updateProfile(p.id, { group: g.trim() })); refresh() } }
  if (a === 'folder') api.openProfileFolder(p.id, p.type === 'modrinth' ? '' : 'files')
  if (a === 'delete' && confirm(`Delete profile "${p.name}"?`)) { await run(() => api.deleteProfile(p.id)); if (cur?.id === p.id) cur = null; refresh() }
}
$('#iconInput').onchange = async e => {
  const file = e.target.files[0], id = e.target.dataset.id; e.target.value = ''
  if (!file) return
  const img = await createImageBitmap(file), c = document.createElement('canvas'); c.width = c.height = 128
  const s = Math.max(128 / img.width, 128 / img.height)
  c.getContext('2d').drawImage(img, (128 - img.width * s) / 2, (128 - img.height * s) / 2, img.width * s, img.height * s)
  const p = await run(() => api.updateProfile(id, { icon: c.toDataURL('image/png') })); if (p) setProfile(p), render()
}

// Accounts
async function showAccounts() {
  const list = await api.accounts()
  $('#accts').innerHTML = list.map(a => `<div class="acct ${a.active ? 'on' : ''}"><img src="https://mc-heads.net/avatar/${esc(a.uuid)}/32" alt=""><b>${esc(a.name)}</b>
    ${a.active ? '<span class="tag">Active</span>' : `<button type="button" data-use="${esc(a.uuid)}">Use</button>`}
    <button type="button" class="icon" data-rm="${esc(a.uuid)}" title="Remove">${ic('trash')}</button></div>`).join('') || '<p class="muted small">No accounts yet.</p>'
}
$('#accts').onclick = async e => {
  const u = e.target.closest('[data-use]')?.dataset.use, r = e.target.closest('[data-rm]')?.dataset.rm
  if (u) await api.setActiveAccount(u)
  if (r && confirm('Remove this account?')) await api.removeAccount(r)
  showAccounts()
}
$('#addAcct').onclick = () => run(async () => {
  const f = $('#settingsForm')
  if (f.msClientId.value.trim()) await api.saveSettings({ msClientId: f.msClientId.value.trim() })
  const c = await api.loginStart()
  $('#login').hidden = false; $('#loginCode').value = c.code; $('#loginUrl').textContent = c.url; $('#loginUrl').dataset.href = c.url
  api.openExternal(c.url)
  try { const a = await api.loginFinish(); toast(`Signed in as ${a.name}`); showAccounts() } finally { $('#login').hidden = true }
})
$('[data-copy-login]').onclick = () => navigator.clipboard.writeText($('#loginCode').value).then(() => toast('Code copied'))

// Minecraft versions (+ snapshots)
async function loadVersions() {
  $('#vers').innerHTML = ((await run(() => api.mcVersions($('#snapshots').checked))) || []).map(v => `<option>${esc(v)}</option>`).join('')
}
$('#snapshots').onchange = loadVersions

api.running?.().then(r => { running = new Set(r); playButton() })

// ---- playit.gg account ----
async function showPlayit() {
  const st = await api.playitStatus()
  $('#pitBox').innerHTML = st.linked
    ? `<div class="acct on"><span class="dot on"></span><b>playit.gg linked</b>
        <label class="check small"><input type="checkbox" class="switch" id="pitUse" ${st.tunnel !== 'bore' ? 'checked' : ''}> Use for public addresses</label>
        <button type="button" class="danger" id="pitUnlink">Unlink</button></div>`
    : `<button type="button" id="pitLink" class="primary">${ic('globe')} Link playit.gg account (free)</button><div id="pitWait" class="muted small"></div>`
}
$('#pitBox').addEventListener('click', async e => {
  const t = e.target.closest('button'); if (!t) return
  if (t.id === 'pitUnlink' && confirm('Unlink playit.gg? Servers fall back to bore.pub.')) { await run(() => api.playitUnlink()); return showPlayit() }
  if (t.id === 'pitLink') run(async () => {
    t.disabled = true
    const c = await api.playitLinkStart()
    $('#pitWait').innerHTML = `Approve Mod Manager on the playit.gg page that opened (<a data-href="${esc(c.url)}">${esc(c.url)}</a>). Waiting…`
    api.openExternal(c.url)
    try { await api.playitLinkFinish(c.code); toast('playit.gg linked') } finally { showPlayit() }
  })
})
$('#pitBox').addEventListener('change', e => { if (e.target.id === 'pitUse') run(() => api.saveSettings({ tunnel: e.target.checked ? 'auto' : 'bore' })) })

// ---- Changelogs ----
async function showChanges(src, id, name, vid, version) {
  $('#chgTitle').textContent = `${name} ${version || ''}`
  $('#chgBody').innerHTML = '<div class="skel"></div>'
  $('#chgDlg').showModal()
  const c = await api.changelog(cur.id, src, id, vid).catch(() => null)
  $('#chgBody').innerHTML = !c ? '<p class="muted">No changelog for this version. Open the mod page for details.</p>'
    : DOMPurify.sanitize(c.html || marked.parse(c), { FORBID_ATTR: ['style'], FORBID_TAGS: ['style', 'form', 'input', 'button'] })
}

// ---- History (snapshots) ----
async function showHistory() {
  const list = await api.snapshots(cur.id)
  $('#histList').innerHTML = list.map(s => `<div class="acct"><b>${esc(s.reason)}</b><span class="muted small">${s.count} mods · ${new Date(s.time).toLocaleString()}</span>
    <button data-snap="${s.id}">Restore</button></div>`).join('') || '<p class="muted center">No snapshots yet.</p>'
}
$('#history').onclick = () => { showHistory(); $('#histDlg').showModal() }
$('#snapNow').onclick = async () => { if (await run(() => api.snapshot(cur.id, 'Manual'))) toast('Snapshot saved'); showHistory() }
$('#histList').onclick = async e => {
  const id = e.target.closest('[data-snap]')?.dataset.snap
  if (!id || !confirm('Roll the mod list back to this snapshot? A snapshot of the current list is saved first.')) return
  e.target.disabled = true; e.target.textContent = 'Restoring…'
  const r = await run(() => api.restoreSnapshot(cur.id, id))
  if (r) { setProfile(r.profile); toast(r.failed.length ? `Restored, ${r.failed.length} failed` : 'Mod list restored', !!r.failed.length); render() }
  showHistory()
}

// ---- Favorites (per device; stored with the card so the list shows offline) ----
let favMode = false
const favKey = src => `${src}:${src === 'modrinth' || src === 'curseforge' && cur.type === 'modrinth' ? 'mc' : cur.game || cur.type}`
const favs = () => { try { return JSON.parse(localStorage.getItem('mm.favs')) || {} } catch { return {} } }
const isFav = (src, id) => !!favs()[favKey(src)]?.[id]
function toggleFav(src, el, id) {
  const all = favs(), k = favKey(src), bucket = all[k] ||= {}
  if (bucket[id]) delete bucket[id]
  else bucket[id] = { id, title: el.querySelector('b').textContent, author: el.querySelector('small')?.textContent.replace(/^by /, ''), desc: el.querySelector('p')?.textContent, icon: el.querySelector('img')?.src }
  try { localStorage.setItem('mm.favs', JSON.stringify(all)) } catch {}
}
const favList = () => Object.values(favs()[favKey(curSrc())] || {}).filter(m => !$('#q').value || m.title.toLowerCase().includes($('#q').value.toLowerCase()))
$('#favs').onclick = () => { favMode = !favMode; $('#favs').classList.toggle('on', favMode); search() }

// ---- Background update check: badges on the profile rail + one desktop notification ----
async function backgroundUpdates() {
  let total = 0
  for (const p of profiles) {
    if (!p.mods.some(m => m.src !== 'local') || p.follow) continue // followed packs get versions from the owner
    const r = await api.checkUpdates(p.id).catch(() => null)
    if (!r) continue
    updates[p.id] = r; total += Object.keys(r).length
  }
  const friends = []
  for (const p of profiles.filter(p => p.follow)) if ((await api.checkFollow(p.id).catch(() => null))?.changed) friends.push(p.name)
  if (friends.length) try { new Notification('Mod Manager', { body: `Your friend updated ${friends.join(', ')}. Open it and press Sync now.`, silent: true }) } catch {}
  render()
  if (total) try { new Notification('Mod Manager', { body: `${total} mod update${total === 1 ? '' : 's'} available`, silent: true }) } catch {}
}
setTimeout(() => backgroundUpdates(), 8000)
setInterval(() => backgroundUpdates(), 6 * 3600e3)

// ---- Setup checklist ----
async function showSetup() {
  $('#setupList').innerHTML = '<div class="skel"></div>'
  const s = await api.setupStatus()
  const items = [
    { ok: s.minecraftLauncher || s.msLogin || (s.launcher !== 'official' && s.launcherFound), need: true, title: 'Play Minecraft', why: s.msLogin ? 'Signed in with Microsoft: Play starts the game from this app.' : 'Play opens your instance in the official Minecraft Launcher (install it once from minecraft.net).',
      steps: ['Install the Minecraft Launcher and sign in once'], btn: ['Get the launcher', 'https://www.minecraft.net/download'] },
    { ok: s.launcher !== 'official' && s.launcherFound, title: 'Play through Prism Launcher or MultiMC (optional)', why: s.launcher === 'official' ? 'Play uses the official Minecraft Launcher. Pick Prism or MultiMC in Accounts to play in the background with no launcher window.' : 'The launcher picked in Accounts was not found. Install it or set its path.',
      steps: ['Install Prism Launcher and add your Microsoft account in it once', 'Accounts → Play with: Prism Launcher'], btn: ['Get Prism Launcher', 'https://prismlauncher.org/download/'], go: 'accounts' },
    { ok: s.msLogin, title: 'Start Minecraft directly from this app (optional)', why: 'Needs your own Microsoft app ID approved by Mojang. Until then Play uses the official launcher.',
      steps: ['portal.azure.com → App registrations → New: "Personal Microsoft accounts only"', 'Authentication → allow public client flows = Yes', 'Request Minecraft access at aka.ms/mce-reviewappid (takes days)', 'Paste the Application (client) ID in Accounts and press Add Microsoft account'], btn: ['Open Azure', 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade'], go: 'accounts' },
    { ok: s.playit, title: 'Stable server address + Bedrock/voice chat (optional)', why: 'Link a free playit.gg account. Without it servers use bore.pub (Java only).', steps: ['Press Link, approve in the browser'], go: 'accounts', goLabel: 'Link playit.gg' },
    { ok: s.curseforge, title: 'CurseForge mods (optional)', why: 'Free API key from CurseForge.', steps: ['Create a key at console.curseforge.com', 'Paste it in Mod sites'], btn: ['Get a key', 'https://console.curseforge.com/'], go: 'sites' },
    { ok: s.nexus, title: 'Nexus Mods downloads (optional)', why: 'Your personal Nexus API key.', steps: ['Nexus → Account → API access → copy key', 'Paste it in Mod sites'], btn: ['Open Nexus', 'https://www.nexusmods.com/users/myaccount?tab=api'], go: 'sites' },
    { ok: s.github, title: 'Live share for friends (optional)', why: 'A GitHub token with only "gist" access lets friends follow your mod list.', steps: ['Create the token', 'Paste it in Mod sites'], btn: ['Create token', 'https://github.com/settings/tokens/new?scopes=gist&description=Mod%20Manager'], go: 'sites' },
  ]
  const left = setupLeft = items.filter(i => i.need && !i.ok).length; render()
  $('#setupLeft').textContent = left || ''
  $('#setupList').innerHTML = items.map(i => `<div class="setup ${i.ok ? 'done' : i.need ? 'todo' : ''}">
    <span class="sdot">${i.ok ? ic('check') : i.ok === null ? ic('alert') : ''}</span>
    <div><b>${esc(i.title)}</b>${i.need && !i.ok ? ' <span class="tag upd">Needed</span>' : ''}<p class="muted small">${esc(i.why)}</p>
      ${i.ok ? '' : `<ol>${i.steps.map(x => `<li>${esc(x)}</li>`).join('')}</ol>`}</div>
    ${i.ok ? '' : `<div class="sbtns">${i.btn ? `<button type="button" class="primary" data-href="${esc(i.btn[1])}">${esc(i.btn[0])}</button>` : ''}${i.go ? `<button type="button" data-go="${i.go}">${esc(i.goLabel || 'Go there')}</button>` : ''}</div>`}</div>`).join('')
}
$('#setupList').onclick = e => { const g = e.target.closest('[data-go]')?.dataset.go; if (g) setSection(g), g === 'accounts' && showPlayit() }
$('#setupRecheck').onclick = showSetup
$('#startSetup').onclick = () => openSettings('setup')

// ---- Keyboard shortcuts + quick switcher ----
document.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey) || document.querySelector('dialog[open]:not(#quickDlg)')) return
  const k = e.key.toLowerCase()
  if (k === 'k') e.preventDefault(), openQuick()
  if (k === ',') e.preventDefault(), openSettings()
  if (!cur || lxView) return
  if (k === 'p' && !$('#play').disabled) { e.preventDefault(); $('#play').click() }
  if (k === 'f') { e.preventDefault(); if (tab !== 'browse') tab = 'browse', render(); $('#q').focus(); $('#q').select() }
  const tabsShown = [...document.querySelectorAll('#tabs [data-tab]')].filter(b => b.offsetParent)
  if (/^[1-9]$/.test(k) && tabsShown[k - 1]) e.preventDefault(), tabsShown[k - 1].click()
})
let quickSel = 0
function openQuick() { $('#quickQ').value = ''; quickSel = 0; drawQuick(); $('#quickDlg').showModal(); $('#quickQ').focus() }
const quickItems = () => profiles.filter(p => (p.name + ' ' + meta(p)).toLowerCase().includes($('#quickQ').value.toLowerCase()))
function drawQuick() {
  const list = quickItems(); quickSel = Math.min(quickSel, Math.max(0, list.length - 1))
  $('#quickList').innerHTML = list.map((p, i) => `<button class="${i === quickSel ? 'on' : ''}" data-qid="${p.id}"><span class="pfp">${avatar(p)}</span><b>${esc(p.name)}</b><small>${esc(meta(p))}</small></button>`).join('') || '<p class="muted">No profiles</p>'
}
const quickGo = id => { $('#quickDlg').close(); lxView = false; cur = profiles.find(p => p.id === id); tab = 'browse'; chips.clear(); render() }
$('#quickQ').oninput = () => { quickSel = 0; drawQuick() }
$('#quickQ').onkeydown = e => {
  const n = quickItems().length
  if (e.key === 'ArrowDown') e.preventDefault(), quickSel = (quickSel + 1) % Math.max(n, 1), drawQuick()
  if (e.key === 'ArrowUp') e.preventDefault(), quickSel = (quickSel - 1 + n) % Math.max(n, 1), drawQuick()
  if (e.key === 'Enter' && n) quickGo(quickItems()[quickSel].id)
}
$('#quickList').onclick = e => { const b = e.target.closest('[data-qid]'); if (b) quickGo(b.dataset.qid) }
$('#quickDlg').onclick = e => { if (e.target.id === 'quickDlg') $('#quickDlg').close() }

api.getSettings().then(s => {
  look = { ...LOOK, ...Object.fromEntries(Object.keys(LOOK).filter(k => s[k] !== undefined).map(k => [k, s[k]])) }
  if (!('accent' in s) && s.theme === 'dark') look.theme = 'midnight' // old default -> new darker default
  applyLook(look); remembering = s.rememberLast !== false
}).finally(() => refresh().then(() => { if (!$('#settingsDlg').open) api.setupStatus().then(s => { setupLeft = s.minecraftLauncher || s.msLogin || s.launcherFound ? 0 : 1; render() }).catch(() => {}) }))

// ---- Bulk actions, orphans, crash helper, download queue ----
async function bulkAction(kind) {
  const id = cur.id, ids = [...selected]
  if (kind === 'none') return selected.clear(), showInstalled()
  if (kind === 'remove' && !confirm(`Remove ${ids.length} mods?`)) return
  if (kind === 'remove' || kind === 'update') await api.snapshot(id, `Before ${kind === "remove" ? "removing" : "updating"} ${ids.length} mod${ids.length === 1 ? "" : "s"}`).catch(() => {})
  for (const mid of ids) {
    const p = await run(() => kind === 'update' ? api.update(id, mid) : kind === 'remove' ? api.uninstall(id, mid) : api.setDisabled(id, mid, kind === 'disable'))
    if (p) setProfile(p)
  }
  selected.clear(); if (cur?.id === id) updateBadges(), showInstalled()
  if (kind === 'remove') askOrphans()
}
async function askOrphans() {
  const id = cur.id, o = await api.orphans(id).catch(() => [])
  if (!o.length || !confirm(`These dependencies are no longer needed:\n${o.map(m => '• ' + m.name).join('\n')}\n\nRemove them too?`)) return
  for (const m of o) { const p = await run(() => api.uninstall(id, m.id)); if (p) setProfile(p) }
  if (cur?.id === id) updateBadges(), showInstalled()
}

async function crashHelp(pid, code) {
  const p = profiles.find(p => p.id === pid), r = await api.analyzeCrash(pid).catch(() => ({ suspects: [] }))
  $('#crashBody').innerHTML = `<p class="muted center">${esc(p?.name)} closed with exit code ${esc(code)}.</p>
    ${r.suspects.length ? `<h3>LIKELY CAUSE</h3>${r.suspects.map(m => `<div class="acct"><b>${esc(m.name)}</b><button class="primary" data-crash-off="${esc(m.id)}">Disable & retry</button></div>`).join('')}`
      : '<p>No specific mod found. Check the log, or try "Play without mods" in Options.</p>'}
    ${r.snippet ? `<pre class="snip">${esc(r.snippet)}</pre>` : ''}
    <menu><button data-crash-logs>Open logs</button><button class="primary" data-close-crash>Close</button></menu>`
  $('#crashDlg').dataset.pid = pid; $('#crashDlg').showModal()
}
$('#crashDlg').addEventListener('click', async e => {
  const pid = $('#crashDlg').dataset.pid
  if (e.target.closest('[data-close-crash]')) return $('#crashDlg').close()
  if (e.target.closest('[data-crash-logs]')) { $('#crashDlg').close(); cur = profiles.find(p => p.id === pid); tab = 'logs'; return render() }
  const off = e.target.closest('[data-crash-off]')?.dataset.crashOff
  if (!off) return
  $('#crashDlg').close()
  const p = await run(() => api.setDisabled(pid, off, true)); if (!p) return
  setProfile(p); cur = p; render(); toast('Mod disabled — starting again')
  $('#play').click()
})

const dls = {}
function dlUpdate(d) {
  const q = $('#dlq')
  if (d.done) delete dls[d.id]; else dls[d.id] = d
  q.hidden = !Object.keys(dls).length
  q.innerHTML = `<b>${ic('download', 'i sm')} Downloads</b>` + Object.values(dls).map(x => `<div class="dl"><span>${esc(x.name)}</span>
    <small>${x.total ? Math.round(x.got / x.total * 100) + '%' : ''} · ${(x.speed / 1e6).toFixed(1)} MB/s</small><div class="bar"><i data-w="${x.total ? x.got / x.total * 100 : 0}"></i></div></div>`).join('')
  q.querySelectorAll('[data-w]').forEach(i => i.style.width = i.dataset.w + '%') // CSP blocks inline style attributes
}

// ---- Minecraft server ----
const appendTo = (v, line) => { if (!v) return; const stick = v.scrollTop + v.clientHeight >= v.scrollHeight - 30; const d = document.createElement('div'); d.textContent = line; d.className = logClass(line); v.append(d); if (stick) v.scrollTop = v.scrollHeight }
let srvTab = 'console', plugSrc = 'modrinth', selPlayers = new Set()
const KINDS = { profile: 'This profile (mods)', paper: 'Paper (plugins)', purpur: 'Purpur (plugins)', bedrock: 'Bedrock Dedicated Server' }
// Minecraft § color codes -> spans (MOTD preview).
const MC_COLORS = '000000,0000AA,00AA00,00AAAA,AA0000,AA00AA,FFAA00,AAAAAA,555555,5555FF,55FF55,55FFFF,FF5555,FF55FF,FFFF55,FFFFFF'.split(',')
const motdHtml = s => { const br = t => esc(t).replace(/\\n/g, '<br>'); return String(s).split(/[§&]([0-9a-fk-or])/i).map((part, i, a) => i % 2 ? '' : i ? `<span class="c${a[i - 1].toLowerCase()}">${br(part)}</span>` : br(part)).join('') }
async function showServer() {
  const id = cur.id, s = await api.serverStatus(id)
  if (cur.id !== id || tab !== 'server') return
  const o = { maxMem: 2048, port: s.kind === 'bedrock' ? 19132 : 25565, online: true, ...s.opts }, kind = s.kind
  const state = !s.running ? 'Stopped' : s.online ? 'Online' : 'Starting…'
  const plugins = kind === 'paper' || kind === 'purpur'
  const tabs = ['console', 'players', ...(plugins ? ['plugins'] : []), 'settings', 'sync', 'backups', 'help'].map(t => `<button data-stab="${t}" class="${srvTab === t ? 'on' : ''}">${t === 'sync' ? 'World sync' : t[0].toUpperCase() + t.slice(1)}</button>`).join('')
  if (srvTab === 'plugins' && !plugins) srvTab = 'console'
  const sy = await api.syncStatus(id)
  $('#list').innerHTML = `<div class="srv">
    <div class="srvhead">${s.icon ? `<img class="sicon" src="${s.icon}" alt="">` : ''}<span class="dot ${s.online ? 'on' : s.running ? 'mid' : ''}"></span><b>${state}</b>
      <span class="tag">${esc(KINDS[kind])}</span>
      ${s.online ? `<span class="muted small">${s.players.length} player${s.players.length === 1 ? '' : 's'} online · since ${new Date(s.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>` : '<span class="small"></span>'}
      ${s.running ? `<button id="srvRestart">${ic('refresh')} Restart</button><button id="srvStop" class="danger">${ic('stop')} Stop</button>` : `<button id="srvStart" class="primary">${ic('play')} Start server</button>`}</div>
    ${!s.running && sy.lock && !sy.lock.mine ? `<div class="banner">${ic('globe')}<div><b>${esc(sy.lock.host.split('@')[0])} is hosting this world now</b><p>${sy.lock.address ? `Address: <code>${esc(sy.lock.address)}</code>` : 'Waiting for their public address…'}</p></div>${sy.lock.address ? `<button class="primary" data-joinhost="${esc(sy.lock.address)}">${ic('play')} Join</button>` : ''}</div>` : ''}
    ${!s.running && sy.dir && sy.meta && !sy.lock ? `<div class="banner">${ic('refresh')}<div><b>Shared world v${sy.meta.version}</b><p>Last saved by ${esc(String(sy.meta.by).split('@')[0])} · ${new Date(sy.meta.savedAt).toLocaleString()}${sy.meta.version > sy.local ? ' · newer than yours, downloads when you start' : ''}</p></div></div>` : ''}
    ${!s.running && s.issues.length ? `<div class="banner warn">${ic('alert')}<div><b>The server stopped with problems</b>${s.issues.map(i => `<p>${esc(i)}</p>`).join('')}</div><button id="srvShareLog">${ic('share')} Share log</button></div>` : ''}
    ${s.running ? `<div class="addr">
        <div><small>SAME WI-FI / LAN</small><code>${esc(s.lan || '')}</code><button class="icon" data-copy-text="${esc(s.lan || '')}">${ic('copy')}</button></div>
        ${kind === 'bedrock' && !s.playit && !s.address ? '<div><small>ONLINE</small><span class="muted small">Bedrock uses UDP: link a free playit.gg account in Settings → Accounts, or forward UDP port ' + esc(o.port) + ' on your router.</span></div>'
          : `<div><small>ONLINE (FRIENDS ANYWHERE)${s.playit ? ' · PLAYIT.GG' : ''}</small>${s.address ? `<code>${esc(s.address)}</code><button class="icon" data-copy-text="${esc(s.address)}">${ic('copy')}</button>`
          : `<button id="srvShare" ${s.online ? '' : 'disabled'}>${ic('globe')} Get public address</button>`}</div>`}
        ${s.bedrock && kind !== 'bedrock' ? `<div><small>BEDROCK${s.bedrockPublic ? ' (ONLINE)' : ' (LAN, UDP)'}</small><code>${esc(s.bedrockPublic || s.bedrock)}</code><button class="icon" data-copy-text="${esc(s.bedrockPublic || s.bedrock)}">${ic('copy')}</button></div>` : ''}
        ${s.voice ? `<div><small>VOICE CHAT (UDP)</small><code>${esc(s.voice)}</code><button class="icon" data-copy-text="${esc(s.voice)}">${ic('copy')}</button><span class="muted small">Set as voice_host in config/voicechat/voicechat-server.properties</span></div>` : ''}
        ${s.address ? `<button id="srvInvite" class="primary">${ic('share')} Copy invite link (mods + server)</button>` : ''}</div>` : ''}
    <div class="dtabs stabs">${tabs}</div><div id="spane"></div></div>`
  const pane = $('#spane')
  if (srvTab === 'console') {
    pane.innerHTML = `<div id="slog" class="console">${s.log.map(l => `<div class="${logClass(l)}">${esc(l)}</div>`).join('')}</div>
      <div class="row"><input id="scmd" placeholder="Type a server command (e.g. time set day) and press Enter" ${s.running ? '' : 'disabled'}><button id="srvShareLog" class="grow0">${ic('share')} Share log</button></div>`
    $('#slog').scrollTop = $('#slog').scrollHeight
  }
  if (srvTab === 'players') {
    const pl = await api.serverPlayers(id), dis = s.running ? '' : 'disabled'
    const btn = (a, n, label, cls = '') => `<button data-pact="${a}" data-name="${esc(n)}" class="${cls}" ${dis}>${label}</button>`
    const row = (n, acts) => `<div class="acct"><input type="checkbox" class="pick" data-psel="${esc(n)}" ${selPlayers.has(n) ? 'checked' : ''}><img src="https://mc-heads.net/avatar/${esc(n)}/32" alt=""><b>${esc(n)}</b>${acts(n)}</div>`
    const list = (title, names, acts) => `<div class="section"><h4>${title} (${names.length})</h4>${names.map(n => row(n, acts)).join('') || '<p class="muted small">Nobody yet.</p>'}</div>`
    pane.innerHTML = `${s.running ? '' : '<p class="muted small">Start the server to change players. "Reset data" works while stopped.</p>'}
      <div class="row addp"><input id="plname" placeholder="Player name" maxlength="16"><button data-padd="allow" ${dis}>Add to ${pl.bedrock ? 'allowlist' : 'whitelist'}</button><button data-padd="op" ${dis}>Make operator</button></div>
      ${selPlayers.size ? `<div class="bulk"><b>${selPlayers.size} selected</b><button data-pbulk="op" ${dis}>Op</button><button data-pbulk="allow" ${dis}>Whitelist</button><button data-pbulk="kick" ${dis}>Kick</button>
        ${pl.bedrock ? '' : `<button data-pbulk="ban" ${dis}>Ban</button><button data-pbulk="reset" ${s.running ? 'disabled' : ''}>Reset data</button>`}<button data-pbulk="none" class="icon">Clear</button></div>` : ''}
      ${list('ONLINE', pl.online, n => btn('op', n, 'Op') + btn('kick', n, 'Kick') + (pl.bedrock ? '' : btn('ban', n, 'Ban', 'danger')))}
      ${pl.bedrock ? '' : list('OPERATORS', pl.ops, n => btn('deop', n, 'Remove op'))}
      ${list(pl.bedrock ? 'ALLOWLIST' : 'WHITELIST', pl.whitelist, n => btn('disallow', n, 'Remove'))}
      ${pl.bedrock ? '' : list('BANNED', pl.banned, n => btn('pardon', n, 'Unban'))}
      ${pl.bedrock ? '' : list('EVERYONE WHO JOINED', pl.known, n => `<button data-preset="${esc(n)}" ${s.running ? 'disabled' : ''} title="Delete inventory, stats and advancements">Reset data</button>`)}`
  }
  if (srvTab === 'plugins') {
    const installed = s.opts.plugins || []
    pane.innerHTML = `<div class="section"><h4>INSTALLED PLUGINS (${installed.length})</h4>${installed.map(x => `<div class="acct">${x.icon ? `<img src="${esc(x.icon)}" alt="">` : ''}<b>${esc(x.name)}</b><span class="tag">${esc(x.version)}</span><span class="muted small">${x.src === 'hangar' ? 'Hangar' : 'Modrinth'}</span>
        <button class="icon" data-prm="${esc(x.id)}" title="Remove">${ic('trash')}</button></div>`).join('') || '<p class="muted small">No plugins yet.</p>'}</div>
      <div class="row"><select id="plugSrc"><option value="modrinth" ${plugSrc === 'modrinth' ? 'selected' : ''}>Modrinth</option><option value="hangar" ${plugSrc === 'hangar' ? 'selected' : ''}>Hangar (PaperMC)</option></select>
        <div class="search grow2"><svg class="i"><use href="#i-search"/></svg><input id="plugQ" type="search" placeholder="Search plugins"></div></div>
      <div id="plugList"></div><p class="muted small">Plugin changes apply after a restart.</p>`
    pluginSearch()
  }
  if (srvTab === 'settings') {
    const pr = await api.serverProps(id), v = (k, d) => esc(pr[k] ?? d), sel = (k, opts, d) => `<select name="${k}">${opts.map(x => `<option ${String(pr[k] ?? d) === x ? 'selected' : ''}>${x}</option>`).join('')}</select>`
    const tog = (k, label, d) => `<label class="check"><input type="checkbox" class="switch" data-prop="${k}" ${String(pr[k] ?? d) === 'true' ? 'checked' : ''}> ${label}</label>`
    const bedrock = kind === 'bedrock', ram = s.ram
    pane.innerHTML = `<form class="opts" id="srvForm"><h4 class="muted">STARTUP</h4>
        <label>SERVER TYPE<select name="kind" id="srvKind" ${s.running ? 'disabled' : ''}>${Object.entries(KINDS).map(([k, l]) => `<option value="${k}" ${kind === k ? 'selected' : ''}>${l}${k === 'profile' ? ` — ${esc(cur.mc.loader)} ${esc(cur.mc.version)}` : ''}</option>`).join('')}</select></label>
        ${bedrock ? '' : `<label>MEMORY <span id="memOut">${(o.maxMem / 1024).toFixed(1)} GB</span><input name="maxMem" type="range" min="1024" max="${Math.max(2048, ram - 1024)}" step="512" value="${+o.maxMem}" id="memRange"></label>`}
        <div class="row"><label>PORT<input name="port" type="number" min="1024" max="65535" value="${+o.port}"></label>
          <label>BACKUP EVERY<select name="backupEvery">${[0, 1, 3, 6, 12, 24].map(h => `<option value="${h}" ${+o.backupEvery === h ? 'selected' : ''}>${h ? `${h} hour${h > 1 ? 's' : ''}` : 'Never'}</option>`).join('')}</select></label>
          <label>RESTART EVERY<select name="restartEvery">${[0, 6, 12, 24].map(h => `<option value="${h}" ${+o.restartEvery === h ? 'selected' : ''}>${h ? `${h} hours` : 'Never'}</option>`).join('')}</select></label></div>
        <label class="check"><input type="checkbox" name="online" class="switch" ${o.online ? 'checked' : ''}> Only real Minecraft accounts (online mode)</label>
        ${bedrock ? '' : `<label class="check"><input type="checkbox" name="geyser" class="switch" ${o.geyser ? 'checked' : ''}> Let Bedrock players join (Geyser + Floodgate)</label>`}
        <label class="check"><input type="checkbox" name="autoRestart" class="switch" ${o.autoRestart ? 'checked' : ''}> Restart automatically if it crashes</label>
        <label class="check"><input type="checkbox" name="backupOnStop" class="switch" ${o.backupOnStop ? 'checked' : ''}> Back up the world every time it stops</label>
        <label>ON START COMMANDS <span class="muted small">(one per line)</span><textarea name="onStart" rows="2" placeholder="say Server is up!">${esc(o.onStart || '')}</textarea></label>
        <label>ON STOP COMMANDS<textarea name="onStop" rows="2" placeholder="say Server restarting">${esc(o.onStop || '')}</textarea></label>
        <label class="check"><input type="checkbox" name="eula" class="switch" ${o.eula ? 'checked' : ''}> I agree to the <a data-href="${bedrock ? 'https://minecraft.net/terms' : 'https://aka.ms/MinecraftEULA'}">Minecraft EULA</a>${bedrock ? ' and <a data-href="https://go.microsoft.com/fwlink/?LinkId=521839">Privacy Policy</a>' : ''}</label>
        ${kind === 'profile' && cur.mc.loader !== 'vanilla' ? `<div class="row"><button type="button" id="srvLoader">${ic('up')} Update ${esc(cur.mc.loader)} loader${cur.mods.some(m => m.id === 'P7dR8mSH') ? ' + Fabric API' : ''}</button></div>` : ''}
      </form>
      <form class="opts" id="propsForm"><h4 class="muted">WORLD & RULES ${s.running ? '<span class="small">(applies after restart)</span>' : ''}</h4>
        ${bedrock ? `<label>SERVER NAME<input name="server-name" value="${v('server-name', cur.name)}"></label>` : `
        <div class="row"><label>MESSAGE OF THE DAY <span class="muted small">(§ or & color codes)</span><input name="motd" id="motd" value="${v('motd', cur.name)}"></label>
          <label class="grow0">SERVER ICON<button type="button" id="srvIconBtn">${s.icon ? `<img class="sicon" src="${s.icon}" alt="">` : ic('file')} Change</button></label></div>
        <div class="motdprev" id="motdPrev">${motdHtml(pr.motd ?? cur.name)}</div>`}
        <div class="row"><label>GAME MODE${sel('gamemode', ['survival', 'creative', 'adventure', ...(bedrock ? [] : ['spectator'])], 'survival')}</label>
          <label>DIFFICULTY${sel('difficulty', ['peaceful', 'easy', 'normal', 'hard'], 'easy')}</label></div>
        <div class="row"><label>MAX PLAYERS<input name="max-players" type="number" min="1" max="200" value="${v('max-players', 10)}"></label>
          <label>VIEW DISTANCE<input name="view-distance" type="number" min="3" max="32" value="${v('view-distance', 10)}"></label></div>
        <div class="row"><label>WORLD SEED<input name="level-seed" value="${v('level-seed', '')}" placeholder="Random"></label>
          ${bedrock ? '' : `<label>SPAWN PROTECTION<input name="spawn-protection" type="number" min="0" value="${v('spawn-protection', 16)}"></label>`}</div>
        ${bedrock ? tog('allow-cheats', 'Cheats', 'false') + tog('allow-list', 'Allowlist only', 'false') : `
        ${tog('force-gamemode', 'Force game mode on join', 'false')}${tog('pvp', 'PvP', 'true')}${tog('white-list', 'Whitelist only', 'false')}${tog('allow-flight', 'Allow flight (needed by some mods)', 'false')}
        ${tog('hardcore', 'Hardcore', 'false')}${tog('allow-nether', 'Nether', 'true')}${tog('enable-command-block', 'Command blocks', 'false')}
        <h4 class="muted">RESOURCE PACK</h4>
        <label>PACK URL <span class="muted small">(https link players download, e.g. from Modrinth or Dropbox)</span><input name="resource-pack" id="rpUrl" value="${v('resource-pack', '')}"></label>
        <div class="row"><label>SHA1<input name="resource-pack-sha1" id="rpSha" value="${v('resource-pack-sha1', '')}"></label><button type="button" id="rpHash" class="grow0">Calculate</button></div>
        ${tog('require-resource-pack', 'Require the pack', 'false')}`}
        <button class="primary">${ic('check')} Save world settings</button></form>
      <input type="file" id="srvIconFile" accept="image/*" hidden>`
  }
  if (srvTab === 'sync') {
    pane.innerHTML = `<div class="section"><h4>SHARED WORLD FOLDER</h4>
      ${sy.dir ? `<div class="acct">${ic('folder')}<b class="path">${esc(sy.dir)}</b>${sy.missing ? '<span class="tag upd">Not found</span>' : ''}<button id="syncPick" ${s.running ? 'disabled' : ''}>Change</button><button class="icon" id="syncOff" ${s.running ? 'disabled' : ''} title="Stop syncing">${ic('x')}</button></div>`
        : `<button id="syncPick" class="primary" ${s.running ? 'disabled' : ''}>${ic('folder')} Choose shared folder</button>`}
      ${sy.dir && !sy.missing ? `<div class="addr">
        <div><small>SHARED VERSION</small><b>${sy.meta ? `v${sy.meta.version} · ${esc(String(sy.meta.by).split('@')[0])} · ${new Date(sy.meta.savedAt).toLocaleString()}` : 'Empty — your world uploads when the server stops'}</b></div>
        <div><small>YOUR COPY</small><b>v${sy.local}</b></div>
        <div><small>HOST</small><b>${sy.lock ? `${esc(sy.lock.host.split('@')[0])}${sy.lock.mine ? ' (you)' : ''}${sy.lock.address ? ` · ${esc(sy.lock.address)}` : ''}` : 'Nobody is hosting'}</b></div>
        <div class="row"><button id="syncUp" ${sy.lock && !sy.lock.mine ? 'disabled' : ''}>${ic('up')} Upload now</button><button id="syncDown" ${s.running || (sy.lock && !sy.lock.mine) ? 'disabled' : ''}>${ic('download')} Download latest</button></div></div>` : ''}</div>
      <div class="section"><h4>HOW IT WORKS</h4><ol class="steps">
        <li>Make a folder inside Google Drive, OneDrive or Dropbox (their desktop app must be installed) and share it with your friends.</li>
        <li>Everyone picks that folder here, in a profile with the same mods (send them your invite link).</li>
        <li>Whoever presses Start downloads the newest world, becomes the host, and the others see "is hosting now" with a Join button.</li>
        <li>When the host stops, the world is uploaded again (also every 30 minutes while running), so the next friend can host.</li></ol>
      <p class="muted small">Only one person can host at a time. Wait until the cloud app shows the folder as synced before starting. Your previous copy is kept in Backups whenever a newer world is downloaded.</p></div>`
  }
  if (srvTab === 'backups') {
    const list = await api.backups(id)
    pane.innerHTML = `<div class="row"><button id="bkNow" class="primary">${ic('download')} Back up now</button></div>
      ${list.map(b => `<div class="acct"><b>${esc(b.name)}</b><span class="muted small">${(b.size / 1e6).toFixed(1)} MB · ${new Date(b.time).toLocaleString()}</span>
        <button data-restore="${esc(b.name)}" ${s.running ? 'disabled title="Stop the server first"' : ''}>Restore</button><button class="icon" data-delbk="${esc(b.name)}">${ic('trash')}</button></div>`).join('') || '<p class="muted small">No backups yet.</p>'}`
  }
  if (srvTab === 'help') {
    pane.innerHTML = '<p class="muted">Running checks…</p>'
    const d = await api.diagnostics(id)
    if (srvTab !== 'help') return
    pane.innerHTML = `<div class="section"><h4>DIAGNOSTICS</h4>${d.map(x => `<div class="acct"><span class="dot ${x.ok ? 'on' : ''}"></span><b>${esc(x.name)}</b><span class="muted small">${esc(x.detail)}</span></div>`).join('')}</div>
      <div class="section"><h4>TIPS</h4><p class="muted small">Friends can't join? Use "Get public address" and send them the address. A linked playit.gg account (Settings → Accounts) is the most reliable and also works for Bedrock and voice chat. Mod servers need every player to have the same mods: send the invite link.
      If the free tunnel is down, forward port ${esc(o.port)} (TCP${kind === 'bedrock' ? '/UDP' : ''}) on your router to this PC.</p></div>
      <button id="srvShareLog">${ic('share')} Share server log</button> <button id="srvDiag">${ic('refresh')} Run again</button>`
  }
}
async function pluginSearch() {
  const id = cur.id, r = await run(() => api.pluginSearch(id, plugSrc, $('#plugQ')?.value || '', 1))
  if (!r || srvTab !== 'plugins') return
  const have = new Set((profiles.find(p => p.id === id)?.server?.plugins || []).map(x => x.id))
  $('#plugList').innerHTML = r.items.map(m => `<div class="mod" data-pid="${esc(m.id)}">${m.icon ? `<img src="${esc(m.icon)}" alt="" loading="lazy" decoding="async">` : '<div class="noicon"></div>'}
    <div class="body"><div class="top"><b>${esc(m.title)}</b><small>by ${esc(m.author)}</small><small>${ic('download', 'i sm')} ${fmt(m.downloads)}</small></div><p>${esc(m.desc)}</p></div>
    <div class="actions"><button class="act ${have.has(m.id) ? 'done' : ''}" data-pinst="${esc(m.id)}">${have.has(m.id) ? installedBtn : `${ic('download')} Install`}</button></div></div>`).join('') || '<p class="muted">No plugins found.</p>'
}
function serverOpts() {
  const f = $('#srvForm'), saved = profiles.find(p => p.id === cur.id)?.server || {}
  if (!f) return saved
  const val = n => f.elements[n]
  return { kind: val('kind').value, maxMem: val('maxMem')?.value || saved.maxMem, port: val('port').value, online: val('online').checked, geyser: !!val('geyser')?.checked,
    autoRestart: val('autoRestart').checked, backupOnStop: val('backupOnStop').checked, eula: val('eula').checked,
    backupEvery: val('backupEvery').value, restartEvery: val('restartEvery').value, onStart: val('onStart').value, onStop: val('onStop').value }
}
async function serverStart(btn) {
  const o = serverOpts(), st = await api.serverStatus(cur.id)
  o.kind ||= st.kind
  if (!o.eula) { srvTab = 'settings'; await showServer(); return toast('Accept the Minecraft EULA in Settings first', true) }
  if (o.kind !== 'bedrock' && +o.maxMem > st.ram * 0.75 && !confirm(`${(o.maxMem / 1024).toFixed(1)} GB is most of this PC's ${(st.ram / 1024).toFixed(0)} GB memory. Start anyway?`)) return
  btn.disabled = true; btn.innerHTML = `${ic('refresh', 'i spin')} Preparing…`
  srvTab = 'console'
  const ok = await run(() => api.serverStart(cur.id, o))
  if (ok) setProfile({ ...cur, server: { ...cur.server, ...o } })
  showServer()
}
$('#list').addEventListener('click', async e => {
  if (tab !== 'server') return
  const t = e.target.closest('button'); if (!t) return
  const id = cur.id
  if (t.dataset.stab) return srvTab = t.dataset.stab, showServer()
  if (t.id === 'srvRestart') return run(() => api.serverRestart(id))
  if (t.id === 'srvDiag') return showServer()
  if (t.id === 'srvShareLog') {
    if (!confirm('Upload the server log to mclo.gs (public link)? Logs can contain player names and IP addresses.')) return
    const url = await run(() => api.shareLog(id, 'server')); if (url) navigator.clipboard.writeText(url), toast(`Log link copied: ${url}`), api.openExternal(url); return
  }
  if (t.dataset.joinhost) return run(() => startGame(id, { server: t.dataset.joinhost }))
  if (t.id === 'syncPick') { const d = await api.pickFolder(); if (d && await run(() => api.setSyncDir(id, d))) toast('World sync folder set'); return showServer() }
  if (t.id === 'syncOff' && confirm('Stop syncing this server\'s world? Files in the shared folder stay.')) { await run(() => api.setSyncDir(id, null)); return showServer() }
  if (t.id === 'syncUp') { t.disabled = true; const v = await run(() => api.syncNow(id)); if (v) toast(`Uploaded world v${v}`); return showServer() }
  if (t.id === 'syncDown') { t.disabled = true; if (await run(() => api.syncPull(id))) toast('Downloaded the latest shared world'); return showServer() }
  if (t.id === 'srvLoader') {
    if (!confirm('Update the mod loader to the newest version? Make a backup first if this world matters.')) return
    const r = await run(() => api.updateLoader(id)); if (r) toast(`Loader ${r.from || 'auto'} → ${r.to}`), refresh(); return
  }
  if (t.id === 'srvIconBtn') return $('#srvIconFile').click()
  if (t.id === 'rpHash') { t.disabled = true; const h = await run(() => api.sha1Url($('#rpUrl').value.trim())); t.disabled = false; if (h) $('#rpSha').value = h; return }
  if (t.dataset.pact) return run(async () => { await api.playerAction(id, t.dataset.pact, t.dataset.name); setTimeout(showServer, 800) })
  if (t.dataset.padd) { const n = $('#plname').value.trim(); if (n) run(async () => { await api.playerAction(id, t.dataset.padd, n); setTimeout(showServer, 800) }); return }
  if (t.dataset.preset && confirm(`Reset ${t.dataset.preset}'s inventory, position, stats and advancements?`)) { if (await run(() => api.resetPlayer(id, t.dataset.preset))) toast('Player data reset'); return }
  if (t.dataset.pbulk) {
    const a = t.dataset.pbulk, names = [...selPlayers]
    if (a === 'none') return selPlayers.clear(), showServer()
    if (a === 'reset' && !confirm(`Reset data for ${names.length} players?`)) return
    for (const n of names) await run(() => a === 'reset' ? api.resetPlayer(id, n) : api.playerAction(id, a, n))
    selPlayers.clear(); toast('Done'); return setTimeout(showServer, 800)
  }
  if (t.dataset.pinst) { t.disabled = true; t.innerHTML = `${ic('refresh', 'i spin')} Installing…`; const l = await run(() => api.pluginInstall(id, plugSrc, t.dataset.pinst)); if (l) setProfile({ ...cur, server: { ...cur.server, plugins: l } }), toast('Plugin installed — restart the server'); return showServer() }
  if (t.dataset.prm) { const l = await run(() => api.pluginRemove(id, t.dataset.prm)); if (l) setProfile({ ...cur, server: { ...cur.server, plugins: l } }); return showServer() }
  if (t.id === 'bkNow') { t.disabled = true; const n = await run(() => api.backup(id)); if (n) toast(`Backup saved: ${n}`); return showServer() }
  if (t.dataset.restore && confirm(`Restore ${t.dataset.restore}? The current world is replaced.`)) { if (await run(() => api.restoreBackup(id, t.dataset.restore))) toast('World restored'); return showServer() }
  if (t.dataset.delbk && confirm(`Delete ${t.dataset.delbk}?`)) { await run(() => api.deleteBackup(id, t.dataset.delbk)); return showServer() }
})
$('#list').addEventListener('change', async e => {
  if (tab !== 'server') return
  if (e.target.dataset.psel) { e.target.checked ? selPlayers.add(e.target.dataset.psel) : selPlayers.delete(e.target.dataset.psel); return showServer() }
  if (e.target.id === 'srvKind') { const sv = await run(() => api.setServerKind(cur.id, e.target.value)); if (sv) setProfile({ ...cur, server: sv }); return showServer() }
  if (e.target.id === 'plugSrc') { plugSrc = e.target.value; return pluginSearch() }
  if (e.target.id === 'srvIconFile') {
    const file = e.target.files[0]; if (!file) return
    const img = await createImageBitmap(file), c = document.createElement('canvas'); c.width = c.height = 64
    c.getContext('2d').drawImage(img, 0, 0, 64, 64)
    if (await run(() => api.setServerIcon(cur.id, c.toDataURL('image/png')))) toast('Server icon saved'), showServer()
  }
})
$('#list').addEventListener('input', e => {
  if (e.target.id === 'motd') $('#motdPrev').innerHTML = motdHtml(e.target.value)
  if (e.target.id === 'memRange') $('#memOut').textContent = (e.target.value / 1024).toFixed(1) + ' GB'
  if (e.target.id === 'plugQ') { clearTimeout(timer); timer = setTimeout(pluginSearch, 350) }
})
$('#list').addEventListener('submit', async e => {
  if (e.target.id !== 'propsForm') return
  e.preventDefault()
  const f = Object.fromEntries(new FormData(e.target))
  e.target.querySelectorAll('[data-prop]').forEach(c => f[c.dataset.prop] = c.checked)
  if (await run(() => api.setServerProps(cur.id, f))) toast('World settings saved')
})
$('#list').addEventListener('keydown', e => {
  if (e.target.id !== 'scmd' || e.key !== 'Enter' || !e.target.value.trim()) return
  api.serverCmd(cur.id, e.target.value); e.target.value = ''
})
$('#list').addEventListener('change', e => { if (e.target.id === 'javaPick') { const i = $('#optsForm [name=java]'); i.hidden = e.target.value !== 'custom'; if (!i.hidden) i.focus() } })

// ---- Import preview (diff against an existing profile) ----
let previewTimer
$('#newForm').elements.code.addEventListener('input', () => { clearTimeout(previewTimer); previewTimer = setTimeout(importPreview, 400) })
async function importPreview() {
  const code = $('#newForm').elements.code.value.trim(), box = $('#impPreview')
  if (!code) return box.hidden = true
  const pv = await api.preview(code).catch(() => null)
  if (!pv) return box.hidden = false, box.innerHTML = '<p class="muted small">Not a valid code yet…</p>'
  const same = profiles.filter(p => p.type === pv.type && (pv.type === 'modrinth' ? p.mc?.version === pv.mc?.version && p.mc?.loader === pv.mc?.loader : p.game === pv.game))
  box.hidden = false
  box.innerHTML = `<div class="banner"><div><b>${esc(pv.name || 'Shared profile')}</b><p>${pv.count} mods · ${esc(pv.type === 'modrinth' ? `Minecraft ${pv.mc?.version} ${pv.mc?.loader}` : pv.gameName || pv.game)}</p></div></div>
    ${same.length ? `<label>IMPORT INTO<select id="impInto"><option value="">A new profile</option>${same.map(p => `<option value="${p.id}">Sync into "${esc(p.name)}"</option>`).join('')}</select></label><div id="impDiff"></div>` : ''}`
  $('#impInto')?.addEventListener('change', showDiff)
}
async function showDiff() {
  const pid = $('#impInto').value, el = $('#impDiff')
  if (!pid) return el.innerHTML = ''
  const d = (await run(() => api.preview($('#newForm').elements.code.value.trim(), pid)))?.diff; if (!d) return
  const list = (t, a) => a.length ? `<p><b>${t} (${a.length})</b> ${a.slice(0, 8).map(esc).join(', ')}${a.length > 8 ? '…' : ''}</p>` : ''
  el.innerHTML = `<div class="diff">${list('+ New', d.add)}${list('~ Different version', d.change)}${list('- Not in their list', d.remove)}${!d.add.length && !d.change.length && !d.remove.length ? '<p>Already identical.</p>' : ''}</div>
    ${d.remove.length ? '<label class="check"><input type="checkbox" id="impRemove" class="switch"> Remove mods not in their list</label>' : ''}`
}

// ---- Share links: modmanager://import/<code>, modmanager://follow/<gist> ----
window.onLink?.(link => run(async () => {
  const [, kind, value] = link.match(/^modmanager:\/\/(import|follow)\/([^/?#]+)/) || []
  if (!value) throw new Error('Unknown link')
  toast(kind === 'follow' ? 'Following friend’s profile…' : 'Importing shared profile…')
  const res = kind === 'follow' ? await api.follow(decodeURIComponent(value)) : await api.importCode(decodeURIComponent(value))
  created(res)
}))

// ---- Vortex-style extras: FOMOD installer, load order, tools, purge, Nexus collections ----
// Install results that carry an installer open the wizard; returns the final profile (or the input if none).
const fm = async p => p?.fomod ? (await fomodWizard(p.id, p.fomod)) || p : p

// FOMOD wizard: steps, group types, Required/Recommended/NotUsable, condition flags, conditional installs, priorities.
// shortcut: fileDependency / gameDependency always count as met; check real files if an installer depends on them.
function fomodWizard(pid, f, auto) {
  const doc = new DOMParser().parseFromString(f.xml, 'text/xml').documentElement
  const kids = (el, n) => el ? [...el.children].filter(c => c.localName.toLowerCase() === n.toLowerCase()) : []
  const one = (el, n) => kids(el, n)[0], at = (el, a) => el?.getAttribute(a)
  const ord = (el, n) => { const l = kids(el, n), o = at(el, 'order') || 'Ascending'; return o === 'Explicit' ? l : l.sort((a, b) => (at(a, 'name') || '').localeCompare(at(b, 'name') || '') * (o === 'Descending' ? -1 : 1)) }
  let flags = {}
  const met = d => { if (!d) return true; const r = [...d.children].map(c => c.localName === 'flagDependency' ? (flags[at(c, 'flag')] || '') === (at(c, 'value') || '') : c.localName === 'dependencies' ? met(c) : true); return !r.length || (at(d, 'operator') === 'Or' ? r.some(Boolean) : r.every(Boolean)) }
  const typeOf = pl => { const td = one(pl, 'typeDescriptor'), t = one(td, 'type'); if (t) return at(t, 'name'); const dt = one(td, 'dependencyType'), hit = kids(one(dt, 'patterns'), 'pattern').find(p => met(one(p, 'dependencies'))); return at(hit ? one(hit, 'type') : one(dt, 'defaultType'), 'name') || 'Optional' }
  const steps = ord(one(doc, 'installSteps'), 'installStep').map(s => ({ el: s, groups: ord(one(s, 'optionalFileGroups'), 'group').map(g => ({ name: at(g, 'name'), type: at(g, 'type'), plugins: ord(one(g, 'plugins'), 'plugin') })) }))
  const sel = new Map(), path = []
  const flagsFrom = list => { flags = {}; for (const i of list) for (const g of steps[i].groups) for (const pl of sel.get(g) || []) for (const fl of kids(one(pl, 'conditionFlags'), 'flag')) flags[at(fl, 'name')] = fl.textContent }
  const nextStep = from => { flagsFrom(path); for (let i = from + 1; i < steps.length; i++) if (met(one(steps[i].el, 'visible'))) return i; return -1 }
  const defaults = g => {
    if (sel.has(g)) return
    const ok = g.plugins.filter(p => typeOf(p) !== 'NotUsable')
    let s = g.type === 'SelectAll' ? ok : ok.filter(p => ['Required', 'Recommended'].includes(typeOf(p)))
    if (g.type === 'SelectExactlyOne' && !s.length) s = ok.slice(0, 1)
    sel.set(g, new Set(/One$/.test(g.type) ? s.slice(0, 1) : s))
  }
  const enter = i => { path.push(i); flagsFrom(path.slice(0, -1)); steps[i].groups.forEach(defaults) }
  const filesOf = el => [...kids(el, 'file'), ...kids(el, 'folder')].map(x => ({ source: at(x, 'source'), destination: at(x, 'destination'), folder: x.localName === 'folder', pr: +at(x, 'priority') || 0 }))
  const finish = () => {
    flagsFrom(path)
    const picks = [...filesOf(one(doc, 'requiredInstallFiles')),
      ...path.flatMap(i => steps[i].groups.flatMap(g => [...sel.get(g)].flatMap(pl => filesOf(one(pl, 'files'))))),
      ...kids(one(one(doc, 'conditionalFileInstalls'), 'patterns'), 'pattern').filter(p => met(one(p, 'dependencies'))).flatMap(p => filesOf(one(p, 'files')))]
    return api.fomodFinish(pid, f.stage, picks.sort((a, b) => a.pr - b.pr)) // higher priority copied last = wins
  }
  if (auto || nextStep(-1) < 0) { for (let i = nextStep(-1); i >= 0; i = nextStep(i)) enter(i); return run(finish) }
  enter(nextStep(-1))
  const dlg = $('#fomodDlg'), body = $('#fmBody'), nextLabel = () => $('#fmNext').textContent = nextStep(path.at(-1)) < 0 ? 'Install' : 'Next'
  $('#fmTitle').textContent = `Install ${f.name}`
  return new Promise(res => {
    const show = () => {
      const s = steps[path.at(-1)]; flagsFrom(path.slice(0, -1))
      body.innerHTML = `<h3>${esc(at(s.el, 'name') || '')}</h3><div class="fm"><div>${s.groups.map((g, gi) => {
        const radio = /One$/.test(g.type)
        return `<fieldset><legend>${esc(g.name || '')}</legend>${g.type === 'SelectAtMostOne' ? `<label><input type="radio" name="g${gi}" value="-1" ${sel.get(g).size ? '' : 'checked'}> None</label>` : ''}${g.plugins.map((pl, pi) => {
          const t = typeOf(pl), lock = t === 'Required' || t === 'NotUsable' || g.type === 'SelectAll'
          return `<label data-g="${gi}" data-p="${pi}"><input type="${radio ? 'radio' : 'checkbox'}" name="g${gi}" value="${pi}" ${sel.get(g).has(pl) ? 'checked' : ''} ${lock ? 'disabled' : ''}> ${esc(at(pl, 'name') || '')}${t !== 'Optional' ? ` <small class="muted">${esc(t)}</small>` : ''}</label>`
        }).join('')}</fieldset>`
      }).join('')}</div><div id="fmInfo" class="muted">Point at an option to see what it does.</div></div>`
      $('#fmBack').disabled = path.length < 2
      nextLabel()
    }
    const close = async fn => { dlg.close(); res(await run(fn)) }
    body.onmouseover = e => {
      const l = e.target.closest('[data-p]'); if (!l) return
      const pl = steps[path.at(-1)].groups[l.dataset.g].plugins[l.dataset.p], img = f.images[at(one(pl, 'image'), 'path')]
      $('#fmInfo').innerHTML = (img ? `<img src="${img}" alt="">` : '') + `<p>${esc(one(pl, 'description')?.textContent.trim() || '')}</p>`
    }
    body.onchange = e => {
      const g = steps[path.at(-1)].groups[+e.target.name.slice(1)], pl = g.plugins[+e.target.value]
      if (e.target.type === 'radio') sel.set(g, new Set(pl ? [pl] : []))
      else e.target.checked ? sel.get(g).add(pl) : sel.get(g).delete(pl)
      nextLabel()
    }
    $('#fmBack').onclick = () => { path.pop(); show() }
    $('#fmNext').onclick = () => {
      const bad = steps[path.at(-1)].groups.find(g => (g.type === 'SelectAtLeastOne' && !sel.get(g).size) || (g.type === 'SelectExactlyOne' && sel.get(g).size !== 1))
      if (bad) return toast(`Pick an option in "${bad.name}"`, true)
      const n = nextStep(path.at(-1))
      n < 0 ? close(finish) : (enter(n), show())
    }
    $('#fmCancel').onclick = () => close(() => api.fomodCancel(pid))
    dlg.oncancel = e => { e.preventDefault(); $('#fmCancel').click() }
    show(); dlg.showModal()
  })
}

// Options tab extras for non-Minecraft games.
async function gameExtras() {
  const lo = await api.loadOrder(cur.id).catch(() => null), tools = cur.tools || []
  return `<div class="opts">
    <h4 class="muted">TOOLS <span class="small">(LOOT, xEdit, script extenders…)</span></h4>
    ${tools.map((t, i) => `<div class="lo"><b>${esc(t.name)}</b><small class="muted">${esc(t.exe)}</small><button data-tool="${i}">${ic('play')} Run</button><button class="icon" data-tooldel="${i}" title="Remove">${ic('trash')}</button></div>`).join('') || '<p class="muted small">No tools added.</p>'}
    <div class="row"><button type="button" id="toolAdd">${ic('plus')} Add tool</button></div>
    ${lo ? `<h4 class="muted">PLUGIN LOAD ORDER <span class="small">(written to plugins.txt on Deploy)</span></h4>
    <div id="loList">${lo.plugins.map((x, i) => `<div class="lo" data-plug="${esc(x.name)}"><input type="checkbox" class="switch" ${x.on ? 'checked' : ''}><b>${esc(x.name)}</b><small class="muted">${esc(x.mod)}</small>
      <button class="icon" data-lo="-1" title="Up" ${x.master ? 'disabled' : ''}>▲</button><button class="icon" data-lo="1" title="Down" ${x.master ? 'disabled' : ''}>▼</button></div>`).join('') || '<p class="muted small">No plugins in enabled mods.</p>'}</div>
    ${lo.plugins.length ? `<div class="row"><button type="button" class="primary" id="loSave">${ic('check')} Save load order</button></div>` : ''}<p class="muted small">Masters (.esm/.esl) always load first.</p>` : ''}
    <h4 class="muted">GAME FOLDER</h4>
    <div class="row"><button type="button" id="purge">${ic('trash')} Purge mods from game folder</button>${cur.type === 'nexus' ? `<button type="button" id="collOpen">${ic('package')} Browse collections</button>` : ''}</div>
    <p class="muted small">Purge removes every file this profile deployed. Your mods stay in the list; Deploy puts them back.</p></div>`
}
$('#list').addEventListener('click', async e => {
  const t = e.target.closest('button'); if (!t || tab !== 'options') return
  const id = cur.id, save = async tools => { const p = await run(() => api.setTools(id, tools)); if (p) setProfile(p), showOptions() }
  if (t.dataset.tool) run(() => api.runTool(id, +t.dataset.tool))
  if (t.dataset.tooldel) save((cur.tools || []).filter((_, i) => i !== +t.dataset.tooldel))
  if (t.id === 'toolAdd') { const exe = await api.openFile(['exe', 'bat', 'cmd']); if (!exe) return; const name = await ask('Tool name', exe.split(/[\\/]/).pop().replace(/\.\w+$/, '')); if (name !== null) { const args = await ask('Arguments (optional)', ''); save([...(cur.tools || []), { name, exe, args: args || '' }]) } }
  if (t.dataset.lo) { const row = t.closest('.lo'), to = +t.dataset.lo < 0 ? row.previousElementSibling : row.nextElementSibling; if (to?.querySelector('[data-lo]:not([disabled])')) +t.dataset.lo < 0 ? to.before(row) : to.after(row) }
  if (t.id === 'loSave') { const rows = [...document.querySelectorAll('#loList .lo')]; const p = await run(() => api.setLoadOrder(id, rows.map(r => r.dataset.plug), rows.filter(r => !r.querySelector('input').checked).map(r => r.dataset.plug))); if (p) setProfile(p), toast('Load order saved — Deploy to apply') }
  if (t.id === 'purge') { const p = await run(() => api.purge(id)); if (p) setProfile(p), toast('Mods removed from the game folder') }
  if (t.id === 'collOpen') { $('#collQ').value = ''; $('#collDlg').showModal(); collSearch() }
})

// Nexus collections: browse, then install every file (Premium downloads directly; free accounts get each page opened).
async function collSearch() {
  $('#collBody').innerHTML = '<div class="skel"></div>'.repeat(4)
  const r = await run(() => api.collections(cur.id, $('#collQ').value.trim()))
  $('#collBody').innerHTML = r ? r.items.map(c => `<div class="coll">${c.tileImage?.url ? `<img src="${esc(c.tileImage.url)}" alt="" loading="lazy">` : '<div class="noicon"></div>'}
    <div><b>${esc(c.name)}</b><p class="muted small">${esc(c.summary || '')}</p><small class="muted">${c.latestPublishedRevision?.modCount || 0} mods · ${fmt(c.endorsements)} endorsements · ${fmt(c.totalDownloads)} downloads</small></div>
    <div class="actions"><button class="icon" data-href="https://next.nexusmods.com/${esc(cur.game)}/collections/${esc(c.slug)}" title="Open">${ic('external')}</button><button class="primary" data-coll="${esc(c.slug)}">${ic('download')} Install</button></div></div>`).join('') || '<p class="muted">No collections found.</p>' : ''
}
let collTimer
$('#collQ').oninput = () => { clearTimeout(collTimer); collTimer = setTimeout(collSearch, 400) }
$('#collBody').onclick = async e => {
  const b = e.target.closest('[data-coll]'); if (!b) return
  const c = await run(() => api.collectionMods(b.dataset.coll)); if (!c) return
  const req = c.mods.filter(m => !m.optional), id = cur.id
  if (!confirm(`Install ${req.length} required mods from "${c.name}"? Optional mods are skipped. Installers use their default options.`)) return
  $('#collDlg').close()
  let ok = 0, fail = []
  for (const [i, m] of req.entries()) {
    toast(`Collection: ${i + 1}/${req.length} ${m.name}`)
    try { let p = await api.install(id, 'nexus', m.modId, m.fileId); if (p.fomod) p = (await fomodWizard(id, p.fomod, true)) || p; setProfile(p); ok++ }
    catch (err) { fail.push(m); if (/Free Nexus|API key/i.test(err.message)) break }
  }
  render()
  if (fail.length) toast(`${ok} installed, ${req.length - ok} not. Free Nexus accounts must download each file on the website (Mod Manager Download button).`, true)
  else toast(`Installed ${ok} mods from ${c.name}`)
}

// ---- Launcher-X built in: clone / update / build / run GitHub projects in a PowerShell console ----
let lxEdit = null // project name being edited, '' for a new one
api.lxConfig().then(c => { lxName = c.name; lxOn = c.enabled; render() }).catch(() => {})
// GTA 6 page: sidebar tabs Projects / Settings, projects listed like mods.
async function drawLx() {
  const c = await api.lxConfig(), e = lxEdit === null ? null : c.projects.find(p => p.name === lxEdit) || { name: '', repo: '', branch: 'main', build: [], shaders: [], run: '' }
  if (!lxView) return
  if (!['lxprojects', 'lxsettings'].includes(tab)) tab = 'lxprojects'
  lxName = c.name
  $('#banner').style.backgroundImage = ''; document.body.classList.remove('mc', 'mc-banner', 'mr') // the last profile's look; render() sets them again
  $('#pname').textContent = c.name
  $('#pmeta').textContent = `Recomps · ${c.projects.length} project${c.projects.length === 1 ? '' : 's'}`
  $('#lxCount').textContent = c.projects.length || ''
  document.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === tab))
  $('main').className = 'lx'
  $('#title').textContent = tab === 'lxsettings' ? 'Settings' : 'Projects'
  $('main .hd use').setAttribute('href', tab === 'lxsettings' ? '#i-sliders' : '#i-package')
  const warn = window.platform === 'win32' ? '' : `<div class="banner warn">${ic('alert')}<div><p>Projects build and run on Windows. You can still edit the list here.</p></div></div>`
  const initials = n => esc(n.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase())
  $('#lxList').innerHTML = tab === 'lxsettings' ? `${warn}<form class="opts">
    <label>INSTANCE NAME<input id="lxName" value="${esc(c.name)}" maxlength="40"></label>
    <label>PROJECTS FOLDER<div class="codebox"><input id="lxRoot" value="${esc(c.root)}"><button type="button" data-lx="pickRoot">${ic('folder')}</button></div></label>
    <label><span>GAME EXE <span class="muted">(used as {game} in run and shader commands)</span></span><div class="codebox"><input id="lxGame" value="${esc(c.game)}" placeholder="Pick the game .exe"><button type="button" data-lx="pickGame">${ic('file')}</button></div></label>
    <label class="check"><input type="checkbox" id="lxAuto" class="switch" ${c.autoUpdate ? 'checked' : ''}> Pull updates before Launch</label>
    <p class="muted small">Projects are recomps: they are downloaded with git, built and run with your game. Each job opens its own PowerShell window.</p>
    <div class="row"><button type="button" class="danger" data-lx="hide">${ic('trash')} Remove from the sidebar</button></div>
    <p class="muted small">Removing keeps your projects and downloaded files; add it again with + → Recomps.</p></form>`
    : `${warn}<div id="lxTools"></div>${c.game ? '' : `<div class="banner warn">${ic('alert')}<div><p>Pick the game exe in <button class="linkish" data-lx="toSettings">Settings</button> before Launch or Prepare shaders.</p></div></div>`}
    ${c.projects.map(p => `<div class="mod lxp" data-name="${esc(p.name)}"><div class="noicon lxicon">${initials(p.name)}</div>
      <div class="body"><div class="top"><b>${esc(p.name)}</b><span class="tag">${esc(p.branch)}</span><span class="tag lxst">Checking…</span>${p.shaders?.length ? '<span class="tag">Shader prep</span>' : ''}</div><p>${esc(p.repo)}</p></div>
      <div class="actions"><button class="play" data-lx="launch">${ic('play')} Launch</button>
        <button data-lx="update" title="Pull and build">${ic('refresh')}</button><button data-lx="rebuild" title="Rebuild">${ic('wrench')}</button>
        ${p.shaders?.length ? `<button data-lx="shaders" title="Prepare shaders: build if needed, then compile the game's shaders ahead so the first start doesn't stutter">${ic('flame')}</button>` : ''}
        <button class="icon" data-lx="folder" title="Open folder">${ic('folder')}</button><button class="icon" data-lx="edit" title="Edit">${ic('pencil')}</button><button class="icon" data-lx="remove" title="Remove">${ic('trash')}</button></div></div>`).join('')
      || `<div class="hint">${ic('package')}<b>No projects yet</b><span>Add a recomp's GitHub repository below.</span></div>`}
    ${e ? `<form id="lxForm" class="opts lxform"><h3>${e.name ? 'Edit ' + esc(e.name) : 'Add project'}</h3>
      <div class="row"><label>NAME<input name="name" value="${esc(e.name)}" required></label><label>BRANCH<input name="branch" value="${esc(e.branch)}"></label></div>
      <label>GITHUB REPOSITORY<input name="repo" value="${esc(e.repo)}" placeholder="https://github.com/owner/repo" required></label>
      <label><span>BUILD COMMANDS <span class="muted">(one per line, PowerShell)</span></span><textarea name="build" rows="3" placeholder="cargo build --release --locked">${esc(e.build.join('\n'))}</textarea></label>
      <label><span>SHADER PREP COMMANDS <span class="muted">(optional, one per line; {game} = game exe)</span></span><textarea name="shaders" rows="2" placeholder=".\\target\\release\\victory.exe preload ([IO.Path]::GetDirectoryName('{game}'))">${esc((e.shaders || []).join('\n'))}</textarea></label>
      <label><span>RUN COMMAND <span class="muted">({game} = game exe)</span></span><input name="run" value="${esc(e.run)}" placeholder=".\\target\\release\\app.exe"></label>
      <div class="row"><button type="button" data-lx="cancel">Cancel</button><button class="primary">${ic('check')} Save project</button></div></form>`
    : `<button type="button" data-lx="add">${ic('plus')} Add project</button>`}`
  if (tab === 'lxprojects') api.lxTools().then(miss => {
    if (miss.length && $('#lxTools')) $('#lxTools').innerHTML = `<div class="banner warn">${ic('wrench')}<div><b>Needed to build: ${esc(miss.map(t => t.label).join(', '))}</b>
      <p>Installs with winget (Windows' own installer) in a PowerShell window. The C++ build tools are several GB and ask for admin rights.</p></div>
      <button data-lx="recheck">Check again</button><button class="primary" data-lx="tools" data-ids="${esc(miss.map(t => t.id).join(','))}">${ic('download')} Install</button></div>`
  }, () => {})
  for (const el of document.querySelectorAll('#lxList .lxp')) api.lxStatus(el.dataset.name).then(t => {
    const tg = el.querySelector('.lxst'); tg.textContent = t; tg.classList.toggle('upd', /Update|not built/.test(t))
  }, () => {})
}
$('#lxList').addEventListener('change', e => {
  if (e.target.id === 'lxName') return run(() => api.lxSave({ name: e.target.value })).then(c => c && (lxName = c.name, render()))
  const patch = e.target.id === 'lxRoot' ? { root: e.target.value.trim() } : e.target.id === 'lxGame' ? { game: e.target.value.trim() } : e.target.id === 'lxAuto' ? { autoUpdate: e.target.checked } : null
  if (patch) run(() => api.lxSave(patch))
})
$('#lxList').addEventListener('click', async e => {
  const b = e.target.closest('[data-lx]'); if (!b) return
  const a = b.dataset.lx, name = b.closest('.lxp')?.dataset.name
  if (a === 'toSettings') { tab = 'lxsettings'; return render() }
  if (a === 'tools' && await run(() => api.lxInstallTools(b.dataset.ids.split(',')))) toast('Installing in a PowerShell window — press Check again when it says Done')
  if (a === 'recheck') { b.disabled = true; drawLx() }
  if (a === 'hide' && confirm(`Remove ${lxName} from the sidebar?`)) { await run(() => api.lxSave({ enabled: false })); lxOn = lxView = false; tab = 'browse'; return render() }
  if (a === 'pickRoot') { const d = await api.pickFolder(); if (d) await run(() => api.lxSave({ root: d })), drawLx() }
  if (a === 'pickGame') { const f = await api.openFile(['exe']); if (f) await run(() => api.lxSave({ game: f })), drawLx() }
  if (a === 'launch' || a === 'update' || a === 'rebuild' || a === 'shaders') {
    const steps = { launch: 'launch', update: ['update', 'build'], rebuild: ['build', 'force'], shaders: ['build', 'shaders'] }[a]
    if (await run(() => api.lxRun(name, steps))) toast(a === 'shaders' ? `${name}: preparing shaders in a PowerShell window (can take several minutes)` : `${name}: running in a PowerShell window`)
  }
  if (a === 'folder') api.openFolder(await api.lxDir(name))
  if (a === 'edit' || a === 'add') { lxEdit = a === 'add' ? '' : name; await drawLx(); $('#lxForm')?.scrollIntoView({ block: 'nearest' }) }
  if (a === 'cancel') { lxEdit = null; drawLx() }
  if (a === 'remove' && confirm(`Remove ${name} from the list?`)) {
    const del = confirm(`Also permanently delete its downloaded files?\n${await api.lxDir(name)}`)
    if (await run(() => api.lxRemove(name, del))) drawLx()
  }
})
$('#lxList').addEventListener('submit', async e => {
  e.preventDefault(); if (e.target.id !== 'lxForm') return
  if (await run(() => api.lxPut(Object.fromEntries(new FormData(e.target)), lxEdit || undefined))) { lxEdit = null; drawLx(); toast('Project saved') }
})
