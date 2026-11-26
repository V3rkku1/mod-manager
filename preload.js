const { contextBridge, ipcRenderer } = require('electron')
const names = ['listProfiles', 'createProfile', 'updateProfile', 'deleteProfile', 'getSettings', 'saveSettings',
  'games', 'mcVersions', 'search', 'details', 'pageUrl', 'install', 'uninstall', 'setDisabled', 'checkUpdates', 'update',
  'deploy', 'findGame', 'launch', 'exportCode', 'exportR2', 'exportFile', 'importFile', 'importCode', 'handleNxm',
  'pickFolder', 'saveFile', 'openFile', 'openFolder', 'openExternal', 'profilesDir', 'installUpdate']
contextBridge.exposeInMainWorld('api', Object.fromEntries(names.map(n => [n, (...a) => ipcRenderer.invoke(n, ...a)])))
contextBridge.exposeInMainWorld('platform', process.platform)
contextBridge.exposeInMainWorld('onUpdateReady', cb => ipcRenderer.on('updateReady', (_, v) => cb(v)))
contextBridge.exposeInMainWorld('onNxm', cb => ipcRenderer.on('nxm', (_, l) => cb(l)))
