const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sened', {
  loadData: () => ipcRenderer.invoke('data:load'),
  saveData: (data) => ipcRenderer.invoke('data:save', data),
  askAI: (text, history) => ipcRenderer.invoke('ai:ask', { text, history }),
  checkAI: () => ipcRenderer.invoke('ai:check'),
  tgStart: (token) => ipcRenderer.invoke('tg:start', token),
  tgStop: () => ipcRenderer.invoke('tg:stop'),
  print: () => ipcRenderer.invoke('app:print'),
  exportPdf: (suggestedName) => ipcRenderer.invoke('app:exportPdf', suggestedName),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  onTgStatus: (cb) => ipcRenderer.on('tg-status', (e, s) => cb(s)),
  onAiChunk: (cb) => ipcRenderer.on('ai:chunk', (e, delta) => cb(delta)),
  onAiReset: (cb) => ipcRenderer.on('ai:reset', () => cb()),
  authVerify: (username, password) => ipcRenderer.invoke('auth:verify', { username, password }),
  authSetCredentials: (username, password) => ipcRenderer.invoke('auth:setCredentials', { username, password }),
  authHashPassword: (password) => ipcRenderer.invoke('auth:hashPassword', password)
});
