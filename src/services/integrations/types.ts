export type IntegrationMechanism = 'hooks' | 'transcript' | 'mcp' | 'plugin';

export interface InstallResult {
  success: boolean;
  filesWritten: string[];
  filesBackedUp: string[];
  warnings: string[];
}

export interface IntegrationStatus {
  installed: boolean;
  detected: boolean;
  configPath: string | null;
  version?: string;
  details?: Record<string, unknown>;
}

export interface Integration {
  id: string;
  displayName: string;
  mechanism: IntegrationMechanism;

  detect(): Promise<boolean>;
  install(opts: InstallOptions): Promise<InstallResult>;
  uninstall(): Promise<InstallResult>;
  status(): Promise<IntegrationStatus>;
}

export interface InstallOptions {
  hooksCliPath: string;
  mcpServerPath: string;
  force?: boolean;
}
