/**
 * Hybrid Vector Search 服务模块
 *
 * 这个目录下的代码源自独立项目 agentmem-hybrid-mcp,在 v0.1.0 之后整合进 AgentMemory 主仓库,
 * 让 hybrid 检索能力随 .exe 一起分发,用户安装后即可使用。
 *
 * Upstream commit: agentmem-hybrid-mcp main HEAD as of 2026-06-02
 *   (D:\agentmem-hybrid-mcp,无 git 仓库;参考 PLAN.md / REPORT.md)
 *
 * 模块组成:
 *   - EmbeddingService.ts  - BGE-zh ONNX 模型加载与推理
 *   - VectorStore.ts       - sqlite-vec 向量库封装
 *   - HybridIndexer.ts     - 全量重建 + 增量入队 (监听 EventBus)
 *   - ScoreFusion.ts       - basic-memory 风格 score-based fusion (现行算法)
 *   - RrfFusion.ts         - Cormack 2009 加权 RRF 融合 (历史实现,保留以备评测对比)
 *   - HybridSearchService.ts - 主入口,并行 sqlite + vector + score fusion
 *
 * 集成方式:
 *   WorkerService 在 start() 末尾初始化这套服务,挂上 EventBus 'new_observation'
 *   / 'new_summary' 监听器实现增量向量化,并扩展 /api/search 路由处理 mode=
 *   hybrid|vector,新增 /api/vector/{status,reindex} 端点。
 *
 * 验收依赖:
 *   - better-sqlite3 v12.6.2 (与 AgentMemory 现有版本一致)
 *   - sqlite-vec ^0.1.6 (loadable extension,不参与 electron-rebuild)
 *   - @xenova/transformers ^2.17.2 (onnxruntime-web,无 native binding)
 *
 * 模型文件:
 *   ONNX 模型 (~100MB) 通过 desktop/package.json 的 extraResources 预打进 .exe,
 *   运行时 EmbeddingService 优先从 process.resourcesPath/models 加载。
 */

export { EmbeddingService } from './EmbeddingService.js';
export type { ModelStatus, ModelStatusReport, EmbeddingServiceOptions } from './EmbeddingService.js';

export { VectorStore } from './VectorStore.js';
export type { DocKind, UpsertItem, QueryFilter, QueryHit } from './VectorStore.js';

export { HybridIndexer } from './HybridIndexer.js';
export type { IndexerStatus, IndexerProgress, ReindexOptions, HybridIndexerDeps } from './HybridIndexer.js';

export { rrfFuse } from './RrfFusion.js';
export type { RankItem, RankedList, FusedItem, RrfOptions } from './RrfFusion.js';

export { scoreFuse, distanceToSimilarity, FUSION_BONUS, FTS_GATE_THRESHOLD } from './ScoreFusion.js';
export type { FtsScoreItem, VectorScoreItem, ScoreFusedItem, ScoreFusionOptions } from './ScoreFusion.js';

export { HybridSearchService } from './HybridSearchService.js';
export type { HybridSearchInput, HybridSearchOutput, HybridSearchDeps } from './HybridSearchService.js';
