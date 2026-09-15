export interface IDEAdapter {
  id: string;
  displayName: string;
  configDir: string;
  hooksConfigFile: string;
  mcpConfigFile?: string;
  projectDirEnvVar?: string;

  mapEventName(ideEventName: string): string | null;
  normalizeInput(internalEventName: string, rawInput: any): any;
  generateHooksConfig(hooksCliPath: string, platform: NodeJS.Platform): object;
  generateMcpConfig(mcpServerPath: string): object;
}
