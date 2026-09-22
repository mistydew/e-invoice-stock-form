// Electron 主进程：加载本地网页应用 + “另存为”文件对话框
const { app, BrowserWindow, ipcMain, dialog, protocol, net, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');

// 使用自定义 app:// 协议加载页面，保证 ES Module 正常工作
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 880,
    minWidth: 900,
    minHeight: 640,
    title: '电子发票 → 元器件入库单',
    icon: path.join(__dirname, 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  win.loadURL('app://bundle/index.html');

  // 外部链接用系统浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  protocol.handle('app', (req) => {
    let p = new URL(req.url).pathname;
    if (p === '/') p = '/index.html';
    const file = path.normalize(path.join(ROOT, decodeURIComponent(p)));
    if (!file.startsWith(ROOT)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// 生成结果“另存为”对话框
ipcMain.handle('save-file', async (_e, { defaultName, data }) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: '保存生成结果',
    defaultPath: path.join(app.getPath('documents'), defaultName || '入库单.xlsx'),
  });
  if (canceled || !filePath) return false;
  try {
    await fs.promises.writeFile(filePath, Buffer.from(data));
    return filePath;
  } catch (err) {
    dialog.showErrorBox('保存失败', String(err.message || err));
    return false;
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
