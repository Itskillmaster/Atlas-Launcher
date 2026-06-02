const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    getConfig: () => ipcRenderer.invoke('get-config'),
    saveConfig: (config) => ipcRenderer.invoke('save-config', config),
    selectFolder: () => ipcRenderer.invoke('select-folder'),
    selectJava: () => ipcRenderer.invoke('select-java'),
    getVersions: (gameDir) => ipcRenderer.invoke('get-versions', gameDir),
    launchGame: (data) => ipcRenderer.invoke('launch-game', data),
    getGameStatus: () => ipcRenderer.invoke('get-game-status'),
    authLogin: (username, password) => ipcRenderer.invoke('auth-login', { username, password }),
    authLogout: () => ipcRenderer.invoke('auth-logout'),
    authCheck: () => ipcRenderer.invoke('auth-check'),
    onGameLog: (callback) => ipcRenderer.on('game-log', (event, data) => callback(event, data)),
    fetchAnnouncement: (url) => ipcRenderer.invoke('fetch-announcement', url),
    onShowUpdateDialog: (callback) => ipcRenderer.on('show_update_dialog', (event, version) => callback(version)),
    onDownloadProgress: (callback) => ipcRenderer.on('download_progress', (event, data) => callback(data)),
    startDownload: () => ipcRenderer.send('start_download'),
    getOnlineUsers: () => ipcRenderer.invoke('get-online-users'),
    minimizeWindow: () => ipcRenderer.send('window-minimize'),
    maximizeWindow: () => ipcRenderer.send('window-maximize'),
    closeWindow: () => ipcRenderer.send('window-close'),
    checkAndPrepareGame: (data) => ipcRenderer.invoke('check-and-prepare-game', data),
    cancelPreparation: () => ipcRenderer.send('cancel-preparation'),
    onPrepareProgress: (callback) => ipcRenderer.on('prepare-progress', (event, data) => callback(data)),
    getSystemRam: () => ipcRenderer.invoke('get-system-ram')
});
