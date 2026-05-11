const {contextBridge, ipcRenderer} = require('electron');

contextBridge.exposeInMainWorld('dogoblockLink', {
    getStatus: () => ipcRenderer.invoke('get-link-status'),
    onStatus: callback => ipcRenderer.on('link-status', (event, status) => callback(status)),
    quit: () => ipcRenderer.send('quit-app')
});
