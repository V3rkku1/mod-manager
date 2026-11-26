const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path = require('path')
const { autoUpdater } = require('electron-updater')

app.whenReady().then(() => {
  const core = require('./core')(path.join(app.getPath('userData'), 'profiles'))
  for (const [k, fn] of Object.entries(core)) ipcMain.handle(k, (_, ...a) => fn(...a))
  ipcMain.handle('pickFolder', async () => (await dialog.showOpenDialog({ properties: ['openDirectory'] })).filePaths[0])
  ipcMain.handle('openFolder', (_, p) => shell.openPath(p))
  ipcMain.handle('openExternal', (_, u) => /^https:\/\/(thunderstore\.io|modrinth\.com)\//.test(u) && shell.openExternal(u))
  ipcMain.handle('profilesDir', () => path.join(app.getPath('userData'), 'profiles'))
  ipcMain.handle('installUpdate', () => autoUpdater.quitAndInstall())
  const win = new BrowserWindow({
    width: 1240, height: 780, minWidth: 900, minHeight: 560, backgroundColor: '#313338', show: true,
    icon: path.join(__dirname, 'build/icon.png'),
    titleBarStyle: 'hidden', titleBarOverlay: { color: '#1e1f22', symbolColor: '#b5bac1', height: 32 },
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  })
  win.loadFile('index.html')
  // Checks GitHub Releases, downloads in background, installs on quit. Only the installed (NSIS/AppImage) build can self-update.
  autoUpdater.on('update-downloaded', i => win.webContents.send('updateReady', i.version))
  const check = () => autoUpdater.checkForUpdates().catch(() => {})
  if (app.isPackaged) check(), setInterval(check, 3600e3)
})
app.on('window-all-closed', () => app.quit())
