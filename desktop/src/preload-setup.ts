import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('setupAPI', {
  detectIDEs: () => ipcRenderer.invoke('setup:detect-ides'),
  register: (ides: string[]) => ipcRenderer.invoke('setup:register', ides),
  skip: () => ipcRenderer.invoke('setup:skip'),
  discoverImport: () => ipcRenderer.invoke('setup:discover-import'),
  triggerImport: () => ipcRenderer.invoke('setup:trigger-import'),
});
