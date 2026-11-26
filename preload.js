const { contextBridge, ipcRenderer } = require('electron')
const names = ['listProfiles', 'createProfile', 'updateProfile', 'deleteProfile', 'communities', 'mcVersions', 'search',
  'install', 'uninstall', 'deploy', 'exportCode', 'importCode', 'pickFolder', 'openFolder', 'profilesDir']
contextBridge.exposeInMainWorld('api', Object.fromEntries(names.map(n => [n, (...a) => ipcRenderer.invoke(n, ...a)])))
