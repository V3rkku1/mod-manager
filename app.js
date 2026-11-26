// Vanilla DOM renderer. Skipped: framework, router, state library; native <dialog> for modals, SVG sprite for icons.
const $ = s => document.querySelector(s)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
const fmt = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : n ?? ''
const ic = (name, cls = 'i') => `<svg class="${cls}"><use href="#i-${name}"/></svg>`
const SRC = { thunderstore: 'Thunderstore', modrinth: 'Modrinth', curseforge: 'CurseForge', nexus: 'Nexus Mods', gamebanana: 'GameBanana' }
const PICK_TYPES = ['thunderstore', 'curseforge', 'nexus', 'gamebanana']
let profiles = [], cur = null, tab = 'browse', page = 1, timer, updates = {}, picked = null
const gameCache = {}
if (window.platform === 'darwin') document.body.classList.add('mac')

const toast = (msg, err) => {
  const t = document.createElement('div')
  t.className = 'toast' + (err ? ' err' : '')
  t.innerHTML = ic(err ? 'alert' : 'check') + `<span>${esc(msg)}</span>`
  $('#toasts').append(t); setTimeout(() => t.remove(), err ? 8000 : 3500)
}
const run = async fn => {
  try { return await fn() } catch (e) { toast(e.message.replace(/^Error invoking remote method '\w+': (Error: )?/, ''), true) }
}
const setProfile = p => { profiles = profiles.map(x => x.id === p.id ? p : x); if (cur?.id === p.id) cur = p }
const curSrc = () => cur.type === 'modrinth' ? $('#src').value : cur.type
const srcOf = m => m.src || (cur.type === 'modrinth' ? 'modrinth' : cur.type)
const warn = p => p?.warn?.forEach(w => toast(w, true))

async function refresh(id) {
  profiles = await api.listProfiles()
  cur = profiles.find(p => p.id === (id ?? cur?.id)) || profiles[0] || null
  render()
}

const avatar = p => p.icon ? `<img src="${esc(p.icon)}" alt="">` : p.type === 'modrinth' ? ic('grass', '') : esc(p.name.slice(0, 2).toUpperCase())
const meta = p => p.type === 'modrinth' ? `Minecraft ${p.mc.version} · ${p.mc.loader}` : `${p.gameName || p.game} · ${SRC[p.type]}`

function render() {
  $('#rail').innerHTML = profiles.map(p => `<button class="pfp ${p.id === cur?.id ? 'on' : ''}" data-id="${p.id}" data-tip="${esc(p.name)}">${avatar(p)}</button>`).join('')
    + (profiles.length ? '<div class="sep"></div>' : '')
    + `<button class="pfp add" id="add" data-tip="New profile">${ic('plus')}</button>`
    + `<button class="pfp gear" id="settings" data-tip="Settings">${ic('gear')}</button>`
  $('#app').classList.toggle('empty', !cur)
  if (!cur) return
  const mc = cur.type === 'modrinth'
  document.body.classList.toggle('mc', mc)
  document.body.classList.toggle('mc-banner', mc && !cur.banner)
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
  $('#title').textContent = tab === 'browse' ? 'Browse' : 'Installed'
  $('main .hd use').setAttribute('href', tab === 'browse' ? '#i-compass' : '#i-package')
  tab === 'browse' ? search() : showInstalled()
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
  ${m.icon ? `<img src="${esc(m.icon)}" alt="" loading="lazy">` : '<div class="noicon"></div>'}
  <div class="body"><div class="top"><b>${esc(m.title)}</b>${m.author ? `<small>by ${esc(m.author)}</small>` : ''}
  ${m.downloads != null ? `<small>${ic('download', 'i sm')} ${fmt(m.downloads)}</small>` : ''}</div><p>${esc(m.desc)}</p></div>
  <div class="actions">
    <button class="icon" data-act="link" title="Open mod page">${ic('external')}</button>
    <button class="act ${installed ? 'done' : ''}" data-act="toggle">${installed ? installedBtn : `${ic('download')} Install`}</button>
  </div></div>`

const row = m => {
  const up = updates[cur.id]?.[m.id], src = srcOf(m)
  return `<div class="mod ${m.disabled ? 'off' : ''}" data-id="${esc(m.id)}" data-src="${src}">
  ${m.icon ? `<img src="${esc(m.icon)}" alt="" loading="lazy">` : '<div class="noicon"></div>'}
  <div class="body"><div class="top"><b>${esc(m.name)}</b><span class="tag">${esc(m.version)}</span>
  ${cur.type === 'modrinth' ? `<span class="tag src ${src}">${SRC[src]}</span>` : ''}${m.pack ? '<span class="tag pack">Modpack</span>' : ''}
  ${up ? `<span class="tag upd">→ ${esc(up)}</span>` : ''}</div>
  <p>${m.files.length} file${m.files.length === 1 ? '' : 's'}</p></div>
  <div class="actions">
    ${up ? `<button class="upd" data-act="update">${ic('up')} Update</button>` : ''}
    <button class="icon" data-act="link" title="Open mod page">${ic('external')}</button>
    <button class="icon" data-act="remove" title="Remove">${ic('trash')}</button>
    <input type="checkbox" class="switch" data-act="enable" title="Enabled" ${m.disabled ? '' : 'checked'}>
  </div></div>`
}

async function search(append) {
  const id = cur.id, src = curSrc()
  if (!append) page = 1, $('#list').innerHTML = '<div class="skel"></div>'.repeat(6)
  const res = await run(() => api.search(id, src, $('#q').value, page, { kind: $('#kind').value, sort: $('#sort').value }))
  if (cur?.id !== id || tab !== 'browse') return
  if (!res) return append || ($('#list').innerHTML = `<div class="hint">${ic('alert')}Couldn't load mods.</div>`)
  const have = new Set(cur.mods.map(m => m.id))
  $('#more')?.remove()
  const html = res.map(m => card(m, src, have.has(m.id))).join('') + (res.length >= 15 ? `<button id="more">Load more</button>` : '')
  if (append) $('#list').insertAdjacentHTML('beforeend', html)
  else $('#list').innerHTML = html || `<div class="hint">${ic('search')}No mods found.</div>`
}

function showInstalled() {
  $('#list').innerHTML = cur.mods.map(row).join('')
    || `<div class="hint">${ic('package')}<b>No mods yet</b><span>Find some in Browse.</span></div>`
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
  if (b.id === 'settings') return openSettings()
  cur = profiles.find(p => p.id === b.dataset.id); tab = 'browse'; $('#q').value = ''; render()
}
$('#tabs').onclick = e => {
  const b = e.target.closest('[data-tab]'); if (!b) return
  tab = b.dataset.tab; render()
  if (tab === 'installed' && !updates[cur.id] && cur.mods.length) checkUpdates(true)
}
$('#q').oninput = () => { clearTimeout(timer); timer = setTimeout(() => search(), 300) }
$('#kind').onchange = $('#sort').onchange = () => search()
$('#src').onchange = () => render()
$('#checkUpd').onclick = () => checkUpdates()
$('#updAll').onclick = async () => {
  const id = cur.id, ids = Object.keys(updates[id] || {}), b = $('#updAll')
  b.disabled = true
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
  const p = await run(() => api.install(cur.id, src, modId, vid))
  if (p) setProfile(p), warn(p)
  return p
}

$('#list').onclick = async e => {
  if (e.target.id === 'more') return page++, search(true)
  const el = e.target.closest('.mod'); if (!el) return
  const modId = el.dataset.id, src = el.dataset.src
  if (e.target.closest('.body')) return openDetails(src, modId)
  const b = e.target.closest('[data-act]')
  if (!b || b.dataset.act === 'enable') return
  const id = cur.id, act = b.dataset.act
  if (act === 'link') return api.openExternal(await api.pageUrl(id, src, modId))
  const remove = act === 'remove' || (act === 'toggle' && b.classList.contains('done'))
  const html = b.innerHTML
  b.disabled = true
  b.innerHTML = `${ic('refresh', 'i spin')} ${act === 'update' ? 'Updating' : remove ? 'Removing' : 'Installing'}…`
  const p = act === 'update' ? await run(() => api.update(id, modId)) : remove ? await run(() => api.uninstall(id, modId)) : await doInstall(src, modId)
  if (!p) return b.disabled = false, b.innerHTML = html
  if (act === 'update') delete updates[id]?.[modId], warn(p)
  setProfile(p)
  if (cur?.id !== id) return
  updateBadges()
  if (tab === 'installed') return showInstalled()
  b.disabled = false
  b.classList.toggle('done', !remove)
  b.innerHTML = remove ? `${ic('download')} Install` : installedBtn
  if (!remove) toast(`Installed ${el.querySelector('b').textContent}`)
}
$('#list').onchange = async e => {
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
    ${inst ? `<button class="act done" data-ver="remove">${installedBtn}</button>` : `<button class="act" data-ver="">${ic('download')} Install latest</button>`}</div></div>
    <div class="dtabs"><button data-pane="desc" class="${pane === 'desc' ? 'on' : ''}">Description</button>
    <button data-pane="vers" class="${pane === 'vers' ? 'on' : ''}">Versions (${d.versions.length})</button></div>
    <div class="dbody">${pane === 'desc'
      ? (d.gallery.length ? `<div class="gallery">${d.gallery.map(g => `<img src="${esc(g)}" alt="" loading="lazy">`).join('')}</div>` : '') + `<div class="desc">${toHtml(d)}</div>`
      : `<div class="vers">${d.versions.map(v => `<div class="ver"><div><b>${esc(v.name)}</b><small>${v.date ? new Date(v.date).toLocaleDateString() : ''}${v.tag ? ' · ' + esc(v.tag) : ''}${v.downloads != null ? ` · ${fmt(v.downloads)} downloads` : ''}</small></div>
        ${inst && String(inst.vid ?? inst.version) === String(v.vid) ? `<span class="tag">Installed</span>` : `<button data-ver="${esc(v.vid)}">${ic('download')} Install</button>`}</div>`).join('') || '<p class="muted">No versions for this game version / loader.</p>'}</div>`}</div>`
}
$('#detail').onclick = async e => {
  const t = e.target.closest('[data-pane]'); if (t) return renderDetails(t.dataset.pane)
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
$('#play').onclick = () => run(async () => { await deploy(); await api.launch(cur.id); toast('Mods deployed — starting game') })
$('#del').onclick = () => confirm(`Delete profile "${cur.name}" and its downloaded mods?\nFiles already deployed stay in the target folder.`)
  && run(async () => { await api.deleteProfile(cur.id); cur = null; await refresh() })
document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => b.closest('dialog').close())

// Share
$('#share').onclick = () => run(async () => {
  $('#code').value = await api.exportCode(cur.id)
  $('#r2code').value = ''; $('[data-copy=r2code]').hidden = true; $('#makeR2').hidden = false
  $('.tsOnly').hidden = cur.type !== 'thunderstore'
  $('#shareDlg').showModal(); $('#code').select()
})
$('#shareDlg').addEventListener('click', e => {
  const b = e.target.closest('[data-copy]'); if (!b) return
  navigator.clipboard.writeText($('#' + b.dataset.copy).value).then(() => toast('Copied — paste it to your friends'))
})
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

// Settings
async function openSettings() {
  const s = await api.getSettings(), f = $('#settingsForm')
  f.curseforgeKey.value = s.curseforgeKey || ''; f.nexusKey.value = s.nexusKey || ''; f.nxmHandler.checked = !!s.nxmHandler
  $('#settingsDlg').showModal()
}
$('#settingsForm').onsubmit = async e => {
  e.preventDefault()
  const f = e.target
  if (await run(() => api.saveSettings({ curseforgeKey: f.curseforgeKey.value.trim(), nexusKey: f.nexusKey.value.trim(), nxmHandler: f.nxmHandler.checked })))
    $('#settingsDlg').close(), toast('Settings saved'), Object.keys(gameCache).forEach(k => delete gameCache[k])
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
  $('#newForm').reset(); picked = null
  $(`[name=type][value=${mode}]`).checked = true
  $('#newDlg').showModal(); showGames()
  if (!$('#vers').options.length) $('#vers').innerHTML = ((await run(api.mcVersions)) || []).map(v => `<option>${esc(v)}</option>`).join('')
}
$('#start').onclick = () => openNew()
$('#startImport').onclick = () => openNew('import')

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
$('#importFile').onclick = async () => {
  const file = await api.openFile(); if (!file) return
  const btn = $('#importFile'); btn.disabled = true; btn.textContent = 'Importing mods…'
  const res = await run(() => api.importFile(file, $('#newForm').elements.name.value.trim()))
  btn.disabled = false; btn.innerHTML = `${ic('file')} Open .mmpack file instead`
  if (res) created(res)
}
$('#newForm').onsubmit = async e => {
  e.preventDefault()
  const f = Object.fromEntries(new FormData(e.target)), btn = $('#createBtn'), name = f.name.trim()
  if (PICK_TYPES.includes(f.type) && !picked) return toast('Pick a game first', true)
  if (f.type === 'import' && !f.code.trim()) return toast('Paste a share code first', true)
  btn.disabled = true; btn.textContent = f.type === 'import' ? 'Importing mods…' : 'Creating…'
  const res = await run(() => f.type === 'import' ? api.importCode(f.code, name, cur?.type === 'thunderstore' ? cur.game : null)
    : f.type === 'modrinth' ? api.createProfile({ name: name || `Minecraft ${f.version}`, type: 'modrinth', mc: { version: f.version, loader: f.loader } })
    : api.createProfile({ name: name || picked.name, type: f.type, game: picked.id, gameId: picked.gameId, gameName: picked.name,
      icon: picked.icon || picked.cover, banner: picked.banner || picked.cover }))
  btn.disabled = false; btn.textContent = 'Create'
  if (res) created(res)
}

// App self-update: main process downloads it, we offer a restart.
window.onUpdateReady?.(v => {
  const b = $('#updBar'); b.hidden = false
  b.querySelector('span').textContent = `Update ${v} ready — restart`
  b.onclick = () => api.installUpdate()
})
// Nexus "Mod Manager Download" links
window.onNxm?.(link => run(async () => {
  toast('Downloading from Nexus Mods…')
  const p = await api.handleNxm(link, cur?.id)
  warn(p); await refresh(p.id); toast(`Installed from Nexus: ${p.mods.at(-1)?.name}`)
}))

refresh()
