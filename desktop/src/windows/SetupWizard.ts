import { BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import { HooksRegistrar } from '../services/HooksRegistrar';
import type { DesktopIntegrationType } from '../services/HooksRegistrar';
import type { RegisterResult } from '../shared/hooks-config';

const VALID_INTEGRATION_TYPES: DesktopIntegrationType[] = [
  'codebuddy',
  'cursor',
  'codebuddy-ide',
  'claude-code',
  'claude-internal',
  'openclaw',
];

/** Lightweight shape exposed to the renderer for the import opt-in step. */
interface ImportDiscoverySummary {
  totalFiles: number;
  perAdapter: Array<{ id: string; files: number }>;
}

export class SetupWizard {
  private window: BrowserWindow | null = null;

  constructor(
    private readonly registrar: typeof HooksRegistrar,
    private readonly onComplete: () => void,
    /**
     * Callback wired up by main.ts to fire the same triggerImportHistory()
     * the tray menu uses (importPoller.activate() + POST /api/import/run).
     * Optional — older callers without import support pass undefined and the
     * checkbox just hides itself.
     */
    private readonly onTriggerImportHistory?: () => void,
    /**
     * Async callback that runs the cheap discover() in the worker (or in-
     * process; main.ts decides) and returns counts for the wizard's
     * "X 条历史对话可导入" section. Returning { totalFiles: 0 } hides the
     * import opt-in entirely so we don't bother users who never used the
     * supported IDEs.
     */
    private readonly onDiscoverImport?: () => Promise<ImportDiscoverySummary>,
  ) {
    this.setupIPC();
  }

  private setupIPC(): void {
    ipcMain.handle('setup:detect-ides', () => {
      return this.registrar.detectIDEs();
    });

    ipcMain.handle(
      'setup:register',
      (_event, ides: string[]): Record<string, RegisterResult> => {
        const results: Record<string, RegisterResult> = {};
        for (const raw of ides) {
          if (!VALID_INTEGRATION_TYPES.includes(raw as DesktopIntegrationType)) continue;
          const ide = raw as DesktopIntegrationType;
          results[ide] = this.registrar.register(ide);
        }
        return results;
      },
    );

    ipcMain.handle('setup:skip', () => {
      this.onComplete();
      if (this.window && !this.window.isDestroyed()) {
        this.window.close();
      }
      return { ok: true };
    });

    ipcMain.handle('setup:discover-import', async (): Promise<ImportDiscoverySummary> => {
      if (!this.onDiscoverImport) return { totalFiles: 0, perAdapter: [] };
      try {
        return await this.onDiscoverImport();
      } catch {
        return { totalFiles: 0, perAdapter: [] };
      }
    });

    ipcMain.handle('setup:trigger-import', () => {
      this.onTriggerImportHistory?.();
      return { ok: true };
    });
  }

  show(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.focus();
      return;
    }

    this.window = new BrowserWindow({
      width: 480,
      height: 480,
      resizable: false,
      minimizable: false,
      maximizable: false,
      title: 'AgentMemory — 初始化设置',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: false,
        preload: path.join(__dirname, '..', 'preload-setup.js'),
      },
    });

    const htmlPath = path.join(__dirname, 'setup-wizard.html');
    this.window.loadFile(htmlPath);

    this.window.on('closed', () => {
      this.window = null;
    });
  }

  destroy(): void {
    ipcMain.removeHandler('setup:detect-ides');
    ipcMain.removeHandler('setup:register');
    ipcMain.removeHandler('setup:skip');
    ipcMain.removeHandler('setup:discover-import');
    ipcMain.removeHandler('setup:trigger-import');
    this.window?.destroy();
    this.window = null;
  }
}
