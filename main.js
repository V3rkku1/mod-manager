const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path = require('path')

app.whenReady().then(() => {
  const core = require('./core')(path.join(app.getPath('userData'), 'profiles'))
  for (const [k, fn] of Object.entries(core)) ipcMain.handle(k, (_, ...a) => fn(...a))
  ipcMain.handle('pickFolder', async () => (await dialog.showOpenDialog({ properties: ['openDirectory'] })).filePaths[0])
  ipcMain.handle('openFolder', (_, p) => shell.openPath(p))
  ipcMain.handle('profilesDir', () => path.join(app.getPath('userData'), 'profiles'))
  new BrowserWindow({ width: 1180, height: 740, minWidth: 820, minHeight: 500, backgroundColor: '#313338', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') } }).loadFile('index.html')
})
app.on('window-all-closed', () => app.quit())
