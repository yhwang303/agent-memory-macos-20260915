export type {
  Integration,
  IntegrationMechanism,
  InstallOptions,
  InstallResult,
  IntegrationStatus,
} from './types.js';
export { CursorHooksInstaller } from './CursorHooksInstaller.js';
export { WindsurfHooksInstaller } from './WindsurfHooksInstaller.js';
export { GeminiCliHooksInstaller } from './GeminiCliHooksInstaller.js';
export { OpenCodeInstaller } from './OpenCodeInstaller.js';
export { CodexCliInstaller } from './CodexCliInstaller.js';
export { OpenClawInstaller } from './OpenClawInstaller.js';
export { McpIntegrations, MCP_PLATFORMS } from './McpIntegrations.js';
export { detectInstalledIDEs, IDE_DETECTION_TABLE } from './ide-detection.js';

import type { Integration } from './types.js';
import { CursorHooksInstaller } from './CursorHooksInstaller.js';
import { WindsurfHooksInstaller } from './WindsurfHooksInstaller.js';
import { GeminiCliHooksInstaller } from './GeminiCliHooksInstaller.js';
import { OpenCodeInstaller } from './OpenCodeInstaller.js';
import { CodexCliInstaller } from './CodexCliInstaller.js';
import { OpenClawInstaller } from './OpenClawInstaller.js';

export function getAllIntegrations(): Integration[] {
  return [
    new CursorHooksInstaller(),
    new WindsurfHooksInstaller(),
    new GeminiCliHooksInstaller(),
    new OpenCodeInstaller(),
    new CodexCliInstaller(),
    new OpenClawInstaller(),
  ];
}
