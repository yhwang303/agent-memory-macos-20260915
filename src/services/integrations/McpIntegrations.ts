import path from 'path';
import os from 'os';

export interface McpPlatform {
  id: string;
  displayName: string;
  configRelPath: string;
  configFormat: 'json' | 'yaml';
  detectPaths: string[];
  detectBinaries: string[];
}

export const MCP_PLATFORMS: McpPlatform[] = [
  {
    id: 'copilot-cli',
    displayName: 'Copilot CLI',
    configRelPath: '.github-copilot/mcp.json',
    configFormat: 'json',
    detectPaths: ['.github-copilot'],
    detectBinaries: ['github-copilot-cli', 'copilot'],
  },
  {
    id: 'antigravity',
    displayName: 'Antigravity',
    configRelPath: '.antigravity/mcp.json',
    configFormat: 'json',
    detectPaths: ['.antigravity'],
    detectBinaries: ['antigravity'],
  },
  {
    id: 'goose',
    displayName: 'Goose',
    configRelPath: '.config/goose/mcp.json',
    configFormat: 'json',
    detectPaths: ['.config/goose'],
    detectBinaries: ['goose'],
  },
  {
    id: 'crush',
    displayName: 'Crush',
    configRelPath: '.crush/mcp.json',
    configFormat: 'json',
    detectPaths: ['.crush'],
    detectBinaries: ['crush'],
  },
  {
    id: 'roo-code',
    displayName: 'Roo Code',
    configRelPath: '.roo-code/mcp.json',
    configFormat: 'json',
    detectPaths: ['.roo-code'],
    detectBinaries: ['roo-code'],
  },
  {
    id: 'warp',
    displayName: 'Warp',
    configRelPath: '.warp/mcp.json',
    configFormat: 'json',
    detectPaths: ['.warp'],
    detectBinaries: ['warp'],
  },
];

export class McpIntegrations {
  static buildMcpEntry(mcpServerPath: string): Record<string, any> {
    return {
      'agent-memory': {
        command: 'node',
        args: [mcpServerPath],
        env: {},
      },
    };
  }

  static buildConfigPatch(mcpServerPath: string, format: 'json' | 'yaml'): any {
    const entry = McpIntegrations.buildMcpEntry(mcpServerPath);
    if (format === 'json') {
      return { mcpServers: entry };
    }
    return { mcp_servers: entry };
  }

  static getConfigAbsPath(platform: McpPlatform): string {
    return path.join(os.homedir(), platform.configRelPath);
  }
}
