import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const askQuestion = (query) => new Promise(resolve => rl.question(query, resolve));

async function main() {
  console.log('🚀 欢迎使用 AgentMemory 一键配置向导！\n');

  // 1. 设置环境变量文件
  const envExample = path.join(projectRoot, '.env.local.example');
  const envLocal = path.join(projectRoot, '.env.local');
  if (fs.existsSync(envExample) && !fs.existsSync(envLocal)) {
    fs.copyFileSync(envExample, envLocal);
    console.log('✅ 已为您生成 .env.local 配置文件。');
    console.log('⚠️ 请记得稍后在 .env.local 中填入您的 TIMIAI_API_KEY 或其他模型 API Key。\n');
  }

  // 2. 获取绝对路径
  // Windows 下路径需要使用正斜杠或双反斜杠，这里统一用正斜杠
  const hooksCliPath = path.join(projectRoot, 'dist', 'hooks-cli.js').replace(/\\/g, '/');
  const mcpServerPath = path.join(projectRoot, 'dist', 'servers', 'mcp-server.js').replace(/\\/g, '/');

  console.log('📌 已识别项目绝对路径：');
  console.log(`- Hooks 脚本: ${hooksCliPath}`);
  console.log(`- MCP 服务: ${mcpServerPath}\n`);

  // 3. 询问 IDE 类型
  console.log('您想配置哪款编辑器的 Hooks 和 MCP？');
  console.log('1) Cursor (推荐)');
  console.log('2) CodeBuddy');
  console.log('3) CodeBuddy IDE');
  console.log('4) 全部');
  const ideChoice = await askQuestion('请输入选项数字 (默认 1): ');
  const choice = ideChoice.trim() || '1';

  const configureCursor = choice === '1' || choice === '4';
  const configureCodebuddy = choice === '2' || choice === '4';
  const configureCodebuddyIDE = choice === '3' || choice === '4';

  if (configureCursor) {
    await setupCursor(hooksCliPath, mcpServerPath);
  }

  if (configureCodebuddy) {
    await setupCodebuddy(hooksCliPath, mcpServerPath);
  }

  if (configureCodebuddyIDE) {
    await setupCodebuddyIDE(hooksCliPath, mcpServerPath);
  }

  console.log('\n🎉 配置完成！');
  console.log('接下来您需要：');
  console.log('1. 确保已执行 `npm run build` 编译项目');
  console.log('2. 修改 .env.local 填入您的 API Key');
  console.log('3. 运行 `npm run worker:start` 启动 Worker 服务');
  console.log('4. 重启您的编辑器 (Cursor 或 CodeBuddy)');

  rl.close();
}

async function setupCursor(hooksCliPath, mcpServerPath) {
  console.log('\n--- 正在配置 Cursor ---');
  const cursorDir = path.join(os.homedir(), '.cursor');
  if (!fs.existsSync(cursorDir)) {
    fs.mkdirSync(cursorDir, { recursive: true });
  }

  // 配置 Hooks
  const hooksJsonPath = path.join(cursorDir, 'hooks.json');
  let hooksConfig = { version: 1, hooks: {} };
  
  if (fs.existsSync(hooksJsonPath)) {
    try {
      hooksConfig = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
      console.log('ℹ️ 发现现有的 Cursor hooks.json，将进行合并。');
    } catch (e) {
      console.log('⚠️ 读取现有的 hooks.json 失败，将覆盖创建。');
    }
  }

  const hooksToAdd = [
    { event: 'beforeSubmitPrompt', timeout: 10 },
    { event: 'afterShellExecution', timeout: 10 },
    { event: 'afterMCPExecution', timeout: 10 },
    { event: 'afterFileEdit', timeout: 10 },
    { event: 'afterAgentResponse', timeout: 10 },
    { event: 'afterAgentThought', timeout: 10 },
    { event: 'stop', timeout: 30 }
  ];

  if (!hooksConfig.hooks) hooksConfig.hooks = {};

  hooksToAdd.forEach(({ event, timeout }) => {
    // Windows 下使用 cmd.exe /c chcp 65001 >nul & node ... 强制 utf-8
    const cmd = os.platform() === 'win32'
      ? `cmd.exe /c chcp 65001 >nul & node "${hooksCliPath}" ${event}`
      : `node "${hooksCliPath}" ${event}`;
      
    if (!hooksConfig.hooks[event]) {
      hooksConfig.hooks[event] = [];
    }
    
    // 移除旧的 agent-memory hook (如果存在)
    hooksConfig.hooks[event] = hooksConfig.hooks[event].filter(h => 
      !h.command.includes('agent-memory') && !h.command.includes(hooksCliPath)
    );
    
    hooksConfig.hooks[event].push({
      command: cmd,
      timeout: timeout
    });
  });

  fs.writeFileSync(hooksJsonPath, JSON.stringify(hooksConfig, null, 2), 'utf8');
  console.log(`✅ 已更新 Cursor Hooks: ${hooksJsonPath}`);

  // 配置 MCP
  const mcpJsonPath = path.join(cursorDir, 'mcp.json');
  let mcpConfig = { mcpServers: {} };
  
  if (fs.existsSync(mcpJsonPath)) {
    try {
      mcpConfig = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));
      console.log('ℹ️ 发现现有的 Cursor mcp.json，将进行合并。');
    } catch (e) {
      console.log('⚠️ 读取现有的 mcp.json 失败，将覆盖创建。');
    }
  }

  if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
  
  mcpConfig.mcpServers['agent-memory'] = {
    command: "node",
    args: [mcpServerPath],
    env: {}
  };

  fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2), 'utf8');
  console.log(`✅ 已更新 Cursor MCP: ${mcpJsonPath}`);
}

async function setupCodebuddy(hooksCliPath, mcpServerPath) {
  console.log('\n--- 正在配置 CodeBuddy 插件版 ---');
  const cbDir = path.join(os.homedir(), '.gongfeng-copilot');
  const hooksDir = path.join(cbDir, 'hooks');
  if (!fs.existsSync(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true });
  }

  const hooksJsonPath = path.join(hooksDir, 'hooks.json');
  let configData = { enabled: true, hooks: {} };
  
  if (fs.existsSync(hooksJsonPath)) {
    try {
      configData = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
      console.log('ℹ️ 发现现有的 CodeBuddy hooks.json，将进行合并。');
    } catch (e) {
      console.log('⚠️ 读取现有的 hooks.json 失败，将覆盖创建。');
    }
  }

  if (!configData.hooks) configData.hooks = {};

  const events = [
    'beforeSubmitPrompt',
    'afterShellExecution',
    'afterMCPExecution',
    'afterFileEdit',
    'stop'
  ];

  events.forEach(event => {
    const cmd = os.platform() === 'win32' 
      ? `cmd.exe /c chcp 65001 >nul & node "${hooksCliPath}" ${event}`
      : `node "${hooksCliPath}" ${event}`;
    if (!configData.hooks[event]) {
      configData.hooks[event] = [];
    }
    configData.hooks[event] = configData.hooks[event].filter(h =>
      typeof h === 'object' && h.command && !h.command.includes('hooks-cli') && !h.command.includes('agent-memory')
    );
    configData.hooks[event].push({
      command: cmd,
      display_name: `[AgentMemory] ${event}`,
      hook_id: `agent-memory:${event}`,
      trigger_event: event,
      trigger_event_display: event,
    });
  });

  fs.writeFileSync(hooksJsonPath, JSON.stringify(configData, null, 2), 'utf8');
  console.log(`✅ 已更新 CodeBuddy Hooks: ${hooksJsonPath}`);

  // 配置 MCP
  const mcpJsonPath = path.join(cbDir, 'mcp.json');
  let mcpConfig = { mcpServers: {} };
  
  if (fs.existsSync(mcpJsonPath)) {
    try {
      mcpConfig = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));
      console.log('ℹ️ 发现现有的 CodeBuddy mcp.json，将进行合并。');
    } catch (e) {
      console.log('⚠️ 读取现有的 mcp.json 失败，将覆盖创建。');
    }
  }

  if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
  
  mcpConfig.mcpServers['agent-memory'] = {
    command: "node",
    args: [mcpServerPath],
    env: {}
  };

  fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2), 'utf8');
  console.log(`✅ 已更新 CodeBuddy MCP: ${mcpJsonPath}`);
}

async function setupCodebuddyIDE(hooksCliPath, mcpServerPath) {
  console.log('\n--- 正在配置 CodeBuddy IDE ---');
  const ideDir = path.join(os.homedir(), '.codebuddy');
  if (!fs.existsSync(ideDir)) {
    fs.mkdirSync(ideDir, { recursive: true });
  }

  // 配置 Hooks
  const settingsJsonPath = path.join(ideDir, 'settings.json');
  let settingsData = { hooks: {} };

  if (fs.existsSync(settingsJsonPath)) {
    try {
      settingsData = JSON.parse(fs.readFileSync(settingsJsonPath, 'utf8'));
      console.log('ℹ️ 发现现有的 CodeBuddy IDE settings.json，将进行合并。');
    } catch (e) {
      console.log('⚠️ 读取现有的 settings.json 失败，将覆盖创建。');
    }
  }

  if (!settingsData.hooks) settingsData.hooks = {};

  const hooksToAdd = [
    { event: 'UserPromptSubmit', timeout: 10000 },
    { event: 'PostToolUse', timeout: 10000 },
    { event: 'PreToolUse', timeout: 10000, matcher: 'Bash' },
    { event: 'Stop', timeout: 30000 },
    { event: 'SessionStart', timeout: 15000 },
    { event: 'SessionEnd', timeout: 10000 },
  ];

  hooksToAdd.forEach(({ event, timeout, matcher }) => {
    const cmd = os.platform() === 'win32'
      ? `cmd.exe /c chcp 65001 >nul & node "${hooksCliPath}" ${event}`
      : `node "${hooksCliPath}" ${event}`;

    const entry = {
      hooks: [{ type: 'command', command: cmd, timeout }]
    };
    if (matcher) {
      entry.matcher = matcher;
    }

    settingsData.hooks[event] = [entry];
  });

  fs.writeFileSync(settingsJsonPath, JSON.stringify(settingsData, null, 2), 'utf8');
  console.log(`✅ 已更新 CodeBuddy IDE Hooks: ${settingsJsonPath}`);

  // 配置 MCP
  const mcpJsonPath = path.join(ideDir, 'mcp.json');
  let mcpConfig = { mcpServers: {} };

  if (fs.existsSync(mcpJsonPath)) {
    try {
      mcpConfig = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));
      console.log('ℹ️ 发现现有的 CodeBuddy IDE mcp.json，将进行合并。');
    } catch (e) {
      console.log('⚠️ 读取现有的 mcp.json 失败，将覆盖创建。');
    }
  }

  if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};

  mcpConfig.mcpServers['agent-memory'] = {
    command: "node",
    args: [mcpServerPath],
    env: {}
  };

  fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2), 'utf8');
  console.log(`✅ 已更新 CodeBuddy IDE MCP: ${mcpJsonPath}`);
}

main().catch(err => {
  console.error('\n❌ 配置失败:', err);
  process.exit(1);
});
