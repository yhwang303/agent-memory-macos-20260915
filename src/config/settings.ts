import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface RagSettings {
  enabled: boolean;
  embedding_model: string;
  fallback_mode: 'sqlite-only' | 'disabled';
  hybrid_weights: { sqlite: number; chroma: number };
  rrf_k: number;
}

export interface SelfEvolvePluginSettings {
  enabled: boolean;
  reviewMode: 'auto' | 'manual' | 'quality_gate';
  qualityGateThreshold: number;
  targetPlatforms: string[];
  maxContextRules: number;
  criticOnGenerate: boolean;
  aiModel?: string;
}

export interface InjectorPluginSettings {
  enabled: boolean;
}

export interface PluginsSettings {
  selfEvolve: SelfEvolvePluginSettings;
  injector: InjectorPluginSettings;
}

export interface AgentMemorySettings {
  rag: RagSettings;
  plugins: PluginsSettings;
}

export const DEFAULT_SETTINGS: AgentMemorySettings = {
  rag: {
    enabled: true,
    embedding_model: 'bge-m3',
    fallback_mode: 'sqlite-only',
    hybrid_weights: { sqlite: 0.4, chroma: 0.6 },
    rrf_k: 60,
  },
  plugins: {
    selfEvolve: {
      enabled: false,
      reviewMode: 'manual',
      qualityGateThreshold: 70,
      targetPlatforms: ['claudecode'],
      maxContextRules: 20,
      criticOnGenerate: true,
    },
    injector: {
      enabled: false,
    },
  },
};

function deepMerge<T>(base: T, override: Partial<T>): T {
  if (override == null) return base;
  if (typeof base !== 'object' || typeof override !== 'object') {
    return (override as any) ?? base;
  }
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...base };
  for (const key of Object.keys(override as any)) {
    const bv = (base as any)?.[key];
    const ov = (override as any)[key];
    if (bv && typeof bv === 'object' && !Array.isArray(bv) && ov && typeof ov === 'object') {
      out[key] = deepMerge(bv, ov);
    } else {
      out[key] = ov;
    }
  }
  return out;
}

function defaultConfigDir(): string {
  return join(homedir(), '.config', 'agent-memory');
}

export function loadSettings(opts?: { configDir?: string }): AgentMemorySettings {
  const dir = opts?.configDir ?? defaultConfigDir();
  const path = join(dir, 'settings.json');
  if (!existsSync(path)) return DEFAULT_SETTINGS;
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    return deepMerge(DEFAULT_SETTINGS, parsed);
  } catch {
    return DEFAULT_SETTINGS;
  }
}
