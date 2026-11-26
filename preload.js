const { contextBridge, ipcRenderer } = require('electron')
const names = ['listProfiles', 'createProfile', 'updateProfile', 'deleteProfile', 'communities', 'mcVersions', 'search',
  'install', 'uninstall', 'setDisabled', 'checkUpdates', 'update', 'deploy', 'exportCode', 'importCode',
  'pickFolder', 'openFolder', 'openExternal', 'profilesDir', 'installUpdate']
contextBridge.exposeInMainWorld('api', Object.fromEntries(names.map(n => [n, (...a) => ipcRenderer.invoke(n, ...a)])))
contextBridge.exposeInMainWorld('platform', process.platform)
contextBridge.exposeInMainWorld('onUpdateReady', cb => ipcRenderer.on('updateReady', (_, v) => cb(v)))
