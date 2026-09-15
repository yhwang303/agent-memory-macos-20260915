import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const settingsHtml = readFileSync(resolve('desktop/src/windows/settings.html'), 'utf8');
const settingsWindowTs = readFileSync(resolve('desktop/src/windows/SettingsWindow.ts'), 'utf8');
const configStoreTs = readFileSync(resolve('desktop/src/config/store.ts'), 'utf8');

function sliceFunctionBody(functionSignature: string, nextFunctionSignature: string): string {
  const start = settingsHtml.indexOf(functionSignature);
  const end = settingsHtml.indexOf(nextFunctionSignature, start);
  assert.notEqual(start, -1, `settings page should define ${functionSignature}`);
  assert.notEqual(end, -1, `${functionSignature} should be followed by ${nextFunctionSignature}`);
  return settingsHtml.slice(start, end);
}

test('settings page binds button handlers before awaiting config IPC', () => {
  const domReadyStart = settingsHtml.indexOf("window.addEventListener('DOMContentLoaded'");
  assert.notEqual(domReadyStart, -1, 'settings page should register a DOMContentLoaded handler');

  const firstConfigAwait = settingsHtml.indexOf('await window.settingsAPI.getConfig()', domReadyStart);
  const bindHandlersCall = settingsHtml.indexOf(
    'bindSettingsEventHandlers();',
    domReadyStart,
  );

  assert.notEqual(firstConfigAwait, -1, 'settings page should load config during initialization');
  assert.notEqual(bindHandlersCall, -1, 'settings page should bind button handlers');
  assert.ok(
    bindHandlersCall < firstConfigAwait,
    'button handlers must be bound before config IPC awaits so init failures do not leave settings buttons inert',
  );

  assert.match(
    settingsHtml,
    /document\.getElementById\('saveBtn'\)\.addEventListener\('click', saveSettings\)/,
    'settings page should bind the save button inside its handler setup',
  );
});

test('settings page does not save full config before hydration succeeds', () => {
  const saveStart = settingsHtml.indexOf('async function saveSettings()');
  const saveEnd = settingsHtml.indexOf('async function onApplyInvite()', saveStart);
  assert.notEqual(saveStart, -1, 'settings page should define saveSettings');
  assert.notEqual(saveEnd, -1, 'saveSettings should be followed by onApplyInvite');

  const saveBlock = settingsHtml.slice(saveStart, saveEnd);
  assert.match(
    saveBlock,
    /if\s*\(!settingsConfigLoaded\)/,
    'saveSettings must refuse full saves until the base config has hydrated',
  );
});

test('settings page does not write ShadowFolk config before hydration succeeds', () => {
  const saveStart = settingsHtml.indexOf('async function saveShadowfolkConfigFile()');
  const saveEnd = settingsHtml.indexOf('async function saveShadowfolkPluginSettings()', saveStart);
  assert.notEqual(saveStart, -1, 'settings page should define saveShadowfolkConfigFile');
  assert.notEqual(saveEnd, -1, 'saveShadowfolkConfigFile should be followed by saveShadowfolkPluginSettings');

  const saveBlock = settingsHtml.slice(saveStart, saveEnd);
  assert.match(
    saveBlock,
    /if\s*\(!shadowfolkConfigLoaded\)/,
    'ShadowFolk external config must not be written from empty fallback fields',
  );
});

test('settings page persists ShadowFolk workspace aliases with plugin settings', () => {
  const pluginSaveBlock = sliceFunctionBody(
    'async function saveShadowfolkPluginSettings()',
    'async function pushShadowfolkNow()',
  );
  const fullSaveBlock = sliceFunctionBody(
    'async function saveSettings()',
    'async function onApplyInvite()',
  );
  const settingsGuard = pluginSaveBlock.search(/if\s*\(\s*!settingsConfigLoaded\s*\)/);
  const shadowfolkConfigSave = pluginSaveBlock.indexOf('await saveShadowfolkConfigFile()');
  const pluginConfigSave = pluginSaveBlock.indexOf('window.settingsAPI.saveConfig');

  assert.notEqual(
    settingsGuard,
    -1,
    'ShadowFolk plugin save should refuse writes before base settings hydrate',
  );
  assert.notEqual(
    shadowfolkConfigSave,
    -1,
    'ShadowFolk plugin save should write the external config file',
  );
  assert.notEqual(
    pluginConfigSave,
    -1,
    'ShadowFolk plugin save should write plugin settings',
  );
  assert.ok(
    settingsGuard < shadowfolkConfigSave,
    'ShadowFolk plugin save guard must run before saving the external config file',
  );
  assert.ok(
    settingsGuard < pluginConfigSave,
    'ShadowFolk plugin save guard must run before saving plugin settings',
  );

  for (const saveBlock of [pluginSaveBlock, fullSaveBlock]) {
    assert.match(
      saveBlock,
      /shadowfolkWorkspaceAliases:\s*\[\.\.\.shadowfolkWorkspaceAliases\]/,
      'ShadowFolk saves should include workspace aliases',
    );
  }
});

test('settings page allows recorded memory projects to upload without a local git workspace', () => {
  const addWorkspaceBlock = sliceFunctionBody(
    'async function addShadowfolkWorkspace(rawPath)',
    'async function refreshShadowfolkStatus',
  );

  assert.match(
    settingsHtml,
    /addShadowfolkWorkspaceAlias/,
    'settings page should define an alias binding helper',
  );
  assert.match(
    settingsHtml,
    /已有记忆即可上传，不要求原路径仍存在或必须是 Git 仓库/,
    'settings page should explain memory-only projects do not need a local git workspace',
  );
  assert.match(
    settingsHtml,
    /populateShadowfolkAliasProjectSelect/,
    'old memory paths should be selected from recorded memory projects',
  );
  assert.match(
    settingsHtml,
    /shadowfolk-workspace-details/,
    'workspace alias and replay controls should live in a collapsible details section',
  );
  assert.match(
    settingsHtml,
    /summary\.textContent = `高级设置/,
    'collapsed workspace controls should be labeled as advanced settings',
  );
  assert.doesNotMatch(
    settingsHtml,
    /输入旧记忆路径/,
    'old memory paths should not be entered manually',
  );
  assert.match(
    addWorkspaceBlock,
    /result\.mode === 'memory'/,
    'workspace add flow should recognize memory-only validation results',
  );
  assert.match(
    addWorkspaceBlock,
    /已添加仅记忆项目：.*上传不依赖本机目录/s,
    'workspace add flow should confirm that memory-only upload does not depend on the local path',
  );
});

test('settings page refresh status button has explicit visible feedback', () => {
  const bindBlock = sliceFunctionBody(
    'function bindSettingsEventHandlers()',
    'function switchSettingsTab(panelId)',
  );
  const refreshButtonBlock = sliceFunctionBody(
    'async function refreshShadowfolkStatusFromButton()',
    'async function refreshShadowfolkStatus(options = {})',
  );

  assert.match(
    bindBlock,
    /shadowfolkRefreshBtn'\)\.addEventListener\('click', refreshShadowfolkStatusFromButton\)/,
    'refresh status button should use a dedicated click handler instead of passing a click event as options',
  );
  assert.match(
    refreshButtonBlock,
    /btn\.disabled = true/,
    'refresh status button should be disabled while refreshing',
  );
  assert.match(
    refreshButtonBlock,
    /btn\.textContent = '刷新中…'/,
    'refresh status button should show an in-progress label',
  );
  assert.match(
    refreshButtonBlock,
    /setShadowfolkStatus\('正在刷新 ShadowFolk 状态…'\)/,
    'refresh status button should immediately show visible feedback',
  );
  assert.match(
    refreshButtonBlock,
    /await refreshShadowfolkStatus\(\{ refreshReplay: true \}\)/,
    'refresh status button should explicitly refresh replay controls',
  );
});

test('SettingsWindow cleanup removes ShadowFolk workspace IPC handlers', () => {
  const destroyStart = settingsWindowTs.indexOf('destroy(): void');
  const destroyEnd = settingsWindowTs.indexOf('this.window?.destroy()', destroyStart);
  assert.notEqual(destroyStart, -1, 'SettingsWindow should define destroy');
  assert.notEqual(destroyEnd, -1, 'destroy should clean up before destroying the window');
  const destroyBlock = settingsWindowTs.slice(destroyStart, destroyEnd);

  for (const channel of [
    'shadowfolk:history',
    'shadowfolk:replay',
    'shadowfolk:suggest-aliases',
  ]) {
    assert.match(
      destroyBlock,
      new RegExp(`ipcMain\\.removeHandler\\('${channel}'\\)`),
      `destroy should remove ${channel}`,
    );
  }
});

test('settings page wires Alibaba Cloud Model Studio through the full provider chain', () => {
  assert.match(settingsHtml, /<option value="aliyun-bailian">阿里云百炼<\/option>/);
  const modelsMatch = settingsHtml.match(/'aliyun-bailian': \[([\s\S]*?)\n\s*\],/);
  assert.ok(modelsMatch, 'Alibaba Cloud Model Studio should define its model list');
  const models = Array.from(modelsMatch[1].matchAll(/'([^']+)'/g), (match) => match[1]);
  assert.deepEqual(models, [
    'qwen3.7-flash',
    'qwen3.8-max', 'qwen3.8-max-0902', 'qwen3.8-flash', 'qwen3.8-2.4t-a95b', 'qwen3.8-27b',
    'qwen3.7-plus', 'qwen3.7-plus-2026-05-26', 'qwen3.7-flash-2026-07-15',
    'qwen3.7-max', 'qwen3.7-max-preview', 'qwen3.7-max-2026-06-08', 'qwen3.7-max-2026-05-20', 'qwen3.7-max-2026-05-17',
    'qwen3.6-max-preview', 'qwen3.6-plus', 'qwen3.6-plus-2026-04-02',
    'qwen3.6-flash', 'qwen3.6-flash-2026-04-16', 'qwen3.6-27b', 'qwen3.6-35b-a3b',
  ]);
  assert.match(settingsWindowTs, /'deepseek', 'aliyun-bailian'/);
  assert.match(configStoreTs, /'deepseek' \| 'aliyun-bailian'/);
  assert.match(
    configStoreTs,
    /https:\/\/dashscope\.aliyuncs\.com\/compatible-mode\/v1\/chat\/completions/,
  );
  assert.match(configStoreTs, /highProvider === 'aliyun-bailian'/);
});
