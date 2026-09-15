import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getCodexMcpJsonPath, isCodexMcpRegistered } from './codex-config.js';
import {
  codexHookEntriesTrustedInConfig,
  readCodexHookTrustEntries,
  trustCodexHookEntriesInConfig,
} from './codex-hook-trust.js';

export type IDEType = 'codebuddy' | 'cursor' | 'codebuddy-ide' | 'claude-code' | 'claude-internal' | 'codex';

/** Paths to bundled runtime binaries used when registering IDE hooks / MCP. */
export interface HooksConfigPaths {
  nodePath: string;
  hooksCliPath: string;
  mcpServerPath: string;
  hybridMcpServerPath: string;
}

export interface DetectedIDE {
  type: IDEType;
  /** Parent data dir, e.g. ~/.gongfeng-copilot or ~/.cursor */
  ideDataDir: string;
  hooksJsonPath: string;
  /** True when hooks config exists and every IDE-specific event has a agent-memory hook. */
  isRegistered: boolean;
}

export interface RegisterResult {
  success: boolean;
  message?: string;
}

export interface UnregisterResult {
  success: boolean;
  message?: string;
}

type HookEventSpec = { name: string; timeout: number; matcher?: string };

const COMMON_HOOK_EVENTS: HookEventSpec[] = [
  { name: 'beforeSubmitPrompt', timeout: 10 },
  { name: 'afterAgentResponse', timeout: 30 },
  { name: 'afterAgentThought', timeout: 30 },
  { name: 'afterShellExecution', timeout: 30 },
  { name: 'afterMCPExecution', timeout: 30 },
  { name: 'afterFileEdit', timeout: 30 },
  { name: 'stop', timeout: 30 },
];

const CODEBUDDY_ONLY_HOOK_EVENTS: HookEventSpec[] = [
  { name: 'afterSearchReplaceFileEdit', timeout: 30 },
];

const CURSOR_ONLY_HOOK_EVENTS: HookEventSpec[] = [
  { name: 'sessionStart', timeout: 10 },
  { name: 'sessionEnd', timeout: 30 },
];

/** CodeBuddy IDE uses PascalCase event names and millisecond timeouts. */
const CODEBUDDY_IDE_HOOK_EVENTS: HookEventSpec[] = [
  { name: 'UserPromptSubmit', timeout: 10000 },
  { name: 'PostToolUse', timeout: 10000 },
  { name: 'PreToolUse', timeout: 10000, matcher: 'Bash' },
  { name: 'Stop', timeout: 30000 },
  { name: 'SessionStart', timeout: 15000 },
  { name: 'SessionEnd', timeout: 10000 },
];

/** Codex App uses PascalCase hook event ids in hooks.json; timeouts are seconds. */
const CODEX_HOOK_EVENTS: HookEventSpec[] = [
  { name: 'UserPromptSubmit', timeout: 10 },
  { name: 'SessionStart', timeout: 15 },
  { name: 'PostToolUse', timeout: 10 },
  { name: 'PreToolUse', timeout: 10 },
  { name: 'PreCompact', timeout: 30 },
  { name: 'Stop', timeout: 30 },
  { name: 'SessionEnd', timeout: 10 },
];

/** Claude Code uses PascalCase event names and millisecond timeouts (same as CodeBuddy IDE). */
const CLAUDE_CODE_HOOK_EVENTS: HookEventSpec[] = [
  { name: 'UserPromptSubmit', timeout: 10000 },
  { name: 'SessionStart', timeout: 15000 },
  { name: 'PostToolUse', timeout: 10000 },
  { name: 'PreToolUse', timeout: 10000, matcher: 'Bash' },
  { name: 'PreCompact', timeout: 30000 },
  { name: 'Stop', timeout: 30000 },
  { name: 'SessionEnd', timeout: 10000 },
];

const EVENT_DISPLAY: Record<string, string> = {
  beforeSubmitPrompt: 'Before submit prompt',
  afterAgentResponse: 'After agent response',
  afterAgentThought: 'After agent thought',
  afterShellExecution: 'After shell execution',
  afterMCPExecution: 'After MCP execution',
  afterFileEdit: 'After file edit',
  afterSearchReplaceFileEdit: 'After search/replace file edit',
  stop: 'Stop',
  sessionStart: 'Session start',
  sessionEnd: 'Session end',
  UserPromptSubmit: 'User prompt submit',
  PostToolUse: 'Post tool use',
  PreToolUse: 'Pre tool use',
  Stop: 'Stop (CodeBuddy IDE)',
  SessionStart: 'Session start (CodeBuddy IDE)',
  SessionEnd: 'Session end (CodeBuddy IDE)',
  PreCompact: 'Pre compact',
  // Claude Code specific (shares some PascalCase names with CodeBuddy IDE)
  'UserPromptSubmit:claude-code': 'User prompt submit (Claude Code)',
  'SessionStart:claude-code': 'Session start (Claude Code)',
  'PostToolUse:claude-code': 'Post tool use (Claude Code)',
  'PreToolUse:claude-code': 'Pre tool use (Claude Code)',
  'Stop:claude-code': 'Stop (Claude Code)',
  'SessionEnd:claude-code': 'Session end (Claude Code)',
  'UserPromptSubmit:codex': 'User prompt submit (Codex App / CLI)',
  'SessionStart:codex': 'Session start (Codex App / CLI)',
  'PostToolUse:codex': 'Post tool use (Codex App / CLI)',
  'PreToolUse:codex': 'Pre tool use (Codex App / CLI)',
  'PreCompact:codex': 'Pre compact (Codex App / CLI)',
  'Stop:codex': 'Stop (Codex App / CLI)',
  'SessionEnd:codex': 'Session end (Codex App / CLI)',
  'user_prompt_submit:codex': 'User prompt submit (Codex App / CLI)',
  'session_start:codex': 'Session start (Codex App / CLI)',
  'post_tool_use:codex': 'Post tool use (Codex App / CLI)',
  'pre_tool_use:codex': 'Pre tool use (Codex App / CLI)',
  'pre_compact:codex': 'Pre compact (Codex App / CLI)',
  'stop:codex': 'Stop (Codex App / CLI)',
  'session_end:codex': 'Session end (Codex App / CLI)',
};

function getHomeDir(): string {
  return os.homedir();
}

function codebuddyDataDir(): string {
  return path.join(getHomeDir(), '.gongfeng-copilot');
}

function cursorDataDir(): string {
  return path.join(getHomeDir(), '.cursor');
}

function codebuddyIdeDataDir(): string {
  return path.join(getHomeDir(), '.codebuddy');
}

function claudeCodeDataDir(): string {
  return path.join(getHomeDir(), '.claude');
}

function claudeInternalDataDir(): string {
  return path.join(getHomeDir(), '.claude-internal');
}

function codexDataDir(): string {
  return path.join(getHomeDir(), '.codex');
}

export function getHooksJsonPath(ide: IDEType): string {
  if (ide === 'codebuddy') {
    return path.join(codebuddyDataDir(), 'hooks', 'hooks.json');
  }
  if (ide === 'codebuddy-ide') {
    return path.join(codebuddyIdeDataDir(), 'settings.json');
  }
  if (ide === 'claude-code') {
    return path.join(claudeCodeDataDir(), 'settings.json');
  }
  if (ide === 'claude-internal') {
    return path.join(claudeInternalDataDir(), 'settings.json');
  }
  if (ide === 'codex') {
    return path.join(codexDataDir(), 'hooks.json');
  }
  return path.join(cursorDataDir(), 'hooks.json');
}

function getEventsForIDE(ide: IDEType): HookEventSpec[] {
  if (ide === 'cursor') {
    return [...COMMON_HOOK_EVENTS, ...CURSOR_ONLY_HOOK_EVENTS];
  }
  if (ide === 'codebuddy-ide') {
    return CODEBUDDY_IDE_HOOK_EVENTS;
  }
  if (ide === 'claude-code') {
    return CLAUDE_CODE_HOOK_EVENTS;
  }
  if (ide === 'claude-internal') {
    return CLAUDE_CODE_HOOK_EVENTS;
  }
  if (ide === 'codex') {
    return CODEX_HOOK_EVENTS;
  }
  return [...COMMON_HOOK_EVENTS, ...CODEBUDDY_ONLY_HOOK_EVENTS];
}

function buildHookCommand(
  eventName: string,
  nodePath: string,
  hooksCliPath: string,
  ide: IDEType,
  proxyScriptPath?: string,
  ideProxyCmdPath?: string,
  localNodePath?: string,
): string {
  if (ide === 'cursor') {
    // Windows: Cursor executes hooks via PowerShell pipe ($input | command).
    // PowerShell requires the pipe receiver to be a BARE command name 鈥?any
    // quoted path (even without spaces) is treated as a string expression and
    // rejected with ExpressionsMustBeFirstInPipeline.
    // Solution: use `cmd /c` as the bare receiver; cmd.exe handles quoted paths.
    if (localNodePath && proxyScriptPath && process.platform === 'win32') {
      return `cmd /c ${localNodePath} "${proxyScriptPath}" ${eventName}`;
    }
    // Non-Windows: system node calls the .js proxy (no space issue on macOS/Linux)
    if (proxyScriptPath) {
      return `node "${proxyScriptPath}" ${eventName}`;
    }
  }
  if (ide === 'codebuddy' && ideProxyCmdPath && process.platform !== 'win32') {
    // Command is ONLY the script path 鈥?no event name argument.
    // The Go chat agent's executor.go does os.Stat(command) on the full command string,
    // so any trailing argument causes "script not found". The wrapper script reads
    // hook_event_name from JSON stdin instead.
    return ideProxyCmdPath;
  }
  if (ide === 'codebuddy' && ideProxyCmdPath && process.platform === 'win32') {
    // Windows: the Go executor does os.Stat(command), so we must point to a real
    // .cmd file path. The per-event .cmd files are created by ensureGongfengEventCmdScripts.
    // ideProxyCmdPath here is the per-event cmd path passed from register().
    return ideProxyCmdPath;
  }
  if (ide === 'codebuddy-ide' && ideProxyCmdPath) {
    return `"${ideProxyCmdPath}" ${eventName}`;
  }
  if (ide === 'claude-code' && ideProxyCmdPath) {
    return `"${ideProxyCmdPath}" ${eventName}`;
  }
  if (ide === 'claude-internal' && ideProxyCmdPath) {
    return `"${ideProxyCmdPath}" ${eventName}`;
  }
  if (ide === 'codex' && ideProxyCmdPath) {
    return `"${ideProxyCmdPath}" ${eventName}`;
  }
  return `"${nodePath}" "${hooksCliPath}" ${eventName}`;
}

function buildExecutorBatContent(nodePath: string, hooksCliPath: string): string {
  const nodeDir = path.dirname(nodePath);
  return `@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

set "PATH=${nodeDir};%PATH%"
set "AGENTMEM_NODE=${nodePath}"
set "AGENTMEM_CLI=${hooksCliPath}"

set "SCRIPT_PATH="

:parse_args
if "%~1"=="" goto :check_path
if /i "%~1"=="/c" (
    shift
    goto :parse_args
)
set "SCRIPT_PATH=%~1"
shift
goto :parse_args

:check_path
if "%SCRIPT_PATH%"=="" (
    echo {"error":"No script path provided"}
    exit /b 1
)
if not exist "%SCRIPT_PATH%" (
    echo {"error":"Script file not found: %SCRIPT_PATH%"}
    exit /b 1
)

findstr /i "hooks-cli" "%SCRIPT_PATH%" >nul 2>&1
if %errorlevel% equ 0 goto :run_agentmemory

:run_raw
for /f "usebackq delims=" %%L in ("%SCRIPT_PATH%") do (
    set "LINE=%%L"
    if not "!LINE:~0,2!"=="#!" (
        if not "!LINE:~0,1!"=="#" (
            %%L
            exit /b !errorlevel!
        )
    )
)
goto :eof

:run_agentmemory
for /f "usebackq delims=" %%L in ("%SCRIPT_PATH%") do (
    set "LINE=%%L"
    if not "!LINE:~0,2!"=="#!" (
        if not "!LINE:~0,1!"=="#" (
            for %%A in (%%L) do set "_EVT=%%A"
        )
    )
)
"!AGENTMEM_NODE!" "!AGENTMEM_CLI!" !_EVT!
exit /b !errorlevel!
`;
}

function ensureExecutorBat(hooksDir: string, nodePath: string, hooksCliPath: string): string {
  const batPath = path.join(hooksDir, 'hooks-executor.bat');
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(batPath, buildExecutorBatContent(nodePath, hooksCliPath), 'utf8');
  return batPath;
}

/**
 * Windows + Gongfeng: create a per-event .cmd script file in the hooks dir.
 * The Go executor does os.Stat(command), so command must be a real file path.
 * We avoid `chcp` (not always available in the executor environment) and
 * `@echo off` (the executor's :run_agentmemory branch needs to read script content).
 * Returns a map of eventName 鈫?cmd file path.
 */
function ensureGongfengEventCmdScripts(
  hooksDir: string,
  nodePath: string,
  hooksCliPath: string,
  eventNames: string[],
): Record<string, string> {
  fs.mkdirSync(hooksDir, { recursive: true });
  const result: Record<string, string> = {};
  for (const evt of eventNames) {
    const cmdPath = path.join(hooksDir, `agentmemory-${evt}.cmd`);
    const content = `# AgentMemory hook script\r\n"${nodePath}" "${hooksCliPath}" ${evt}\r\n`;
    fs.writeFileSync(cmdPath, content, 'utf8');
    result[evt] = cmdPath;
  }
  return result;
}

function buildCursorProxyScript(nodePath: string, hooksCliPath: string): string {
  const escaped = (s: string) => s.replace(/\\/g, '\\\\');
  // AGENTMEM_IDE=cursor 璁?hooks-cli 涓€鐪奸攣瀹氳韩浠?鏃犻』鍐嶄緷璧栦簨浠跺悕鍚彂寮忎笌
  // codebuddy(Gongfeng) 鍖哄垎(涓よ€?SUPPORTED_EVENTS 瀹屽叏鐩稿悓)銆?
  // 鐢?process.env={...,AGENTMEM_IDE:'cursor'} 閫忎紶缁欏瓙杩涚▼,鑰屼笉鏄啓 .cmd 涓浆,
  // 鍥犱负 Cursor 鍦?Windows 鐢?PowerShell 绠￠亾 $input | command 璋冪敤,闇€瑕?cjs銆?
  return `const{spawn}=require('child_process');` +
    `const env=Object.assign({},process.env,{AGENTMEM_IDE:'cursor'});` +
    `const c=spawn("${escaped(nodePath)}"` +
    `,["${escaped(hooksCliPath)}",...process.argv.slice(2)]` +
    `,{stdio:['pipe','pipe','pipe'],env});` +
    `process.stdin.pipe(c.stdin);` +
    `c.stdout.pipe(process.stdout);` +
    `c.stderr.pipe(process.stderr);` +
    `c.on('exit',x=>process.exit(x||0));` +
    `\n`;
}

function ensureCodebuddyIdeProxyCmd(nodePath: string, hooksCliPath: string): string {
  const hooksDir = path.join(getHomeDir(), '.agent-memory', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const cmdPath = path.join(hooksDir, 'agentmemory-ide-hook.cmd');
  // AGENTMEM_IDE is the authoritative adapter hint read by resolveSourceAdapter() 鈥?
  // CodeBuddy IDE shares PascalCase event names with Claude Code, so without this
  // hint the event is mis-detected as claude-code and its non-jsonl transcript
  // fails to parse.
  const content = `@echo off\r\nchcp 65001 >nul\r\nset AGENTMEM_IDE=codebuddy-ide\r\n"${nodePath}" "${hooksCliPath}" %*\r\n`;
  fs.writeFileSync(cmdPath, content, 'utf8');
  return cmdPath;
}

/**
 * On macOS, IDEs like CodeBuddy/Genie use child_process.spawn(file, args, {shell:true}).
 * When file contains spaces (e.g. "/Applications/AgentMemory.app/..."), spawn joins
 * the path with args without quoting, so the shell splits on spaces and fails with
 * "No such file or directory". We work around this by creating a shell proxy script at a
 * path guaranteed to have no spaces, which then calls the actual node binary with proper quoting.
 *
 * For Gongfeng hooks, the Go agent does NOT pass hook_event_name as a CLI argument 鈥?
 * it only sends it via stdin JSON. The script saves stdin to a temp file, extracts
 * hook_event_name using node, then calls hooks-cli with the event name as argv[2]
 * and the original JSON piped via stdin.
 */
function ensureUnixProxyScript(scriptName: string, nodePath: string, hooksCliPath: string): string {
  const hooksDir = path.join(getHomeDir(), '.agent-memory', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const scriptPath = path.join(hooksDir, scriptName);

  const isGongfeng = scriptName.includes('gongfeng');
  let content: string;
  if (isGongfeng) {
    content =
      `#!/bin/sh\n` +
      `NODE="${nodePath}"\n` +
      `CLI="${hooksCliPath}"\n` +
      `TMPFILE=$(mktemp)\n` +
      `cat > "$TMPFILE"\n` +
      `EVENT=$("$NODE" -e "const d=require('fs').readFileSync('$TMPFILE','utf8');try{const j=JSON.parse(d);console.log(j.hook_event_name||'')}catch(e){console.log('')}")\n` +
      `if [ -z "$EVENT" ]; then\n` +
      `  rm -f "$TMPFILE"\n` +
      `  echo '{"error":"No hook_event_name in stdin JSON"}' >&2\n` +
      `  exit 1\n` +
      `fi\n` +
      `"$NODE" "$CLI" "$EVENT" < "$TMPFILE"\n` +
      `EXIT_CODE=$?\n` +
      `rm -f "$TMPFILE"\n` +
      `exit $EXIT_CODE\n`;
  } else {
    // Mirror the Windows AGENTMEM_IDE hint so hooks-cli can tell adapters apart
    // when their hook event names overlap (notably claude-code vs claude-internal,
    // and codex-cli's PascalCase Stop event vs claude-code's PascalCase Stop).
    const ideHint = scriptName.includes('claude-internal')
      ? 'claude-internal'
      : scriptName.includes('codex')
        ? 'codex-cli'
        : scriptName.includes('cursor')
          ? 'cursor'
          : scriptName.includes('claude')
            ? 'claude-code'
            : '';
    const envLine = ideHint ? `export AGENTMEM_IDE=${ideHint}\n` : '';
    content = `#!/bin/sh\n${envLine}exec "${nodePath}" "${hooksCliPath}" "$@"\n`;
  }

  try {
    const existing = fs.readFileSync(scriptPath, 'utf8');
    if (existing === content) {
      return scriptPath;
    }
  } catch { /* file doesn't exist yet */ }

  fs.writeFileSync(scriptPath, content, { mode: 0o755 });
  return scriptPath;
}

/**
 * macOS/Linux equivalent of the Windows hooks-executor.bat.
 * The Gongfeng Copilot chat agent passes a temp script file path to command_executor_path.
 * This shell script reads the temp file and executes it; if it contains "hooks-cli",
 * it extracts the event name and runs hooks-cli.js directly with proper paths.
 */
function ensureGongfengExecutorScript(nodePath: string, hooksCliPath: string): string {
  const hooksDir = path.join(getHomeDir(), '.agent-memory', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const scriptPath = path.join(hooksDir, 'agentmemory-gongfeng-executor.sh');
  const content =
    `#!/bin/sh\n` +
    `SCRIPT_PATH="$1"\n` +
    `if [ -z "$SCRIPT_PATH" ]; then echo '{"error":"No script path"}'; exit 1; fi\n` +
    `if [ ! -f "$SCRIPT_PATH" ]; then echo '{"error":"Script not found"}'; exit 1; fi\n` +
    `if grep -qi "hooks-cli" "$SCRIPT_PATH" 2>/dev/null; then\n` +
    `  EVT=$(grep -v "^#" "$SCRIPT_PATH" | head -1 | awk '{print $NF}')\n` +
    `  exec "${nodePath}" "${hooksCliPath}" "$EVT"\n` +
    `else\n` +
    `  exec /bin/sh "$SCRIPT_PATH"\n` +
    `fi\n`;
  fs.writeFileSync(scriptPath, content, { mode: 0o755 });
  return scriptPath;
}

function ensureClaudeCodeProxyCmd(nodePath: string, hooksCliPath: string): string {
  const hooksDir = path.join(getHomeDir(), '.agent-memory', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const cmdPath = path.join(hooksDir, 'agentmemory-claude-hook.cmd');
  // AGENTMEM_IDE lets hooks-cli tell Claude Code apart from Claude Internal:
  // both fire identical PascalCase events, so event-name detection alone
  // would always resolve to claude-code.
  const content = `@echo off\r\nchcp 65001 >nul\r\nset "AGENTMEM_IDE=claude-code"\r\n"${nodePath}" "${hooksCliPath}" %*\r\n`;
  fs.writeFileSync(cmdPath, content, 'utf8');
  return cmdPath;
}

function ensureClaudeInternalProxyCmd(nodePath: string, hooksCliPath: string): string {
  const hooksDir = path.join(getHomeDir(), '.agent-memory', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const cmdPath = path.join(hooksDir, 'agentmemory-claude-internal-hook.cmd');
  // See ensureClaudeCodeProxyCmd: this hint is what disambiguates the two.
  const content = `@echo off\r\nchcp 65001 >nul\r\nset "AGENTMEM_IDE=claude-internal"\r\n"${nodePath}" "${hooksCliPath}" %*\r\n`;
  fs.writeFileSync(cmdPath, content, 'utf8');
  return cmdPath;
}

function ensureCodexProxyCmd(nodePath: string, hooksCliPath: string): string {
  const hooksDir = path.join(getHomeDir(), '.agent-memory', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const cmdPath = path.join(hooksDir, 'agentmemory-codex-hook.cmd');
  // 娉ㄥ叆 AGENTMEM_IDE=codex-cli銆侰odex hook 浜嬩欢鍚?Stop/SessionStart/SessionEnd)
  // 鏄?PascalCase,涓?claude-code/claude-internal 瀹屽叏閲嶅彔;娌℃湁璇?env hint
  // hooks-cli 浼氭寜"鍏堟敞鍐屽厛璧?鍖归厤鍒?claude-code,鎶?codex 浼氳瘽閿欒鎴?claude銆?
  const content = `@echo off\r\nchcp 65001 >nul\r\nset "AGENTMEM_IDE=codex-cli"\r\n"${nodePath}" "${hooksCliPath}" %*\r\n`;
  fs.writeFileSync(cmdPath, content, 'utf8');
  return cmdPath;
}

function ensureLocalNodeBinary(bundledNodePath: string): string {
  const binDir = path.join(getHomeDir(), '.agent-memory', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const localNodePath = path.join(binDir, 'node.exe');
  try {
    const srcStat = fs.statSync(bundledNodePath);
    let needCopy = true;
    try {
      const dstStat = fs.statSync(localNodePath);
      needCopy = srcStat.size !== dstStat.size;
    } catch { /* dest doesn't exist */ }
    if (needCopy) {
      fs.copyFileSync(bundledNodePath, localNodePath);
    }
  } catch {
    fs.copyFileSync(bundledNodePath, localNodePath);
  }
  return localNodePath.replace(/\\/g, '/');
}

function ensureCursorProxyScript(cursorDir: string, nodePath: string, hooksCliPath: string): string {
  const hooksDir = path.join(cursorDir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const content = buildCursorProxyScript(nodePath, hooksCliPath);
  // 鍚屾椂鍐?.cjs 鍜?.js,浣?hooks.json 鎸囧悜 .cjs:
  // - .cjs 涓嶅彈 cursor hooks 鐩綍閲?package.json `"type":"module"` 绾︽潫,濮嬬粓鎸?CJS
  //   瑙ｆ瀽,杩欐槸 require()-based 鍖呰鍣ㄥ敮涓€绋冲畾鐨勬墿灞曞悕銆?
  // - 鑰佺敤鎴风殑 hooks.json 鍙兘浠嶆寚鍚?agent-memory.js(鏈韩灏辨槸 bug,浼氳Е鍙?
  //   "ReferenceError: require is not defined in ES module scope"),涔熻鐩栦竴浠?
  //   淇濊瘉鍐呭涓€鑷?浣嗘柊鍐欏嚭鐨?hooks.json 涓€寰嬫寚鍚?.cjs銆?
  const proxyPathCjs = path.join(hooksDir, 'agent-memory.cjs');
  const proxyPathJs  = path.join(hooksDir, 'agent-memory.js');
  fs.writeFileSync(proxyPathCjs, content, 'utf8');
  fs.writeFileSync(proxyPathJs,  content, 'utf8');
  return proxyPathCjs.replace(/\\/g, '/');
}

export function isCodebuddyMemHook(hook: unknown): boolean {
  if (!hook || typeof hook !== 'object') return false;
  const h = hook as Record<string, unknown>;
  const hid = h.hook_id;
  if (typeof hid === 'string' && (hid.startsWith('agent-memory:') || hid.startsWith('codebuddy-mem:'))) return true;
  const cmd = h.command;
  if (typeof cmd === 'string') {
    if (cmd.includes('hooks-cli') || cmd.includes('agent-memory')) return true;
    if (cmd.includes('agentmemory-')) return true;
    if (cmd.includes('codebuddy-mem') || cmd.includes('cbmem-')) return true;
  }
  return false;
}

/**
 * Detect hooks that use cross-platform path residuals (e.g. Windows paths on macOS
 * or vice versa) and would fail at runtime. These should be cleaned up during registration.
 */
export function isCrossPlatformResidualHook(hook: unknown): boolean {
  if (!hook || typeof hook !== 'object') return false;
  const h = hook as Record<string, unknown>;
  const cmd = h.command;
  if (typeof cmd !== 'string') return false;
  if (process.platform !== 'win32') {
    if (/[A-Z]:\\/.test(cmd)) return true;
  } else {
    if (cmd.startsWith('/') && cmd.includes('.sh')) return true;
  }
  return false;
}

/** Check if a CodeBuddy IDE rule group (nested hooks array) contains our hook. */
function isCodebuddyIdeOurRuleGroup(group: unknown): boolean {
  if (!group || typeof group !== 'object') return false;
  const g = group as Record<string, unknown>;
  const hooks = g.hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some((h) => {
    if (!h || typeof h !== 'object') return false;
    const cmd = (h as Record<string, unknown>).command;
    return typeof cmd === 'string' && (
      cmd.includes('hooks-cli') || cmd.includes('agent-memory') || cmd.includes('agentmemory-')
      || cmd.includes('codebuddy-mem') || cmd.includes('cbmem-')
    );
  });
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    let raw = fs.readFileSync(filePath, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) {
      raw = raw.slice(1);
    }
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function ensureParentDir(filePath: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function emptyConfigForIDE(ide: IDEType): Record<string, unknown> {
  if (ide === 'cursor') {
    return { version: 1, hooks: {} };
  }
  if (ide === 'codebuddy-ide') {
    return { hooks: {} };
  }
  if (ide === 'claude-code') {
    return { hooks: {} };
  }
  if (ide === 'claude-internal') {
    return { hooks: {} };
  }
  if (ide === 'codex') {
    return { hooks: {} };
  }
  return { version: 1, enabled: true, hooks: {} };
}

/** True if this hook entry (or rule group for CodeBuddy IDE) is our registration for the given IDE event. */
function isOurHookForEvent(
  hook: unknown,
  eventName: string,
  ide: IDEType,
): boolean {
  if (ide === 'codebuddy-ide' || ide === 'claude-code' || ide === 'claude-internal' || ide === 'codex') {
    return isCodebuddyIdeOurRuleGroup(hook);
  }
  if (!isCodebuddyMemHook(hook)) return false;
  const rec = hook as Record<string, unknown>;
  if (ide === 'codebuddy') {
    return (
      rec.hook_id === `agent-memory:${eventName}` || rec.trigger_event === eventName
    );
  }
  const cmd = rec.command;
  if (typeof cmd !== 'string') return false;
  if (!cmd.includes('hooks-cli') && !cmd.includes('agent-memory')) return false;
  return cmd.endsWith(` ${eventName}`) || cmd.endsWith(`"${eventName}`);
}

function eventHasOurHook(
  hookList: unknown[] | undefined,
  eventName: string,
  ide: IDEType,
): boolean {
  if (!Array.isArray(hookList)) return false;
  return hookList.some((h) => {
    if (!isOurHookForEvent(h, eventName, ide)) return false;
    const entry = h as Record<string, unknown>;
    const commands = Array.isArray(entry.hooks) ? entry.hooks : [entry];
    return commands.some(isUsableMemoryHook);
  });
}

/** Ownership is also used for cleanup; registration additionally needs a live entrypoint. */
function isUsableMemoryHook(hook: unknown): boolean {
  if (!isCodebuddyMemHook(hook)) return false;
  const command = (hook as Record<string, unknown>).command;
  if (typeof command !== 'string') return false;
  // A restored pre-rename settings backup must trigger migration, even if its
  // old wrapper still exists. It may point at a removed app or data directory.
  if (command.includes('codebuddy-mem') || command.includes('cbmem-')) return false;
  if (isCrossPlatformResidualHook(hook)) return false;
  const executable = /^(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(command.trim());
  const target = executable?.[1] ?? executable?.[2] ?? executable?.[3];
  if (target && path.isAbsolute(target)) {
    try {
      if (!fs.statSync(target).isFile()) return false;
      fs.accessSync(target, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    } catch {
      return false;
    }
  }
  return true;
}

export function computeIsRegistered(
  ide: IDEType,
  config: Record<string, unknown> | null,
): boolean {
  if (!config) return false;
  const hooks = config.hooks as Record<string, unknown[]> | undefined;
  if (!hooks || typeof hooks !== 'object') return false;
  const events = getEventsForIDE(ide);
  for (const ev of events) {
    const list = hooks[ev.name];
    if (!eventHasOurHook(list, ev.name, ide)) return false;
  }
  return true;
}

export function detectIDEs(): DetectedIDE[] {
  const out: DetectedIDE[] = [];

  if (fs.existsSync(codebuddyDataDir())) {
    const hooksJsonPath = getHooksJsonPath('codebuddy');
    const raw = readJsonFile<Record<string, unknown>>(hooksJsonPath);
    out.push({
      type: 'codebuddy',
      ideDataDir: codebuddyDataDir(),
      hooksJsonPath,
      isRegistered: computeIsRegistered('codebuddy', raw),
    });
  }

  if (fs.existsSync(cursorDataDir())) {
    const hooksJsonPath = getHooksJsonPath('cursor');
    const raw = readJsonFile<Record<string, unknown>>(hooksJsonPath);
    out.push({
      type: 'cursor',
      ideDataDir: cursorDataDir(),
      hooksJsonPath,
      isRegistered: computeIsRegistered('cursor', raw),
    });
  }

  if (fs.existsSync(codebuddyIdeDataDir())) {
    const hooksJsonPath = getHooksJsonPath('codebuddy-ide');
    const raw = readJsonFile<Record<string, unknown>>(hooksJsonPath);
    out.push({
      type: 'codebuddy-ide',
      ideDataDir: codebuddyIdeDataDir(),
      hooksJsonPath,
      isRegistered: computeIsRegistered('codebuddy-ide', raw),
    });
  }

  if (fs.existsSync(claudeCodeDataDir())) {
    const hooksJsonPath = getHooksJsonPath('claude-code');
    const raw = readJsonFile<Record<string, unknown>>(hooksJsonPath);
    out.push({
      type: 'claude-code',
      ideDataDir: claudeCodeDataDir(),
      hooksJsonPath,
      isRegistered: computeIsRegistered('claude-code', raw),
    });
  }

  if (fs.existsSync(claudeInternalDataDir())) {
    const hooksJsonPath = getHooksJsonPath('claude-internal');
    const raw = readJsonFile<Record<string, unknown>>(hooksJsonPath);
    out.push({
      type: 'claude-internal',
      ideDataDir: claudeInternalDataDir(),
      hooksJsonPath,
      isRegistered: computeIsRegistered('claude-internal', raw),
    });
  }

  if (fs.existsSync(codexDataDir())) {
    const hooksJsonPath = getHooksJsonPath('codex');
    const raw = readJsonFile<Record<string, unknown>>(hooksJsonPath);
    const hooksOk = computeIsRegistered('codex', raw);
    const trustEntries = hooksOk ? readCodexHookTrustEntries() : [];
    const trustOk = hooksOk && codexHookEntriesTrustedInConfig(trustEntries);
    out.push({
      type: 'codex',
      ideDataDir: codexDataDir(),
      hooksJsonPath,
      isRegistered: hooksOk && trustOk && isCodexMcpRegistered(getCodexMcpJsonPath()),
    });
  }

  return out;
}

function makeCodeBuddyHookEntry(
  eventName: string,
  command: string,
): Record<string, string> {
  const display = EVENT_DISPLAY[eventName] ?? eventName;
  return {
    command,
    display_name: `[AgentMemory] ${display}`,
    hook_id: `agent-memory:${eventName}`,
    trigger_event: eventName,
    trigger_event_display: display,
  };
}

function makeCursorHookEntry(
  command: string,
  timeout: number,
): { command: string; timeout: number } {
  return { command, timeout };
}

function makeCodeBuddyIdeHookEntry(
  command: string,
  timeout: number,
  matcher?: string,
): { matcher?: string; hooks: { type: string; command: string; timeout: number }[] } {
  const entry: { matcher?: string; hooks: { type: string; command: string; timeout: number }[] } = {
    hooks: [{ type: 'command', command, timeout }],
  };
  if (matcher) {
    entry.matcher = matcher;
  }
  return entry;
}

function appendHookToFirstRuleGroup(
  groups: unknown[],
  command: string,
  timeout: number,
  matcher?: string,
): unknown[] {
  const entry = { type: 'command', command, timeout };
  if (groups.length === 0) {
    return [makeCodeBuddyIdeHookEntry(command, timeout, matcher)];
  }

  const [first, ...rest] = groups;
  if (!first || typeof first !== 'object' || !Array.isArray((first as Record<string, unknown>).hooks)) {
    return [makeCodeBuddyIdeHookEntry(command, timeout, matcher), first, ...rest];
  }

  const merged: Record<string, unknown> = {
    ...(first as Record<string, unknown>),
    hooks: [...((first as Record<string, unknown>).hooks as unknown[]), entry],
  };
  if (matcher && typeof merged.matcher !== 'string') {
    merged.matcher = matcher;
  }
  return [merged, ...rest];
}

export function register(
  ide: IDEType,
  configPaths: HooksConfigPaths,
): RegisterResult {
  const hooksJsonPath = getHooksJsonPath(ide);
  const events = getEventsForIDE(ide);

  let config = readJsonFile<Record<string, unknown>>(hooksJsonPath) ?? emptyConfigForIDE(ide);

  if (typeof config !== 'object' || config === null) {
    config = emptyConfigForIDE(ide);
  }

  if (!('hooks' in config) || typeof config.hooks !== 'object' || config.hooks === null) {
    config.hooks = {};
  }

  const hooks = config.hooks as Record<string, unknown[]>;

  let cursorProxyPath: string | undefined;
  let localNodePath: string | undefined;
  let ideProxyCmdPath: string | undefined;
  let gongfengCmdPaths: Record<string, string> | undefined;

  if (ide === 'codebuddy') {
    if (process.platform === 'win32') {
      const hooksDir = path.dirname(hooksJsonPath);
      const executorPath = ensureExecutorBat(hooksDir, configPaths.nodePath, configPaths.hooksCliPath);
      config.command_executor_path = executorPath;
      gongfengCmdPaths = ensureGongfengEventCmdScripts(
        hooksDir,
        configPaths.nodePath,
        configPaths.hooksCliPath,
        events.map((e) => e.name),
      );
    } else {
      // macOS/Linux: create shell proxy script (space-free path).
      // Do NOT set command_executor_path 鈥?the Go chat agent misparses quoted paths
      // when an executor is configured, causing "script not found" errors.
      // Without it, the agent executes the command directly via /bin/sh which works fine.
      ideProxyCmdPath = ensureUnixProxyScript('agentmemory-gongfeng-hook.sh', configPaths.nodePath, configPaths.hooksCliPath);
      delete config.command_executor_path;
    }
  }

  if (ide === 'cursor') {
    cursorProxyPath = ensureCursorProxyScript(cursorDataDir(), configPaths.nodePath, configPaths.hooksCliPath);
    if (process.platform === 'win32') {
      localNodePath = ensureLocalNodeBinary(configPaths.nodePath);
    }
  }

  if (ide === 'codebuddy-ide') {
    if (process.platform === 'win32') {
      ideProxyCmdPath = ensureCodebuddyIdeProxyCmd(configPaths.nodePath, configPaths.hooksCliPath);
    } else {
      // On macOS/Linux, use a shell script proxy to avoid spawn+shell:true failing on paths with spaces
      ideProxyCmdPath = ensureUnixProxyScript('agentmemory-ide-hook.sh', configPaths.nodePath, configPaths.hooksCliPath);
    }
  }

  if (ide === 'claude-code') {
    if (process.platform === 'win32') {
      ideProxyCmdPath = ensureClaudeCodeProxyCmd(configPaths.nodePath, configPaths.hooksCliPath);
    } else {
      ideProxyCmdPath = ensureUnixProxyScript('agentmemory-claude-hook.sh', configPaths.nodePath, configPaths.hooksCliPath);
    }
  }

  if (ide === 'claude-internal') {
    if (process.platform === 'win32') {
      ideProxyCmdPath = ensureClaudeInternalProxyCmd(configPaths.nodePath, configPaths.hooksCliPath);
    } else {
      ideProxyCmdPath = ensureUnixProxyScript('agentmemory-claude-internal-hook.sh', configPaths.nodePath, configPaths.hooksCliPath);
    }
  }

  if (ide === 'codex') {
    if (process.platform === 'win32') {
      ideProxyCmdPath = ensureCodexProxyCmd(configPaths.nodePath, configPaths.hooksCliPath);
    } else {
      ideProxyCmdPath = ensureUnixProxyScript('agentmemory-codex-hook.sh', configPaths.nodePath, configPaths.hooksCliPath);
    }
  }

  if (ide === 'codex') {
    for (const key of Object.keys(hooks)) {
      const list = hooks[key];
      if (!Array.isArray(list)) continue;
      const filtered = list.filter((h) => !isCodebuddyIdeOurRuleGroup(h) && !isCrossPlatformResidualHook(h));
      if (filtered.length === 0) delete hooks[key];
      else hooks[key] = filtered;
    }
  }

  for (const ev of events) {
    const eventName = ev.name;
    const list = Array.isArray(hooks[eventName]) ? [...hooks[eventName]] : [];

    const perEventProxy = gongfengCmdPaths?.[eventName] ?? ideProxyCmdPath;
    const cmd = buildHookCommand(eventName, configPaths.nodePath, configPaths.hooksCliPath, ide, cursorProxyPath, perEventProxy, localNodePath);
    const filtered = list.filter((h) => !isOurHookForEvent(h, eventName, ide) && !isCrossPlatformResidualHook(h));

    if (ide === 'codebuddy') {
      filtered.push(makeCodeBuddyHookEntry(eventName, cmd));
    } else if (ide === 'codex') {
      hooks[eventName] = appendHookToFirstRuleGroup(filtered, cmd, ev.timeout, ev.matcher);
      continue;
    } else if (ide === 'codebuddy-ide' || ide === 'claude-code' || ide === 'claude-internal') {
      filtered.push(makeCodeBuddyIdeHookEntry(cmd, ev.timeout, ev.matcher));
    } else {
      filtered.push(makeCursorHookEntry(cmd, ev.timeout));
    }

    hooks[eventName] = filtered;
  }

  if (ide === 'cursor') {
    config.version = 1;
  } else if (ide === 'codebuddy') {
    config.version = 1;
    config.enabled = true;
  }

  try {
    ensureParentDir(hooksJsonPath);
    fs.writeFileSync(hooksJsonPath, JSON.stringify(config, null, 2), 'utf8');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, message: msg };
  }

  if (ide === 'codex') {
    const entries = readCodexHookTrustEntries();
    if (entries.length > 0 && !trustCodexHookEntriesInConfig(entries)) {
      return {
        success: true,
        message:
          'Hooks written, but Codex hook trust state could not be updated automatically. Please approve the AgentMemory hooks in Codex settings, or register again.',
      };
    }
  }

  return { success: true };
}

export function unregister(ide: IDEType): UnregisterResult {
  const hooksJsonPath = getHooksJsonPath(ide);
  if (!fs.existsSync(hooksJsonPath)) {
    return { success: true, message: 'hooks config not found; nothing to remove' };
  }

  const config = readJsonFile<Record<string, unknown>>(hooksJsonPath);
  if (!config || typeof config !== 'object') {
    return { success: false, message: 'Invalid hooks config' };
  }

  const hooks = config.hooks as Record<string, unknown[]> | undefined;
  if (!hooks || typeof hooks !== 'object') {
    return { success: true, message: 'No hooks object' };
  }

  for (const key of Object.keys(hooks)) {
    const list = hooks[key];
    if (!Array.isArray(list)) continue;
    const filtered = (ide === 'codebuddy-ide' || ide === 'claude-code' || ide === 'claude-internal' || ide === 'codex')
      ? list.filter((h) => !isCodebuddyIdeOurRuleGroup(h))
      : list.filter((h) => !isCodebuddyMemHook(h));
    if (filtered.length === 0) {
      delete hooks[key];
    } else {
      hooks[key] = filtered;
    }
  }

  try {
    fs.writeFileSync(hooksJsonPath, JSON.stringify(config, null, 2), 'utf8');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, message: msg };
  }

  return { success: true };
}
