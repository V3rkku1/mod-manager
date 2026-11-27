const { contextBridge, ipcRenderer, webUtils } = require('electron')
const names = ['listProfiles', 'createProfile', 'updateProfile', 'deleteProfile', 'getSettings', 'saveSettings',
  'games', 'mcVersions', 'search', 'details', 'pageUrl', 'install', 'uninstall', 'setDisabled', 'checkUpdates', 'update',
  'deploy', 'findGame', 'launch', 'exportCode', 'exportR2', 'exportFile', 'importFile', 'importCode', 'handleNxm',
  'accounts', 'loginStart', 'loginFinish', 'setActiveAccount', 'removeAccount', 'running', 'getLog', 'stop', 'play', 'repair',
  'worlds', 'logFiles', 'readLog', 'addLocal', 'exportMrpack', 'importInstance', 'duplicate', 'unlinkPack', 'splitPack', 'setAllDisabled', 'filters',
  'updateMod', 'orphans', 'conflicts', 'preview', 'sync', 'publish', 'follow', 'unfollow', 'checkFollow', 'analyzeCrash', 'javaList',
  'serverStatus', 'serverCmd', 'serverStop', 'serverStart', 'serverShare', 'inviteCode', 'serverRestart', 'serverProps', 'setServerProps',
  'serverPlayers', 'playerAction', 'backups', 'backup', 'restoreBackup', 'deleteBackup',
  'setServerKind', 'setServerIcon', 'sha1Url', 'resetPlayer', 'pluginSearch', 'pluginInstall', 'pluginRemove', 'shareLog', 'updateLoader', 'diagnostics',
  'pickFolder', 'saveFile', 'openFile', 'openFolder', 'openProfileFolder', 'openExternal', 'profilesDir', 'installUpdate', 'appVersion', 'checkUpdate', 'downloadUpdate', 'titlebar', 'playitStatus', 'playitLinkStart', 'playitLinkFinish', 'playitUnlink', 'syncStatus', 'setSyncDir', 'syncNow', 'syncPull', 'snapshot', 'snapshots', 'restoreSnapshot', 'changelog', 'setupStatus', 'playOfficial', 'playPrism', 'playCustom', 'addServer', 'lxConfig', 'lxSave', 'lxPut', 'lxRemove', 'lxStatus', 'lxRun', 'lxDir', 'lxTools', 'lxInstallTools', 'lxCatalog', 'lxLatest', 'removeServer',
  'moveMod', 'purge', 'fomodFinish', 'fomodCancel', 'loadOrder', 'setLoadOrder', 'setTools', 'runTool', 'collections', 'collectionMods', 'endorse']
contextBridge.exposeInMainWorld('api', Object.fromEntries(names.map(n => [n, (...a) => ipcRenderer.invoke(n, ...a)])))
contextBridge.exposeInMainWorld('platform', process.platform)
contextBridge.exposeInMainWorld('filePath', f => webUtils.getPathForFile(f))
contextBridge.exposeInMainWorld('onUpdateReady', cb => ipcRenderer.on('updateReady', (_, v, notes) => cb(v, notes)))
contextBridge.exposeInMainWorld('onLink', cb => ipcRenderer.on('link', (_, l) => cb(l)))
contextBridge.exposeInMainWorld('onNxm', cb => ipcRenderer.on('nxm', (_, l) => cb(l)))
contextBridge.exposeInMainWorld('onEvent', cb => ipcRenderer.on('event', (_, e, d) => cb(e, d)))
