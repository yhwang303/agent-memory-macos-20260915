# 插件 UI 动态注册设计文档

**主题**：让 viewer / settings 页面的插件 Tab 和卡片由插件自己声明，主程序不硬编码
**前置文档**：[插件框架设计文档](./2026-05-22-plugin-framework-design.md)
**作者**：cloudboyguo
**日期**：2026-05-25
**状态**：草案，待评审

---

## 1. 问题

当前 `web/viewer.html` 和 `desktop/src/windows/settings.html` 中，所有插件的 Tab 和卡片都是**写死**在 HTML 里的：

```html
<!-- viewer.html line 994-995 -->
<button class="tab evolve-tab" data-tab="self-evolve">Self-Evolve</button>
<button class="tab shadw-tab" data-tab="shadwmonitor">ShadwMonitor</button>
```

结果：
- 即使 `selfEvolve.enabled = false`，Self-Evolve Tab 仍然显示
- 新增/删除插件必须改主程序 HTML
- 违反"拔掉插件 → UI 全消失"的设计目标

---

## 2. 目标

1. **viewer.html** 的插件 Tab 通过 API 动态渲染 — 只有 `enabled: true` 的插件才出现
2. **settings.html** 的 Plugins 区块通过 IPC 动态渲染 — 插件卡片也是动态的
3. 主程序 HTML 只保留核心内容区（Summaries / Observations / Sessions / 通用设置）
4. 与已有[插件框架设计文档](./2026-05-22-plugin-framework-design.md)的 manifest 体系保持一致

---

## 3. 设计

### 3.1 新增 API: `GET /api/plugins/ui-manifest`

Worker 启动时，根据已加载的插件构建 UI manifest 列表。前端页面初始化时请求该接口。

**响应格式**：

```json
{
  "success": true,
  "data": [
    {
      "id": "self-evolve",
      "name": "Self-Evolve",
      "enabled": true,
      "tab": {
        "label": "Self-Evolve",
        "icon": "⚡",
        "order": 100,
        "badge": "se-badge",
        "cssClass": "evolve-tab"
      },
      "settingsCard": {
        "title": "Self-Evolve",
        "subtitle": "读取每次会话记忆，自动提炼 Rules / Skills，写入 CLAUDE.md",
        "order": 30,
        "accentColor": "#7c3aed"
      }
    },
    {
      "id": "shadwmonitor",
      "name": "ShadwMonitor",
      "enabled": true,
      "tab": {
        "label": "ShadwMonitor",
        "icon": "👁️",
        "order": 200,
        "badge": "shadw-badge",
        "cssClass": "shadw-tab"
      },
      "settingsCard": {
        "title": "ShadwMonitor",
        "subtitle": "桌面活动监控",
        "order": 40,
        "accentColor": "#f59e0b"
      }
    }
  ]
}
```

**注意**：
- **只返回 `enabled: true` 的插件**。前端不需要做 enabled 过滤 — 如果 API 返回了，就渲染
- 插件未安装或 enabled = false → 不出现在返回中
- `tab.order` 决定 Tab 在导航栏的位置（数字越小越靠前）
- `tab.badge` 是该插件挂载 badge 计数器的 DOM ID（可选）

### 3.2 类型定义: `src/plugins/types.ts`

```ts
export interface PluginUITab {
  label: string;
  icon?: string;
  order: number;
  badge?: string;      // DOM id for badge element
  cssClass?: string;
}

export interface PluginUISettingsCard {
  title: string;
  subtitle?: string;
  order: number;
  accentColor?: string;
}

export interface PluginUIManifest {
  id: string;
  name: string;
  enabled: boolean;
  tab?: PluginUITab;
  settingsCard?: PluginUISettingsCard;
}
```

### 3.3 WorkerService 变更

在 `WorkerService` 类中新增成员：

```ts
private pluginUIManifests: PluginUIManifest[] = [];
```

在 `start()` 方法里，各插件初始化后注册自己的 manifest：

```ts
// 初始化完毕后，注册 UI manifest
this.pluginUIManifests = [];

if (this.selfEvolve) {
  this.pluginUIManifests.push({
    id: 'self-evolve',
    name: 'Self-Evolve',
    enabled: true,
    tab: { label: 'Self-Evolve', icon: '⚡', order: 100, badge: 'se-badge', cssClass: 'evolve-tab' },
    settingsCard: { title: 'Self-Evolve', subtitle: '...', order: 30, accentColor: '#7c3aed' },
  });
}

// ShadwMonitor 独立进程，通过探测 HTTP 端口判断是否存在
// （或读取 desktop-config 中的 shadwmonitor 配置）
```

新增路由和 handler：

```ts
} else if (path === '/api/plugins/ui-manifest' && req.method === 'GET') {
  this.handlePluginsUIManifest(res);
}

private handlePluginsUIManifest(res: http.ServerResponse): void {
  res.statusCode = 200;
  res.end(JSON.stringify({ success: true, data: this.pluginUIManifests }));
}
```

### 3.4 viewer.html 改造

#### 3.4.1 HTML: 移除硬编码 Tab

**Before**:
```html
<div class="tabs">
  <button class="tab active" data-tab="summaries">Summaries</button>
  <button class="tab" data-tab="observations">Observations</button>
  <button class="tab" data-tab="sessions">Sessions</button>
  <button class="tab evolve-tab" data-tab="self-evolve">Self-Evolve ...</button>
  <button class="tab shadw-tab" data-tab="shadwmonitor">ShadwMonitor ...</button>
</div>
```

**After**:
```html
<div class="tabs">
  <button class="tab active" data-tab="summaries">Summaries</button>
  <button class="tab" data-tab="observations">Observations</button>
  <button class="tab" data-tab="sessions">Sessions</button>
  <!-- 插件 tab 由 JS 动态注入 -->
</div>
```

#### 3.4.2 HTML: 移除硬编码 Panel

删除 `<!-- Self-Evolve panel -->` 和 `<!-- ShadwMonitor panel -->` 的整个 HTML 块。
改为在 `<div id="regular-panel">` 后添加一个空容器：

```html
<div id="plugin-panels"></div>
```

#### 3.4.3 JS: 动态创建 Tab 和 Panel

```js
// 插件 tab 注册表：id → { loadFn, panelHtml, cssClass }
const PLUGIN_RENDERERS = {
  'self-evolve': {
    createPanel: createSEPanel,  // 返回面板 HTML string
    onActivate: loadSEData,      // 切换到该 Tab 时调用
  },
  'shadwmonitor': {
    createPanel: createShadwPanel,
    onActivate: loadShadwData,
  },
};

async function loadPluginTabs() {
  try {
    const res = await fetch(`${API_BASE}/api/plugins/ui-manifest`);
    const json = await res.json();
    if (!json.success || !Array.isArray(json.data)) return;

    const tabContainer = document.querySelector('.tabs');
    const panelContainer = document.getElementById('plugin-panels');

    // 按 order 排序
    const plugins = json.data.sort((a, b) => (a.tab?.order ?? 999) - (b.tab?.order ?? 999));

    for (const plugin of plugins) {
      if (!plugin.tab) continue;

      // 创建 Tab 按钮
      const btn = document.createElement('button');
      btn.className = `tab ${plugin.tab.cssClass || ''}`;
      btn.dataset.tab = plugin.id;
      btn.innerHTML = `${plugin.tab.label} ${plugin.tab.badge ? `<span id="${plugin.tab.badge}" class="tab-badge" style="display:none">0</span>` : ''}`;
      btn.addEventListener('click', () => switchTab(plugin.id));
      tabContainer.appendChild(btn);

      // 创建 Panel 容器
      const renderer = PLUGIN_RENDERERS[plugin.id];
      if (renderer) {
        const panel = document.createElement('div');
        panel.id = `${plugin.id}-panel`;
        panel.style.display = 'none';
        panel.innerHTML = renderer.createPanel();
        panelContainer.appendChild(panel);
      }
    }
  } catch (err) {
    console.warn('Failed to load plugin tabs:', err);
  }
}
```

#### 3.4.4 JS: switchTab 适配

修改 `switchTab()` 函数，动态识别插件面板：

```js
function switchTab(tabName) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));

  const regularPanel = document.getElementById('regular-panel');
  regularPanel.style.display = 'none';

  // 隐藏所有插件面板
  document.querySelectorAll('#plugin-panels > div').forEach(p => p.style.display = 'none');

  const pluginPanel = document.getElementById(`${tabName}-panel`);
  if (pluginPanel) {
    pluginPanel.style.display = 'block';
    const renderer = PLUGIN_RENDERERS[tabName];
    if (renderer?.onActivate) renderer.onActivate();
  } else {
    regularPanel.style.display = 'block';
    renderCurrentTab();
  }
}
```

#### 3.4.5 CSS: 保留插件样式

`.evolve-tab` 和 `.shadw-tab` 的 CSS 规则保留不动（它们通过 `cssClass` 被动态 apply）。

### 3.5 settings.html 改造（第二步，可后做）

Settings 页 Plugins Tab 的改法类似，但通过 IPC：

1. `preload-settings.ts` 暴露 `pluginsGetUIManifest` channel
2. `SettingsWindow.ts` 新增 handler，调用 Worker 的 `/api/plugins/ui-manifest`
3. settings.html 初始化时用返回数据动态生成插件卡片

本次可**先只做 viewer.html 的改造**，settings.html 在确认 viewer 模式跑通后再跟进。

---

## 4. 过渡策略

为了平滑过渡（不 break 现有功能），采用以下方式：

1. **Self-Evolve 面板的 JS 逻辑**保留在 viewer.html 中（loadSEData / renderSEPanel 等函数不动），但模板从静态 HTML 改为由 `createSEPanel()` 函数返回 HTML string
2. **ShadwMonitor 面板的 JS 逻辑**同理
3. 未来完整插件框架落地后，这些逻辑会被移到各自插件的 `ui.ts` / `ui.html` 文件中，由 UIPluginHost 按需注入

---

## 5. 关联 manifest

未来每个插件的 `plugin.json` 中应该有对应声明：

```json
{
  "id": "self-evolve",
  "capabilities": {
    "viewerTab": {
      "label": "Self-Evolve",
      "icon": "⚡",
      "order": 100,
      "cssClass": "evolve-tab"
    },
    "settingsSection": {
      "title": "Self-Evolve",
      "subtitle": "...",
      "order": 30,
      "accentColor": "#7c3aed"
    }
  }
}
```

本次因为完整的 PluginHost 还未落地，我们在 WorkerService 中**手动注册** manifest（相当于 inline manifest）。等框架落地后，改为从 `plugin.json` 文件读取。

---

## 6. 不改什么

- 各插件的后端逻辑（HTTP handler、数据库操作）不动
- 各插件的面板 JS 交互逻辑不动（只是从静态 HTML 变成函数生成 HTML）
- `api/self-evolve/*` 和 ShadwMonitor 的 API 路径不变
- CSS 样式不变

---

## 7. 验证清单

- [ ] `plugins.selfEvolve.enabled = false` → viewer 无 Self-Evolve Tab
- [ ] `plugins.selfEvolve.enabled = true` → Tab 出现，面板正常加载
- [ ] ShadwMonitor 未运行 → 对应 Tab 不出现（或由 API 不返回它）
- [ ] 打开设置页 → Plugins 区块不显示已禁用的插件卡片
- [ ] TypeScript 编译通过
- [ ] 前端无 JS console error
