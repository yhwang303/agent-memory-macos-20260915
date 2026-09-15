import { contextBridge, ipcRenderer } from 'electron';

export interface QuickOpenViewerOptions {
  tab?: 'summaries' | 'observations' | 'sessions';
  id?: string;
}

contextBridge.exposeInMainWorld('quickAPI', {
  openViewer: (opts?: QuickOpenViewerOptions): Promise<void> =>
    ipcRenderer.invoke('viewer:open', opts ?? {}),
});
