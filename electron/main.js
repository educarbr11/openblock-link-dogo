const path = require('path');
const {app, BrowserWindow, ipcMain} = require('electron');

const OpenBlockLink = require('../src/index');

let mainWindow = null;
let link = null;
let status = {
    state: 'starting',
    message: 'Starting DoGoBlock Link...'
};

const getToolsPath = () => {
    if (app.isPackaged) {
        return path.join(process.resourcesPath, 'tools');
    }
    return path.join(__dirname, '../tools');
};

const setStatus = nextStatus => {
    status = Object.assign({}, status, nextStatus);
    if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('link-status', status);
    }
};

const createWindow = () => {
    mainWindow = new BrowserWindow({
        width: 420,
        height: 320,
        resizable: false,
        title: 'DoGoBlock Link',
        webPreferences: {
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    mainWindow.setMenu(null);
    mainWindow.loadFile(path.join(__dirname, 'renderer.html'));
    mainWindow.on('closed', () => {
        mainWindow = null;
    });
};

const startLink = () => {
    const userDataPath = app.getPath('userData');
    link = new OpenBlockLink(userDataPath, getToolsPath());
    link.on('ready', () => {
        setStatus({
            state: 'running',
            message: 'DoGoBlock Link is running on 127.0.0.1:20111.'
        });
    });
    link.on('port-in-use', () => {
        setStatus({
            state: 'warning',
            message: 'Port 20111 is already in use by another DoGoBlock Link instance.'
        });
    });
    link.on('error', message => {
        setStatus({
            state: 'error',
            message: message
        });
    });
    link.listen(20111, '127.0.0.1');
};

ipcMain.handle('get-link-status', () => status);
ipcMain.on('quit-app', () => app.quit());

app.whenReady().then(() => {
    createWindow();
    startLink();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});
