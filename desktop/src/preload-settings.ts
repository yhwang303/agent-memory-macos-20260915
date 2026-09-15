import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('settingsAPI', {
  getConfig: () => ipcRenderer.invoke('settings:get'),
  saveConfig: (data: Record<string, unknown>) => ipcRenderer.invoke('settings:save', data),
  getShadowfolkConfig: () => ipcRenderer.invoke('shadowfolk:get-config'),
  saveShadowfolkConfig: (data: Record<string, unknown>) => ipcRenderer.invoke('shadowfolk:save-config', data),
  revealShadowfolkToken: () => ipcRenderer.invoke('shadowfolk:reveal-token'),
  validateShadowfolkWorkspace: (workspace: string) => ipcRenderer.invoke('shadowfolk:validate-workspace', workspace),
  suggestShadowfolkWorkspaceAliases: (workspace: string) => ipcRenderer.invoke('shadowfolk:suggest-aliases', workspace),
  listShadowfolkMemoryProjects: () => ipcRenderer.invoke('shadowfolk:list-memory-projects'),
  shadowfolkStatus: () => ipcRenderer.invoke('shadowfolk:status'),
  shadowfolkPushNow: () => ipcRenderer.invoke('shadowfolk:push-now'),
  shadowfolkHistory: (workspace: string) => ipcRenderer.invoke('shadowfolk:history', workspace),
  shadowfolkReplay: (data: Record<string, unknown>) => ipcRenderer.invoke('shadowfolk:replay', data),

  parseInvite: (raw: string) => ipcRenderer.invoke('server:parse-invite', raw),
  applyInvite: (raw: string) => ipcRenderer.invoke('server:apply-invite', raw),
  testServer: () => ipcRenderer.invoke('server:test'),
  syncStatus: () => ipcRenderer.invoke('server:status'),
  syncRescan: () => ipcRenderer.invoke('server:rescan'),
  consumePendingInvite: () => ipcRenderer.invoke('server:consume-pending-invite'),
  onInviteArrived: (cb: (parsed: any) => void) => {
    ipcRenderer.on('server:invite-arrived', (_e, parsed) => cb(parsed));
  },

  detectIDEs: () => ipcRenderer.invoke('hooks:detect-ides'),
  registerIDE: (ide: string) => ipcRenderer.invoke('hooks:register', ide),
  unregisterIDE: (ide: string) => ipcRenderer.invoke('hooks:unregister', ide),

  // ── Self-Evolve Plugin ──
  selfEvolveGetConfig: () => ipcRenderer.invoke('selfevolve:get-config'),
  selfEvolveSaveConfig: (data: Record<string, unknown>) => ipcRenderer.invoke('selfevolve:save-config', data),

  // ── Injector Plugin ──
  injectorGetConfig: () => ipcRenderer.invoke('injector:get-config'),
  injectorSaveConfig: (data: Record<string, unknown>) => ipcRenderer.invoke('injector:save-config', data),

  // ── ShadwMonitor Bridge ──
  shadwGetConfig: () => ipcRenderer.invoke('shadwmonitor:get-config'),
  shadwSaveConfig: (data: Record<string, unknown>) => ipcRenderer.invoke('shadwmonitor:save-config', data),
  shadwRevealApiKey: () => ipcRenderer.invoke('shadwmonitor:reveal-api-key'),
  shadwDetectPython: () => ipcRenderer.invoke('shadwmonitor:detect-python'),
  shadwInstallDeps: () => ipcRenderer.invoke('shadwmonitor:install-deps'),
  shadwStart: () => ipcRenderer.invoke('shadwmonitor:start'),
  shadwStop: () => ipcRenderer.invoke('shadwmonitor:stop'),
  shadwStatus: () => ipcRenderer.invoke('shadwmonitor:status'),
});
