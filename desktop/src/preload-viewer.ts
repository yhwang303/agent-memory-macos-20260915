import { contextBridge, ipcRenderer } from 'electron';

export interface ViewerNavigatePayload {
  tab?: 'summaries' | 'observations' | 'sessions';
  id?: string;
}

contextBridge.exposeInMainWorld('viewerAPI', {
  minimize: (): Promise<void> => ipcRenderer.invoke('viewer:minimize'),
  toggleMaximize: (): Promise<boolean> => ipcRenderer.invoke('viewer:toggle-maximize'),
  close: (): Promise<void> => ipcRenderer.invoke('viewer:close'),
  getPlatform: (): Promise<NodeJS.Platform> => ipcRenderer.invoke('viewer:get-platform'),
  getPort: (): Promise<number> => ipcRenderer.invoke('viewer:get-port'),
  isMaximized: (): Promise<boolean> => ipcRenderer.invoke('viewer:is-maximized'),
  onNavigate: (cb: (payload: ViewerNavigatePayload) => void): void => {
    ipcRenderer.on('viewer:navigate', (_e, payload: ViewerNavigatePayload) => cb(payload));
  },
  onMaximizeChange: (cb: (maximized: boolean) => void): void => {
    ipcRenderer.on('viewer:maximize-changed', (_e, maximized: boolean) => cb(maximized));
  },
});
