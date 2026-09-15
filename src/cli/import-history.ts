/**
 * `agent-memory import-history` CLI subcommand.
 *
 * Surface 1 of the import feature — for service-side users / scripted
 * scenarios where the desktop app isn't running. The desktop app uses
 * the in-process Worker IPC route (stage 7) instead, sharing the same
 * orchestrator under the hood.
 */

import { createInterface } from 'node:readline';
import { discoverAll, runImport } from '../services/import/index.js';
import { resetAdapter } from '../services/import/fingerprints.js';
import type {
  ImportAdapterId,
  ImportOptions,
  ImportProgressSnapshot,
} from '../services/import/types.js';

const SUPPORTED_IDS: ImportAdapterId[] = [
  'claude',
  'cursor-agent',
  'codebuddy-ide',
  'codex-cli',
];

interface ParsedFlags {
  ide?: ImportAdapterId[];
  project?: string;
  sinceMs?: number;
  untilMs?: number;
  concurrency?: number;
  rate?: number;
  maxSessions?: number;
  dryRun?: boolean;
  reset?: ImportAdapterId;
  yes?: boolean;
  verbose?: boolean;
  help?: boolean;
  /** When true, allow importing sessions even if they overlap AgentMemory hook coverage. */
  includeHookOverlap?: boolean;
}

export async function cmdImportHistory(args: string[]): Promise<number> {
  const flags = parseFlags(args);
  if (flags.help) {
    printHelp();
    return 0;
  }

  if (flags.reset) {
    return cmdReset(flags.reset);
  }

  // Discovery + diagnostic table — always runs.
  console.log('agent-memory import-history\n');
  const report = await discoverAll(flags.ide);
  printDiscoveryTable(report);

  if (report.totalFiles === 0) {
    console.log('未发现可导入的对话。');
    return 0;
  }

  if (flags.dryRun) {
    console.log('--dry-run: 不调 AI、不写库，仅扫盘。');
    const r = await runImport({
      ...buildOptions(flags),
      dryRun: true,
    });
    printDryRunSummary(r);
    return 0;
  }

  // Confirmation prompt before paying for AI calls.
  if (!flags.yes) {
    const proceed = await confirm(
      '将开始调用 AI 生成 summary 并写入数据库（受 --max-turns / --rate / --concurrency 控制）。继续？ [y/N] ',
    );
    if (!proceed) {
      console.log('已取消。');
      return 0;
    }
  }

  const opts: ImportOptions = buildOptions(flags);
  const result = await runImport(opts, (snap) => {
    if (flags.verbose) printProgressLine(snap);
  });

  console.log('\n=== 导入完成 ===');
  console.log(
    `  成功 ${result.importedSummaries} · 跳过 ${result.skippedSessions} · 失败 ${result.failedSessions}`,
  );
  console.log(`  耗时 ${(result.durationMs / 1000).toFixed(1)} 秒`);
  for (const a of result.perAdapter) {
    console.log(
      `  · ${a.adapterId.padEnd(15)} 导入 ${a.imported}, 跳过 ${a.skipped}, 失败 ${a.failed}`,
    );
  }
  console.log(
    '\n建议下一步：执行 mcp__agentmem-hybrid__reindex 让向量库吸收新数据。',
  );
  return result.failedSessions > 0 ? 1 : 0;
}

// ─── flag parsing ────────────────────────────────────────────────────────

function parseFlags(args: string[]): ParsedFlags {
  const out: ParsedFlags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = (): string | undefined => args[++i];
    switch (a) {
      case '--help':
      case '-h':
        out.help = true; break;
      case '--ide': {
        const v = next();
        if (!v) break;
        out.ide = v
          .split(',')
          .map((s) => s.trim())
          .filter((s): s is ImportAdapterId => (SUPPORTED_IDS as string[]).includes(s));
        break;
      }
      case '--project':       out.project = next(); break;
      case '--since':         out.sinceMs = parseIso(next()); break;
      case '--until':         out.untilMs = parseIso(next()); break;
      case '--concurrency':   out.concurrency = toInt(next()); break;
      case '--rate':          out.rate = toInt(next()); break;
      case '--max-sessions':  out.maxSessions = toInt(next()); break;
      case '--dry-run':       out.dryRun = true; break;
      case '--reset': {
        const v = next();
        if (v && (SUPPORTED_IDS as string[]).includes(v)) {
          out.reset = v as ImportAdapterId;
        } else {
          console.error(`--reset 需要适配器 id (${SUPPORTED_IDS.join(' / ')})`);
          process.exit(2);
        }
        break;
      }
      case '--yes':
      case '-y':              out.yes = true; break;
      case '--verbose':
      case '-v':              out.verbose = true; break;
      case '--include-hook-overlap':
        out.includeHookOverlap = true; break;
      default:
        console.error(`未识别参数：${a}（用 --help 查看支持的选项）`);
        process.exit(2);
    }
  }
  return out;
}

function buildOptions(flags: ParsedFlags): ImportOptions {
  return {
    adapterIds: flags.ide,
    projectFilter: flags.project,
    sinceMs: flags.sinceMs,
    untilMs: flags.untilMs,
    concurrency: flags.concurrency,
    ratePerMinute: flags.rate,
    maxSessions: flags.maxSessions,
    skipHookOverlap: flags.includeHookOverlap === true ? false : true,
  };
}

function toInt(v: string | undefined): number | undefined {
  if (v == null) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

function parseIso(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

// ─── output helpers ──────────────────────────────────────────────────────

function printDiscoveryTable(
  report: Awaited<ReturnType<typeof discoverAll>>,
): void {
  for (const a of report.adapters) {
    console.log(`${a.adapterId}:`);
    for (const r of a.probedRoots) {
      const mark = r.exists ? '✓' : '✗';
      const tail = r.exists ? '' : ' (not found)';
      console.log(`  ${mark} ${r.path}${tail}`);
    }
    console.log(`  → ${a.files.length} transcript files`);
  }
  console.log(`\n总计 ${report.totalFiles} 个 transcript 文件。\n`);
}

function printDryRunSummary(r: Awaited<ReturnType<typeof runImport>>): void {
  console.log('\n=== Dry-run summary ===');
  console.log(`  总计 sessions: ${r.totalSessions}`);
  console.log(`  跳过（已导入 / hook 已覆盖 / 范围外 / 不实质）: ${r.skippedSessions}`);
  console.log(`  待处理（受 max-sessions 限制）: ${r.totalSessions - r.skippedSessions}`);
  console.log('  Per adapter:');
  for (const a of r.perAdapter) {
    console.log(
      `   · ${a.adapterId.padEnd(15)} skipped ${a.skipped}, would-import ?, failed 0`,
    );
  }
  console.log(
    '\n（预估 AI 调用次数 = 待处理数；实际请用不带 --dry-run 跑一次。）',
  );
}

function printProgressLine(s: ImportProgressSnapshot): void {
  if (s.phase === 'discovering' || s.phase === 'done') return;
  const pct = s.totalSessions
    ? ((s.processedSessions / s.totalSessions) * 100).toFixed(1)
    : '0.0';
  const eta = s.etaSec != null ? ` ETA ${s.etaSec}s` : '';
  process.stderr.write(
    `\r[${s.processedSessions}/${s.totalSessions} ${pct}%]${eta}  ` +
      `imp=${s.importedSummaries} skip=${s.skippedSessions} fail=${s.failedSessions}` +
      `   ${s.currentAdapterId ?? ''}                   `,
  );
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (ans) => {
      rl.close();
      resolve(/^y(es)?$/i.test(ans.trim()));
    });
  });
}

async function cmdReset(adapterId: ImportAdapterId): Promise<number> {
  const { fingerprintsDeleted, summariesDeleted } = resetAdapter(adapterId);
  console.log(
    `已重置 ${adapterId}: 删除 ${fingerprintsDeleted} 条指纹, ${summariesDeleted} 条 summary。`,
  );
  console.log('再次运行 import-history 即可重新导入。');
  return 0;
}

function printHelp(): void {
  console.log(`agent-memory import-history [options]

  把 Claude / Cursor Agent / CodeBuddy IDE 历史 transcript 反向导入为 AgentMemory
  session_summaries（每段 IDE 会话 1 条 summary，与在线 Stop hook 同范式）。

  默认会跳过两类会话:
    1. 已经被本工具导过的（指纹幂等）
    2. AgentMemory 在线期间已经被 hook 写过 summary 的（hook-overlap 去重）
  也就是只会补 "AgentMemory 没记录到的那段历史"。

选项：
  --ide <ids>              适配器 id 逗号分隔（${SUPPORTED_IDS.join(' / ')}）
                           默认：所有 roots() 命中的适配器
  --project <path>         只导入归一化后 cwd 包含此字符串的 session
  --since <ISO>            排除最后一轮早于该时间戳的 session
  --until <ISO>            排除第一轮晚于该时间戳的 session
  --concurrency <N>        AI 并发，默认 2
  --rate <RPM>             AI 每分钟请求上限，默认 30
  --max-sessions <N>       单次运行 session 上限，默认 100
  --include-hook-overlap   也导入 AgentMemory 在线期间已有 hook summary 的会话
                           （默认跳过；勾上后 hook 行 + imported 行会并存）
  --dry-run                只扫盘 + 计数，不调 AI、不写库
  --reset <adapter>        清掉该适配器之前导入的指纹和 summary 后退出
  --yes, -y                跳过确认提示（脚本场景用）
  --verbose, -v            打印每条 session 的处理状态
  --help, -h               显示此帮助
`);
}
