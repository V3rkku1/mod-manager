// Vanilla DOM renderer. Skipped: framework, router, state library; native <dialog> for modals, SVG sprite for icons.
const $ = s => document.querySelector(s)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
const fmt = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : n ?? ''
const ic = (name, cls = 'i') => `<svg class="${cls}"><use href="#i-${name}"/></svg>`
const pageUrl = id => cur.type === 'modrinth' ? `https://modrinth.com/project/${id}`
  : `https://thunderstore.io/c/${cur.game}/p/${id.slice(0, id.lastIndexOf('-'))}/${id.slice(id.lastIndexOf('-') + 1)}/`
let profiles = [], cur = null, tab = 'browse', page = 1, timer, games = null, updates = {}
if (window.platform === 'darwin') document.body.classList.add('mac')

const toast = (msg, err) => {
  const t = document.createElement('div')
  t.className = 'toast' + (err ? ' err' : '')
  t.innerHTML = ic(err ? 'alert' : 'check') + `<span>${esc(msg)}</span>`
  $('#toasts').append(t); setTimeout(() => t.remove(), err ? 7000 : 3500)
}
const run = async fn => {
  try { return await fn() } catch (e) { toast(e.message.replace(/^Error invoking remote method '\w+': (Error: )?/, ''), true) }
}
const setProfile = p => { profiles = profiles.map(x => x.id === p.id ? p : x); if (cur?.id === p.id) cur = p }

async function refresh(id) {
  profiles = await api.listProfiles()
  cur = profiles.find(p => p.id === (id ?? cur?.id)) || profiles[0] || null
  render()
}

const avatar = p => p.icon ? `<img src="${esc(p.icon)}" alt="">` : p.type === 'modrinth' ? ic('grass', '') : esc(p.name.slice(0, 2).toUpperCase())

function render() {
  $('#rail').innerHTML = profiles.map(p => `<button class="pfp ${p.id === cur?.id ? 'on' : ''}" data-id="${p.id}" data-tip="${esc(p.name)}">${avatar(p)}</button>`).join('')
    + (profiles.length ? '<div class="sep"></div>' : '') + `<button class="pfp add" id="add" data-tip="New profile">${ic('plus')}</button>`
  $('#app').classList.toggle('empty', !cur)
  if (!cur) return
  const mc = cur.type === 'modrinth'
  document.body.classList.toggle('mc', mc)
  document.body.classList.toggle('mc-banner', mc)
  $('#banner').style.backgroundImage = cur.banner ? `url("${encodeURI(cur.banner)}")` : ''
  $('#pname').textContent = cur.name
  $('#pmeta').textContent = mc ? `Minecraft ${cur.mc.version} · ${cur.mc.loader}` : cur.game
  $('#target').textContent = cur.target || 'Not set — click the pencil'
  $('#target').title = cur.target || ''
  $('#target').classList.toggle('unset', !cur.target)
  $('#q').placeholder = mc ? 'Search Modrinth' : 'Search Thunderstore'
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

const card = (m, installed) => `<div class="mod" data-id="${esc(m.id)}">
  ${m.icon ? `<img src="${esc(m.icon)}" alt="" loading="lazy">` : '<div class="noicon"></div>'}
  <div class="body"><div class="top"><b>${esc(m.title)}</b><small>by ${esc(m.author)}</small>
  ${m.downloads != null ? `<small>${ic('download', 'i sm')} ${fmt(m.downloads)}</small>` : ''}</div><p>${esc(m.desc)}</p></div>
  <div class="actions">
    <button class="icon" data-act="link" title="Open mod page">${ic('external')}</button>
    <button class="act ${installed ? 'done' : ''}" data-act="toggle">${installed
      ? `<span class="a">${ic('check')} Installed</span><span class="b">${ic('trash')} Remove</span>` : `${ic('download')} Install`}</button>
  </div></div>`

const row = m => {
  const up = updates[cur.id]?.[m.id]
  return `<div class="mod ${m.disabled ? 'off' : ''}" data-id="${esc(m.id)}">
  ${m.icon ? `<img src="${esc(m.icon)}" alt="" loading="lazy">` : '<div class="noicon"></div>'}
  <div class="body"><div class="top"><b>${esc(m.name)}</b><span class="tag">v${esc(m.version)}</span>${up ? `<span class="tag upd">→ v${esc(up)}</span>` : ''}</div>
  <p>${esc(m.id)} · ${m.files.length} file${m.files.length === 1 ? '' : 's'}</p></div>
  <div class="actions">
    ${up ? `<button class="upd" data-act="update">${ic('up')} Update</button>` : ''}
    <button class="icon" data-act="link" title="Open mod page">${ic('external')}</button>
    <button class="icon" data-act="remove" title="Remove">${ic('trash')}</button>
    <input type="checkbox" class="switch" data-act="enable" title="Enabled" ${m.disabled ? '' : 'checked'}>
  </div></div>`
}

async function search(append) {
  const id = cur.id
  if (!append) page = 1, $('#list').innerHTML = '<div class="skel"></div>'.repeat(6)
  const res = await run(() => api.search(id, $('#q').value, page, $('#kind').value, $('#sort').value))
  if (!res || cur?.id !== id || tab !== 'browse') return
  const have = new Set(cur.mods.map(m => m.id))
  $('#more')?.remove()
  const html = res.map(m => card(m, have.has(m.id))).join('') + (res.length === 20 ? `<button id="more">Load more</button>` : '')
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

// Discord-style tooltips for the rail
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
  cur = profiles.find(p => p.id === b.dataset.id); tab = 'browse'; $('#q').value = ''; render()
}
$('#tabs').onclick = e => {
  const b = e.target.closest('[data-tab]'); if (!b) return
  tab = b.dataset.tab; render()
  if (tab === 'installed' && !updates[cur.id] && cur.mods.length) checkUpdates(true)
}
$('#q').oninput = () => { clearTimeout(timer); timer = setTimeout(() => search(), 300) }
$('#kind').onchange = $('#sort').onchange = () => search()
$('#checkUpd').onclick = () => checkUpdates()
$('#updAll').onclick = async () => {
  const id = cur.id, ids = Object.keys(updates[id] || {}), b = $('#updAll')
  b.disabled = true
  for (const [i, mod] of ids.entries()) {
    b.lastChild.textContent = ` Updating ${i + 1}/${ids.length}…`
    const p = await run(() => api.update(id, mod))
    if (p) setProfile(p), delete updates[id][mod]
  }
  b.disabled = false
  if (cur?.id === id) render()
  toast('Updates finished — deploy to apply them')
}

$('#list').onclick = async e => {
  if (e.target.id === 'more') return page++, search(true)
  const b = e.target.closest('[data-act]'), modId = e.target.closest('.mod')?.dataset.id
  if (!b || !modId || b.dataset.act === 'enable') return
  const id = cur.id, act = b.dataset.act
  if (act === 'link') return api.openExternal(pageUrl(modId))
  const remove = act === 'remove' || (act === 'toggle' && b.classList.contains('done'))
  const html = b.innerHTML
  b.disabled = true
  b.innerHTML = `${ic('refresh', 'i spin')} ${act === 'update' ? 'Updating' : remove ? 'Removing' : 'Installing'}…`
  const p = await run(() => act === 'update' ? api.update(id, modId) : remove ? api.uninstall(id, modId) : api.install(id, modId))
  if (!p) return b.disabled = false, b.innerHTML = html
  if (act === 'update') delete updates[id]?.[modId]
  setProfile(p)
  if (cur?.id !== id) return
  updateBadges()
  if (tab === 'installed') return showInstalled()
  b.disabled = false
  b.classList.toggle('done', !remove)
  b.innerHTML = remove ? `${ic('download')} Install` : `<span class="a">${ic('check')} Installed</span><span class="b">${ic('trash')} Remove</span>`
  if (!remove) toast(`Installed ${b.closest('.mod').querySelector('b').textContent}` + (p.mods.length > 1 ? ' (+ dependencies)' : ''))
}
$('#list').onchange = async e => {
  if (e.target.dataset.act !== 'enable') return
  const p = await run(() => api.setDisabled(cur.id, e.target.closest('.mod').dataset.id, !e.target.checked))
  if (p) setProfile(p), e.target.closest('.mod').classList.toggle('off', !e.target.checked)
}

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
$('#open').onclick = async () => api.openFolder(`${await api.profilesDir()}/${cur.id}/files`)
$('#deploy').onclick = () => run(async () => {
  if (!cur.target) return toast('Pick the target folder first (pencil next to TARGET FOLDER)', true)
  const p = await api.deploy(cur.id); setProfile(p)
  toast(`Deployed ${p.deployed.length} files — start the game!`)
})
$('#share').onclick = () => run(async () => { $('#code').value = await api.exportCode(cur.id); $('#shareDlg').showModal(); $('#code').select() })
$('#copy').onclick = () => navigator.clipboard.writeText($('#code').value).then(() => { $('#shareDlg').close(); toast('Copied — paste it to your friends') })
$('#del').onclick = () => confirm(`Delete profile "${cur.name}" and its downloaded mods?\nFiles already deployed stay in the target folder.`)
  && run(async () => { await api.deleteProfile(cur.id); cur = null; await refresh() })
document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => b.closest('dialog').close())

// New profile dialog
let picked = null
const showGames = () => {
  const f = $('#gameQ').value.toLowerCase()
  $('#games').innerHTML = (games || []).filter(g => g.name.toLowerCase().includes(f)).map(g =>
    `<button type="button" class="game ${g.id === picked?.id ? 'on' : ''}" data-id="${esc(g.id)}"><img src="${esc(g.cover || g.icon)}" alt="" loading="lazy"><span>${esc(g.name)}</span></button>`
  ).join('') || '<p class="muted">Loading games…</p>'
}
$('#gameQ').oninput = showGames
$('#games').onclick = e => {
  const b = e.target.closest('.game'); if (!b) return
  picked = games.find(g => g.id === b.dataset.id); showGames()
}
async function openNew(mode = 'thunderstore') {
  $('#newForm').reset(); picked = null
  $(`[name=type][value=${mode}]`).checked = true
  $('#newDlg').showModal(); showGames()
  if (games) return
  const [g, vers] = await Promise.all([run(api.communities), run(api.mcVersions)])
  games = g || []; showGames()
  $('#vers').innerHTML = (vers || []).map(v => `<option>${esc(v)}</option>`).join('')
}
$('#start').onclick = () => openNew()
$('#startImport').onclick = () => openNew('import')
$('#newForm').onsubmit = async e => {
  e.preventDefault()
  const f = Object.fromEntries(new FormData(e.target)), btn = $('#createBtn'), name = f.name.trim()
  if (f.type === 'thunderstore' && !picked) return toast('Pick a game first', true)
  if (f.type === 'import' && !f.code.trim()) return toast('Paste a share code first', true)
  btn.disabled = true; btn.textContent = f.type === 'import' ? 'Importing mods…' : 'Creating…'
  const res = await run(() => f.type === 'import' ? api.importCode(f.code, name)
    : f.type === 'modrinth' ? api.createProfile({ name: name || `Minecraft ${f.version}`, type: 'modrinth', mc: { version: f.version, loader: f.loader } })
    : api.createProfile({ name: name || picked.name, type: 'thunderstore', game: picked.id, icon: picked.icon, banner: picked.banner }))
  btn.disabled = false; btn.textContent = 'Create'
  if (!res) return
  $('#newDlg').close(); tab = res.profile ? 'installed' : 'browse'; $('#q').value = ''
  if (res.failed?.length) toast(`Imported, but ${res.failed.length} failed: ${res.failed.join('; ')}`, true)
  else if (res.profile) toast(`Imported ${res.profile.mods.length} mods`)
  await refresh(res.profile?.id ?? res.id)
}

refresh()
