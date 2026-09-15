export interface OpenClawPluginConfig {
  project: string;
  workerHost: string;
  workerPort: number;
  syncMemoryFile: boolean;
  syncMemoryFileExclude: string[];
  /**
   * 是否捕获 channel 收发消息（message_received / message_sent hook）。
   * 默认 true，关闭后 OpenClaw Control UI / 其它 channel 的对话不会落库。
   */
  captureChannel: boolean;
  /**
   * 是否捕获 LLM 调用前后的 prompt / response（llm_input / llm_output hook）。
   * 默认 false，避免把全量 prompt 重复落库。
   */
  captureLLMIO: boolean;
  observationFeed: {
    enabled: boolean;
    channel: 'telegram' | 'discord' | 'slack';
    to: string;
    botToken?: string;
  };
}

export const DEFAULT_CONFIG: OpenClawPluginConfig = {
  project: 'openclaw-gateway',
  workerHost: '127.0.0.1',
  workerPort: 3847,
  syncMemoryFile: true,
  syncMemoryFileExclude: ['debugger'],
  captureChannel: true,
  captureLLMIO: false,
  observationFeed: {
    enabled: false,
    channel: 'telegram',
    to: '',
  },
};

export function resolveConfig(partial: Partial<OpenClawPluginConfig>): OpenClawPluginConfig {
  return {
    ...DEFAULT_CONFIG,
    ...partial,
    observationFeed: { ...DEFAULT_CONFIG.observationFeed, ...partial.observationFeed },
  };
}
