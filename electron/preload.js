// 预加载：向页面暴露桌面能力（另存为）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  saveFile: (defaultName, data) => ipcRenderer.invoke('save-file', { defaultName, data }),
});
