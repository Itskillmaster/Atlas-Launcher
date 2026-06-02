const { app, BrowserWindow, ipcMain, dialog, safeStorage, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os'); 
const axios = require('axios');

const { autoUpdater } = require('electron-updater');
const log = require('electron-log');
const DiscordRPC = require('discord-rpc');

const { launchMinecraft, getAvailableVersions, loadConfig, saveConfig } = require('./launcher');
const { startServer } = require('./server');
const { VersionChecker } = require('./version-checker');

const API_BASE = 'http://localhost:3000/api';

autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info';
autoUpdater.autoDownload = false; 

let mainWindow = null;
let tray = null;
let isGameRunning = false;
let gameProcess = null;

let isAuthenticated = false;
let authToken = null;
let currentUsername = null;
let heartbeatInterval = null;

const clientId = '1362826218801725570'; 
let rpc;
const startTimestamp = new Date();

function initDiscord() {
    try {
        DiscordRPC.register(clientId);
        rpc = new DiscordRPC.Client({ transport: 'ipc' });

        rpc.on('ready', () => {
            setDiscordActivity();
            setInterval(setDiscordActivity, 15000); 
        });

        rpc.login({ clientId }).catch((err) => {
            console.log('Discord RPC: دیسکورد روی سیستم بسته است (بدون مشکل).');
        });
    } catch (err) {
        console.log('خطا در راه‌اندازی اولیه دیسکورد:', err.message);
    }
}

function setDiscordActivity() {
    if (!rpc) return;

    let detailsText = 'In Main Menu';
    let stateText = 'Install and Enjoy !';

    if (isGameRunning) {
        detailsText = 'Playing Minecraft.';
    }

    rpc.setActivity({
        details: detailsText,
        state: stateText,
        startTimestamp: startTimestamp,
        largeImageKey: 'atlas_logo', 
        largeImageText: 'Atlas Launcher v2.0.0',
        smallImageKey: isGameRunning ? 'mc_icon' : undefined,
        smallImageText: isGameRunning ? 'Minecraft' : undefined,
        instance: false,
        buttons: [
            {
                label: 'Discord',
                url: 'https://discord.gg/h8V9H2mbZw'
            }
        ]
    }).catch(console.error);
}

function getTokenPath() {
    return path.join(app.getPath('appData'), 'AtlasLauncher', 'token.enc');
}

function saveToken(token) {
    try {
        const dir = path.dirname(getTokenPath());
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        if (safeStorage.isEncryptionAvailable()) {
            fs.writeFileSync(getTokenPath(), safeStorage.encryptString(token));
        }
    } catch (err) {
        console.error('خطا در ذخیره توکن:', err);
    }
}

function loadToken() {
    try {
        if (fs.existsSync(getTokenPath()) && safeStorage.isEncryptionAvailable()) {
            return safeStorage.decryptString(fs.readFileSync(getTokenPath()));
        }
    } catch (err) {
        console.error('خطا در بارگذاری توکن:', err);
    }
    return null;
}

function deleteToken() {
    try {
        if (fs.existsSync(getTokenPath())) fs.unlinkSync(getTokenPath());
    } catch (err) {}
}

function startHeartbeat(username, token) {
    stopHeartbeat();
    heartbeatInterval = setInterval(async () => {
        try {
            await axios.post(`${API_BASE}/heartbeat`, {}, { headers: { Authorization: `Bearer ${token}` } });
        } catch (e) {
            console.error('Heartbeat error:', e.message);
        }
    }, 60 * 1000);
}

function stopHeartbeat() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
}

function createTray() {
    const iconPath = path.join(__dirname, 'icon.ico');
    let trayIcon;
    if (fs.existsSync(iconPath)) { trayIcon = nativeImage.createFromPath(iconPath); } 
    else { trayIcon = nativeImage.createEmpty(); }

    tray = new Tray(trayIcon);
    const contextMenu = Menu.buildFromTemplate([
        { label: 'Open', click: () => { if (mainWindow) mainWindow.show(); } },
        { label: 'Exit', click: () => { app.exit(0); } }
    ]);

    tray.setToolTip('Atlas Launcher');
    tray.setContextMenu(contextMenu);
    tray.on('double-click', () => { if (mainWindow) mainWindow.show(); });
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1000,
        height: 700,
        frame: false,                
        transparent: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false,
            webSecurity: false,
            allowRunningInsecureContent: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    mainWindow.webContents.on('devtools-opened', () => { mainWindow.webContents.closeDevTools(); });
    mainWindow.webContents.on('before-input-event', (event, input) => {
        if ((input.control && input.shift && input.key === 'I') || input.key === 'F12') { event.preventDefault(); }
    });
    mainWindow.webContents.on('context-menu', (e) => { e.preventDefault(); });
    
    mainWindow.webContents.on('did-finish-load', () => {
        mainWindow.webContents.insertCSS('* { user-select: none !important; -webkit-user-select: none !important; }');
        if (!isGameRunning) {
            autoUpdater.checkForUpdates().catch(err => log.error('Update Check Error:', err));
        }
    });
    
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
        const parsedUrl = new URL(navigationUrl);
        if (parsedUrl.protocol !== 'file:') { event.preventDefault(); }
    });

    mainWindow.on('close', (event) => {
        if (isGameRunning) {
            event.preventDefault();
            mainWindow.hide();
            if (!tray) createTray();
            if (tray && process.platform === 'win32') {
                tray.displayBalloon({ title: 'Atlas Launcher', content: 'بازی در حال اجراست. لانچر در پس‌زمینه باقی می‌ماند.' });
            }
        } else {
            if (tray) { tray.destroy(); tray = null; }
        }
    });

    mainWindow.loadFile('index.html');
}

autoUpdater.on('update-available', (info) => {
    log.info('آپدیت جدید پیدا شد:', info.version);
    if (mainWindow) { mainWindow.webContents.send('show_update_dialog', info.version); }
});

ipcMain.on('start_download', () => {
    log.info('درخواست دانلود تایید شد. شروع دانلود...');
    autoUpdater.downloadUpdate();
});

autoUpdater.on('download-progress', (progressObj) => {
    const speedMBps = (progressObj.bytesPerSecond / (1024 * 1024)).toFixed(2);
    const percent = Math.round(progressObj.percent);
    if (mainWindow) { mainWindow.webContents.send('download_progress', { percent: percent, speed: speedMBps }); }
});

autoUpdater.on('update-downloaded', () => {
    log.info('دانلود اتمام یافت. در حال نصب...');
    autoUpdater.quitAndInstall();
});

autoUpdater.on('error', (err) => {
    log.error('خطا در بروزرسانی:', err);
});

app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);

    ipcMain.on('window-minimize', () => { if (mainWindow) mainWindow.minimize(); });
    ipcMain.on('window-maximize', () => {
        if (mainWindow) {
            if (mainWindow.isMaximized()) mainWindow.unmaximize();
            else mainWindow.maximize();
        }
    });
    ipcMain.on('window-close', () => { if (mainWindow) mainWindow.close(); });
    
    ipcMain.handle('get-system-ram', () => { return Math.round(os.totalmem() / (1024 * 1024 * 1024)); });

    ipcMain.handle('auth-login', async (event, data) => {
        try {
            const response = await axios.post(`${API_BASE}/login`, { username: data.username, password: data.password });
            const { token, username } = response.data;
            saveToken(token);
            isAuthenticated = true;
            currentUsername = username;
            authToken = token;
            startHeartbeat(username, token);
            setDiscordActivity(); 
            return { success: true, token, username };
        } catch (error) {
            if (error.response && error.response.data) return { success: false, error: error.response.data.error };
            return { success: false, error: 'خطا در اتصال به سرور' };
        }
    });

    ipcMain.handle('auth-check', async () => {
        const token = loadToken();
        if (!token) return { isAuthenticated: false };
        try {
            const response = await axios.get(`${API_BASE}/auth-check`, { headers: { Authorization: `Bearer ${token}` } });
            if (response.data.isAuthenticated) {
                isAuthenticated = true;
                currentUsername = response.data.username;
                authToken = token;
                startHeartbeat(currentUsername, token);
                setDiscordActivity();
                return { isAuthenticated: true, username: currentUsername, autoLogin: true };
            }
        } catch (err) {
            deleteToken();
        }
        return { isAuthenticated: false };
    });

    ipcMain.handle('auth-logout', async () => {
        if (authToken) {
            try { await axios.post(`${API_BASE}/logout`, {}, { headers: { Authorization: `Bearer ${authToken}` } }); } catch (e) {}
        }
        stopHeartbeat();
        isAuthenticated = false;
        authToken = null;
        currentUsername = null;
        deleteToken();
        setDiscordActivity(); 
        return { success: true };
    });

    ipcMain.handle('get-game-status', async () => ({ isRunning: isGameRunning }));

    ipcMain.handle('select-folder', async () => {
        const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
        return result.canceled ? null : result.filePaths[0];
    });

    ipcMain.handle('select-java', async () => {
        const result = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Java Executable', extensions: ['exe'] }] });
        return result.canceled ? null : result.filePaths[0];
    });

    ipcMain.handle('get-versions', async (event, gameDir) => {
        if (!gameDir) return [];
        return await getAvailableVersions(gameDir);
    });

    ipcMain.handle('get-config', () => loadConfig());
    ipcMain.handle('save-config', (event, data) => saveConfig(data));

    ipcMain.handle('get-online-users', async () => {
        try {
            const response = await axios.get(`${API_BASE}/online-count`);
            return response.data;
        } catch (err) {
            return { online: 0 };
        }
    });

    ipcMain.handle('launch-game', async (event, data) => {
        if (!isAuthenticated) return { success: false, error: 'لطفاً ابتدا وارد حساب کاربری خود شوید' };
        if (isGameRunning) return { success: false, error: 'بازی در حال اجراست!' };
        if (!data.gameDir || !path.isAbsolute(data.gameDir)) return { success: false, error: 'مسیر نصب بازی نامعتبر است.' };

        data.lastPlayedVersion = data.versionNumber;
        saveConfig(data);

        function getRequiredJavaVersion(version) {
            const major = parseFloat(version);
            if (major >= 1.21) return 21;
            if (major >= 1.18) return 17;
            return 8;
        }

        const requiredJava = getRequiredJavaVersion(data.versionNumber);
        let javaPath = '';
        if (requiredJava === 8) javaPath = data.java8Path;
        else if (requiredJava === 17) javaPath = data.java17Path;
        else if (requiredJava === 21) javaPath = data.java21Path;

        if (!javaPath || !fs.existsSync(javaPath) || !path.isAbsolute(javaPath)) return { success: false, error: `جاوا ${requiredJava} یافت نشد یا مسیر نامعتبر است.` };
        if (!fs.existsSync(data.gameDir)) return { success: false, error: 'پوشه بازی پیدا نشد.' };

        let checker;
        try {
            checker = new VersionChecker(data.gameDir, data.versionNumber, (progress) => { event.sender.send('prepare-progress', progress); });
            const cancelHandler = () => { if (checker) checker.cancel(); };
            ipcMain.once('cancel-preparation', cancelHandler);
            event.sender.once('destroyed', () => { if (checker) checker.cancel(); });
            await checker.run();
            ipcMain.removeListener('cancel-preparation', cancelHandler);
        } catch (err) {
            return { success: false, error: err.message || 'خطا در آماده‌سازی نسخه' };
        }

        try {
            const optionsDir = path.join(data.gameDir, 'atlas_options');
            const versionOptionsPath = path.join(optionsDir, `options_${data.versionNumber}.txt`);
            const mainOptionsPath = path.join(data.gameDir, 'options.txt');

            if (!fs.existsSync(optionsDir)) fs.mkdirSync(optionsDir, { recursive: true });

            if (fs.existsSync(versionOptionsPath)) {
                try { fs.copyFileSync(versionOptionsPath, mainOptionsPath); } catch (e) { console.error(e); }
            } else {
                if (fs.existsSync(mainOptionsPath)) {
                    try { fs.unlinkSync(mainOptionsPath); } catch (e) { console.error(e); }
                }
            }

            const result = await launchMinecraft({
                username: currentUsername || data.username || 'Player',
                ram: parseInt(data.ram) || 4,
                javaPath: javaPath,
                gameDir: data.gameDir,
                versionNumber: data.versionNumber,
                mode: 'offline'
            });

            if (result.success && result.process) {
                gameProcess = result.process;
                isGameRunning = true;
                setDiscordActivity(); 

                if (mainWindow) mainWindow.hide();
                if (!tray) createTray();

                if (result.process.stdout) {
                    result.process.stdout.on('data', (dataBuffer) => {
                        const msg = dataBuffer.toString().trim();
                        if (msg) event.sender.send('game-log', { type: 'info', msg });
                    });
                }
                if (result.process.stderr) {
                    result.process.stderr.on('data', (dataBuffer) => {
                        const msg = dataBuffer.toString().trim();
                        if (msg) {
                            const type = msg.toLowerCase().includes('error') || msg.toLowerCase().includes('exception') ? 'error' : 'warn';
                            event.sender.send('game-log', { type, msg });
                        }
                    });
                }
                result.process.on('close', (code) => {
                    if (fs.existsSync(mainOptionsPath)) {
                        try { fs.copyFileSync(mainOptionsPath, versionOptionsPath); } catch (e) { console.error(e); }
                    }
                    event.sender.send('game-log', { type: 'info', msg: `[Process] بازی با کد ${code} بسته شد.` });
                    isGameRunning = false;
                    gameProcess = null;
                    setDiscordActivity();
                    if (mainWindow) mainWindow.show();
                });

                setTimeout(() => {
                    if (isGameRunning && (!result.process || result.process.killed)) {
                        isGameRunning = false;
                        setDiscordActivity();
                        if (mainWindow) mainWindow.show();
                    }
                }, 5000);
            }

            return { success: result.success, error: result.error || null };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('check-and-prepare-game', async (event, data) => {
        const { gameDir, versionNumber } = data;
        if (!gameDir || !versionNumber) return { success: false, error: 'پارامتر ناقص' };
        const checker = new VersionChecker(gameDir, versionNumber, (progress) => {
            event.sender.send('prepare-progress', progress);
        });
        try {
            await checker.run();
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('fetch-announcement', async (event, customUrl) => {
        const url = customUrl || 'https://ph0enix.ir/api/3/api2.php';
        return new Promise((resolve) => {
            const parsedUrl = new URL(url);
            const options = {
                hostname: parsedUrl.hostname,
                port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
                path: parsedUrl.pathname + parsedUrl.search,
                method: 'GET',
                headers: { 'User-Agent': 'AtlasLauncher/2.0', 'Accept': 'application/json' },
                timeout: 8000
            };
            const protocol = parsedUrl.protocol === 'https:' ? require('https') : require('http');
            const req = protocol.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { resolve({ enabled: false }); } });
            });
            req.on('error', () => resolve({ enabled: false }));
            req.on('timeout', () => { req.destroy(); resolve({ enabled: false }); });
            req.end();
        });
    });

    try {
        await startServer();
        console.log('✅ Server started inside Electron');
    } catch (err) {
        console.error('❌ Server failed:', err);
        app.quit();
        return;
    }

    createWindow();

    initDiscord();
});

app.on('window-all-closed', () => {
    if (!isGameRunning) app.quit();
});

app.on('activate', () => {
    if (mainWindow === null) createWindow();
    else mainWindow.show();
});
