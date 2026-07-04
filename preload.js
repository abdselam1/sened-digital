const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sened', {
  loadData: () => ipcRenderer.invoke('data:load'),
  saveData: (data) => ipcRenderer.invoke('data:save', data),
  askAI: (text, history) => ipcRenderer.invoke('ai:ask', { text, history }),
  checkAI: () => ipcRenderer.invoke('ai:check'),
  tgStart: (id, token) => ipcRenderer.invoke('tg:start', { id, token }),
  tgStop: (id) => ipcRenderer.invoke('tg:stop', { id }),
  print: () => ipcRenderer.invoke('app:print'),
  exportPdf: (suggestedName) => ipcRenderer.invoke('app:exportPdf', suggestedName),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  openBackupsFolder: () => ipcRenderer.invoke('app:openBackupsFolder'),
  onTgStatus: (cb) => ipcRenderer.on('tg-status', (e, s) => cb(s)),
  onAiChunk: (cb) => ipcRenderer.on('ai:chunk', (e, delta) => cb(delta)),
  onAiReset: (cb) => ipcRenderer.on('ai:reset', () => cb()),
  authVerify: (username, password) => ipcRenderer.invoke('auth:verify', { username, password }),
  authSetCredentials: (username, password) => ipcRenderer.invoke('auth:setCredentials', { username, password }),
  authHashPassword: (password) => ipcRenderer.invoke('auth:hashPassword', password),
  licenseCheckNow: () => ipcRenderer.invoke('license:checkNow'),
  licenseRegenClaimCode: () => ipcRenderer.invoke('license:regenClaimCode'),
  licenseCreateGist: (token) => ipcRenderer.invoke('license:createGist', token),
  onLicenseStatus: (cb) => ipcRenderer.on('license:status', (e, s) => cb(s))
});
