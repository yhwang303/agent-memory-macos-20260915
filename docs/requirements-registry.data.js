// 需求种子数据：页面加载时自动合并进注册中心（按 id 去重，已存在则保留本地进度）。
// 新增需求时往这个数组里加一条即可，无需手动「导入 JSON」。
window.SEED_REQUIREMENTS = [
  {
    id: "injector20260529",
    code: "FEAT-001",
    title: "Injector 通用规范注入器插件",
    type: "feature",
    module: "hooks-adapter",
    path: "docs/hooks-adapter/features/spec-injector-plugin/",
    created: "2026-05-29",
    phases: {
      prd: "done",
      design: "done",
      gate: "passed",
      impl: "done",
      testcase: "todo",
      testreport: "todo"
    },
    status: "in-progress",
    assignee: "agent:claude@injector-impl",
    claimedAt: "2026-05-29T08:01:00.000Z",
    updatedAt: "2026-05-29T08:18:00.000Z"
  },
  {
    id: "harness20260529",
    code: "FEAT-002",
    title: "研发 harness 流程规范与 agent 任务认领",
    type: "feature",
    module: "release",
    path: "docs/release/features/dev-harness-and-agent-task-claiming/",
    created: "2026-05-29",
    phases: {
      prd: "done",
      design: "done",
      gate: "passed",
      impl: "done",
      testcase: "todo",
      testreport: "todo"
    },
    status: "in-progress",
    assignee: "agent:claude@harness-impl",
    claimedAt: "2026-05-29T06:40:00.000Z",
    updatedAt: "2026-05-29T07:10:00.000Z"
  },
  {
    id: "samdp20260529",
    code: "BUG-001",
    title: "服务端后台记忆展示字段与客户端 viewer 对齐",
    type: "bug",
    module: "viewer",
    path: "docs/viewer/features/server-admin-memory-display-parity/",
    created: "2026-05-29",
    phases: {
      prd: "done",
      design: "done",
      gate: "locked",
      impl: "locked",
      testcase: "locked",
      testreport: "locked"
    },
    status: "open",
    assignee: null,
    claimedAt: null,
    updatedAt: "2026-05-29T07:10:00.000Z"
  }
];
