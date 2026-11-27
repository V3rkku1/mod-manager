const { contextBridge, ipcRenderer, webUtils } = require('electron')
const names = ['listProfiles', 'createProfile', 'updateProfile', 'deleteProfile', 'getSettings', 'saveSettings',
  'games', 'mcVersions', 'search', 'details', 'pageUrl', 'install', 'uninstall', 'setDisabled', 'checkUpdates', 'update',
  'deploy', 'findGame', 'launch', 'exportCode', 'exportR2', 'exportFile', 'importFile', 'importCode', 'handleNxm',
  'accounts', 'loginStart', 'loginFinish', 'setActiveAccount', 'removeAccount', 'running', 'getLog', 'stop', 'play', 'repair',
  'worlds', 'logFiles', 'readLog', 'addLocal', 'exportMrpack', 'importInstance', 'duplicate', 'unlinkPack', 'setAllDisabled', 'filters',
  'updateMod', 'orphans', 'conflicts', 'preview', 'sync', 'publish', 'follow', 'checkFollow', 'analyzeCrash', 'javaList',
  'serverStatus', 'serverCmd', 'serverStop', 'serverStart', 'serverShare', 'inviteCode', 'serverRestart', 'serverProps', 'setServerProps',
  'serverPlayers', 'playerAction', 'backups', 'backup', 'restoreBackup', 'deleteBackup',
  'setServerKind', 'setServerIcon', 'sha1Url', 'resetPlayer', 'pluginSearch', 'pluginInstall', 'pluginRemove', 'shareLog', 'updateLoader', 'diagnostics',
  'pickFolder', 'saveFile', 'openFile', 'openFolder', 'openProfileFolder', 'openExternal', 'profilesDir', 'installUpdate', 'titlebar', 'playitStatus', 'playitLinkStart', 'playitLinkFinish', 'playitUnlink']
contextBridge.exposeInMainWorld('api', Object.fromEntries(names.map(n => [n, (...a) => ipcRenderer.invoke(n, ...a)])))
contextBridge.exposeInMainWorld('platform', process.platform)
contextBridge.exposeInMainWorld('filePath', f => webUtils.getPathForFile(f))
contextBridge.exposeInMainWorld('onUpdateReady', cb => ipcRenderer.on('updateReady', (_, v) => cb(v)))
contextBridge.exposeInMainWorld('onLink', cb => ipcRenderer.on('link', (_, l) => cb(l)))
contextBridge.exposeInMainWorld('onNxm', cb => ipcRenderer.on('nxm', (_, l) => cb(l)))
contextBridge.exposeInMainWorld('onEvent', cb => ipcRenderer.on('event', (_, e, d) => cb(e, d)))
