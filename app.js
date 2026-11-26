// Vanilla DOM renderer. Skipped: framework, router, state library; native <dialog> for modals.
const $ = s => document.querySelector(s)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
const fmt = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : n ?? ''
let profiles = [], cur = null, tab = 'browse', page = 1, timer

const toast = msg => {
  const t = $('#toast'); t.textContent = msg; t.hidden = false
  clearTimeout(t.timer); t.timer = setTimeout(() => t.hidden = true, 5000)
}
const run = async fn => {
  try { return await fn() } catch (e) { toast(e.message.replace(/^Error invoking remote method '\w+': (Error: )?/, '')) }
}

async function refresh(id) {
  profiles = await api.listProfiles()
  cur = profiles.find(p => p.id === (id ?? cur?.id)) || profiles[0] || null
  render()
}

function render() {
  $('#rail').innerHTML = profiles.map(p =>
    `<button class="pfp ${p.id === cur?.id ? 'on' : ''}" data-id="${p.id}" title="${esc(p.name)}">${esc(p.name.slice(0, 2))}</button>`
  ).join('') + '<button class="pfp add" id="add" title="New profile">+</button>'
  $('#app').classList.toggle('empty', !cur)
  if (!cur) return
  document.body.classList.toggle('mc', cur.type === 'modrinth')
  $('#pname').textContent = cur.name
  $('#pmeta').textContent = cur.type === 'modrinth' ? `Minecraft ${cur.mc.version} · ${cur.mc.loader}` : cur.game
  $('#target').textContent = cur.target || 'Not set — pick the game folder'
  $('#count').textContent = cur.mods.length || ''
  document.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === tab))
  $('main').className = tab
  tab === 'browse' ? search() : showInstalled()
}

const card = (m, installed) => `<div class="mod">
  ${m.icon ? `<img src="${esc(m.icon)}" alt="" loading="lazy">` : '<div class="noicon"></div>'}
  <div><b>${esc(m.title)}</b> <small>${esc(m.author)}${m.downloads != null ? ' · ⬇ ' + fmt(m.downloads) : ''}</small><p>${esc(m.desc)}</p></div>
  <button data-mod="${esc(m.id)}" class="${installed ? 'rm' : ''}">${installed ? 'Remove' : 'Install'}</button>
</div>`

async function search(append) {
  const id = cur.id
  if (!append) page = 1, $('#list').innerHTML = '<p class="muted">Loading…</p>'
  const res = await run(() => api.search(id, $('#q').value, page, $('#kind').value))
  if (!res || cur?.id !== id || tab !== 'browse') return
  const have = new Set(cur.mods.map(m => m.id))
  $('#more')?.remove()
  const html = res.map(m => card(m, have.has(m.id))).join('') + (res.length === 20 ? '<button id="more">Load more</button>' : '')
  append ? $('#list').insertAdjacentHTML('beforeend', html) : $('#list').innerHTML = html || '<p class="muted">Nothing found.</p>'
}

function showInstalled() {
  $('#list').innerHTML = cur.mods.map(m => card({ ...m, title: m.name, author: 'v' + m.version, desc: m.id }, true)).join('')
    || '<p class="muted">No mods yet. Head to #browse.</p>'
}

$('#rail').onclick = e => {
  const b = e.target.closest('button'); if (!b) return
  if (b.id === 'add') return openNew()
  cur = profiles.find(p => p.id === b.dataset.id); tab = 'browse'; render()
}
$('#tabs').onclick = e => { const b = e.target.closest('[data-tab]'); if (b) tab = b.dataset.tab, render() }
$('#q').oninput = () => { clearTimeout(timer); timer = setTimeout(() => search(), 300) }
$('#kind').onchange = () => search()

$('#list').onclick = async e => {
  if (e.target.id === 'more') return page++, search(true)
  const b = e.target.closest('[data-mod]'); if (!b) return
  const remove = b.classList.contains('rm'), id = cur.id
  b.disabled = true; b.textContent = remove ? 'Removing…' : 'Installing…'
  const p = await run(() => remove ? api.uninstall(id, b.dataset.mod) : api.install(id, b.dataset.mod))
  if (!p) return b.disabled = false, b.textContent = remove ? 'Remove' : 'Install'
  profiles = profiles.map(x => x.id === p.id ? p : x)
  if (cur?.id !== p.id) return
  cur = p; $('#count').textContent = p.mods.length || ''
  if (tab === 'installed') return showInstalled()
  b.disabled = false; b.classList.toggle('rm', !remove); b.textContent = remove ? 'Install' : 'Remove'
}

$('#pick').onclick = async () => {
  const dir = await api.pickFolder()
  if (dir) await run(async () => { await api.updateProfile(cur.id, { target: dir }); await refresh() })
}
$('#open').onclick = async () => api.openFolder(`${await api.profilesDir()}/${cur.id}/files`)
$('#deploy').onclick = () => run(async () => {
  if (!cur.target) return toast('Pick the target folder first')
  const p = await api.deploy(cur.id); toast(`Deployed ${p.deployed.length} files to ${p.target}`)
})
$('#share').onclick = () => run(async () => { $('#code').value = await api.exportCode(cur.id); $('#shareDlg').showModal() })
$('#copy').onclick = () => navigator.clipboard.writeText($('#code').value).then(() => toast('Copied — paste it to your friends'))
$('#closeShare').onclick = () => $('#shareDlg').close()
$('#del').onclick = () => confirm(`Delete profile "${cur.name}" and its downloaded mods? Deployed files stay in the target folder.`)
  && run(async () => { await api.deleteProfile(cur.id); cur = null; await refresh() })

async function openNew() {
  $('#newForm').reset(); $('#newDlg').showModal()
  if ($('#vers').options.length) return
  const [games, vers] = await Promise.all([run(api.communities), run(api.mcVersions)])
  $('#games').innerHTML = (games || []).map(g => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('')
  $('#vers').innerHTML = (vers || []).map(v => `<option>${esc(v)}</option>`).join('')
}
$('#start').onclick = openNew
$('#cancel').onclick = () => $('#newDlg').close()
$('#newForm').onsubmit = async e => {
  e.preventDefault()
  const f = Object.fromEntries(new FormData(e.target)), btn = $('#createBtn')
  btn.disabled = true; btn.textContent = f.code.trim() ? 'Importing…' : 'Creating…'
  const res = await run(() => f.code.trim()
    ? api.importCode(f.code, f.name.trim())
    : api.createProfile({ name: f.name.trim() || f.game || `Minecraft ${f.version}`, type: f.type, game: f.game.trim(), mc: { version: f.version, loader: f.loader } }))
  btn.disabled = false; btn.textContent = 'Create'
  if (!res) return
  $('#newDlg').close(); tab = 'browse'
  if (res.failed?.length) toast(`Imported with ${res.failed.length} failed: ${res.failed.join('; ')}`)
  await refresh(res.profile?.id ?? res.id)
}

refresh()
