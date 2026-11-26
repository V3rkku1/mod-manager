const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = require('electron')
const path = require('path')
const { autoUpdater } = require('electron-updater')

let win
const nxmArg = argv => argv.find(a => a.startsWith('nxm://'))
if (!app.requestSingleInstanceLock()) app.quit()
// Nexus "Mod Manager Download" opens nxm:// links; Windows starts a 2nd instance with the link as an argument.
app.on('second-instance', (_, argv) => {
  if (win) win.isMinimized() && win.restore(), win.focus()
  const link = nxmArg(argv); if (link) win?.webContents.send('nxm', link)
})

app.whenReady().then(() => {
  const secure = safeStorage.isEncryptionAvailable()
  const core = require('./core')(path.join(app.getPath('userData'), 'profiles'), {
    emit: (event, data) => win?.webContents.send('event', event, data),
    encrypt: s => s && secure ? 'enc:' + safeStorage.encryptString(s).toString('base64') : s,
    decrypt: s => s?.startsWith('enc:') ? safeStorage.decryptString(Buffer.from(s.slice(4), 'base64')) : s,
  })
  const nxmProtocol = on => app.isPackaged && (on ? app.setAsDefaultProtocolClient('nxm') : app.removeAsDefaultProtocolClient('nxm'))
  nxmProtocol(!!core.getSettings().nxmHandler)
  for (const [k, fn] of Object.entries(core)) ipcMain.handle(k, async (_, ...a) => {
    try { return await fn(...a) } catch (e) { if (e.open) shell.openExternal(e.open); throw e }
  })
  ipcMain.handle('saveSettings', async (_, s) => { const r = await core.setSettings(s); nxmProtocol(!!r.nxmHandler); return r })
  ipcMain.handle('pickFolder', async () => (await dialog.showOpenDialog({ properties: ['openDirectory'] })).filePaths[0])
  const FILTERS = { mmpack: 'Mod Manager profile', mrpack: 'Modrinth modpack' }
  ipcMain.handle('saveFile', async (_, name, ext = 'mmpack') => (await dialog.showSaveDialog({ defaultPath: name, filters: [{ name: FILTERS[ext], extensions: [ext] }] })).filePath)
  ipcMain.handle('openFile', async (_, exts = ['mmpack']) => (await dialog.showOpenDialog({ filters: [{ name: 'Profile or modpack', extensions: exts }] })).filePaths[0])
  ipcMain.handle('openFolder', (_, p) => shell.openPath(p))
  ipcMain.handle('openProfileFolder', async (_, id, sub = '') => { const p = (await core.listProfiles()).find(p => p.id === id); return p && shell.openPath(path.join(sub === 'files' ? path.join(app.getPath('userData'), 'profiles', id, 'files') : p.target, sub === 'files' ? '' : sub)) })
  ipcMain.handle('openExternal', (_, u) => /^https:\/\//.test(u) && shell.openExternal(u))
  ipcMain.handle('profilesDir', () => path.join(app.getPath('userData'), 'profiles'))
  ipcMain.handle('installUpdate', () => autoUpdater.quitAndInstall())

  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 940, minHeight: 580, backgroundColor: '#313338',
    icon: path.join(__dirname, 'build/icon.png'),
    titleBarStyle: 'hidden', titleBarOverlay: { color: '#1e1f22', symbolColor: '#b5bac1', height: 32 },
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  })
  win.loadFile('index.html')
  win.webContents.once('did-finish-load', () => { const l = nxmArg(process.argv); if (l) win.webContents.send('nxm', l) })

  // Checks GitHub Releases, downloads in background, installs on quit. Only the installed (NSIS) build can self-update.
  autoUpdater.on('update-downloaded', i => win.webContents.send('updateReady', i.version))
  const check = () => autoUpdater.checkForUpdates().catch(() => {})
  if (app.isPackaged) check(), setInterval(check, 3600e3)
})
app.on('window-all-closed', () => app.quit())
