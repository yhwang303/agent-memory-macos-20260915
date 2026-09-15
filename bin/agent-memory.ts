#!/usr/bin/env node
/**
 * AgentMemory CLI Entry Point
 * Starts the memory worker service and MCP server
 */

import { Command } from 'commander';
import { WorkerService } from '../src/services/worker/worker-service.js';
import { MCPServer } from '../src/servers/mcp-server.js';
import { getDataDir, ensureDataDir } from '../src/shared/paths.js';

const program = new Command();

program
  .name('agent-memory')
  .description('AgentMemory System - Cross-session persistent memory for CodeBuddy Agent')
  .version('1.0.0');

program
  .command('worker')
  .description('Start the memory worker service')
  .option('-p, --port <port>', 'Worker service port', '3456')
  .option('-d, --data-dir <dir>', 'Data directory path')
  .action(async (options) => {
    const dataDir = options.dataDir || getDataDir();
    ensureDataDir(dataDir);
    
    console.log(Starting AgentMemory Worker Service...);
    console.log(Data directory: \);
    console.log(Port: \);
    
    const worker = new WorkerService({
      port: parseInt(options.port, 10),
      dataDir
    });
    
    await worker.start();
    
    console.log(Worker service running on http://localhost:\);
    
    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      console.log('\\nShutting down worker service...');
      await worker.stop();
      process.exit(0);
    });
    
    process.on('SIGTERM', async () => {
      await worker.stop();
      process.exit(0);
    });
  });

program
  .command('mcp')
  .description('Start the MCP search server')
  .option('-d, --data-dir <dir>', 'Data directory path')
  .action(async (options) => {
    const dataDir = options.dataDir || getDataDir();
    ensureDataDir(dataDir);
    
    console.log(Starting AgentMemory MCP Server...);
    console.log(Data directory: \);
    
    const server = new MCPServer({ dataDir });
    await server.start();
  });

program
  .command('info')
  .description('Show memory system information')
  .option('-d, --data-dir <dir>', 'Data directory path')
  .action(async (options) => {
    const dataDir = options.dataDir || getDataDir();
    
    console.log('AgentMemory System Information');
    console.log('===================================');
    console.log(Data directory: \);
    console.log(Version: 1.0.0);
    
    // TODO: Add database statistics
  });

program.parse();
