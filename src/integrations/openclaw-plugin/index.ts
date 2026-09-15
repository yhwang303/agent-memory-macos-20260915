import { resolveConfig, type OpenClawPluginConfig } from './config.js';
import { beforeAgentStart } from './hooks/beforeAgentStart.js';
import { beforePromptBuild } from './hooks/beforePromptBuild.js';
import { toolResultPersist } from './hooks/toolResultPersist.js';
import { agentEnd } from './hooks/agentEnd.js';
import { gatewayStart } from './hooks/gatewayStart.js';
import { messageReceived } from './hooks/messageReceived.js';
import { messageSent } from './hooks/messageSent.js';
import { ObservationFeed } from './feed/ObservationFeed.js';
import { buildChannel } from './feed/channels/factory.js';

export interface OpenClawPlugin {
  name: string;
  version: string;
  hooks: Record<string, (...args: any[]) => any>;
  commands: Record<string, (...args: any[]) => Promise<string>>;
  feed: ObservationFeed | null;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createPlugin(userConfig: Partial<OpenClawPluginConfig> = {}): OpenClawPlugin {
  const config = resolveConfig(userConfig);
  const baseUrl = `http://${config.workerHost}:${config.workerPort}`;
  let feed: ObservationFeed | null = null;
  let contextCache: { data: string; expires: number } | null = null;

  async function cachedContextInject(): Promise<string> {
    if (contextCache && Date.now() < contextCache.expires) {
      return contextCache.data;
    }
    try {
      const res = await fetch(`${baseUrl}/api/context/inject?project=${encodeURIComponent(config.project)}&limit=20`);
      const text = await res.text();
      contextCache = { data: text, expires: Date.now() + 60_000 };
      return text;
    } catch {
      return contextCache?.data ?? '';
    }
  }

  const plugin: OpenClawPlugin = {
    name: 'agent-memory',
    version: '1.0.0',
    hooks: {
      before_agent_start: (event: any, ctx: any) => beforeAgentStart(baseUrl, config, { ...(event || {}), ...(ctx || {}) }),
      before_prompt_build: (event: any) => beforePromptBuild(cachedContextInject, config, event),
      tool_result_persist: (event: any, ctx: any) => {
        // sync wrapper: 内部 fire-and-forget，handler 自身返回 void
        toolResultPersist(baseUrl, config, event, ctx);
      },
      agent_end: (event: any, ctx: any) => agentEnd(baseUrl, config, event, ctx),
      gateway_start: () => gatewayStart(baseUrl, config),
      message_received: (event: any, ctx: any) => messageReceived(baseUrl, config, event, ctx),
      message_sent: (event: any, ctx: any) => messageSent(baseUrl, config, event, ctx),
    },
    commands: {},
    feed: null,

    async start() {
      if (config.observationFeed.enabled) {
        feed = new ObservationFeed(baseUrl, config.observationFeed);
        plugin.feed = feed;

        // Bind the configured notification channel so SSE events get
        // forwarded somewhere; without this the feed silently drops
        // every event in handleEvent (channel == null guard).
        const channel = buildChannel(config.observationFeed);
        if (channel) {
          feed.setChannel(channel);
        } else {
          console.warn(
            `[openclaw-plugin] observationFeed.enabled=true but no channel ` +
            `could be built (channel=${config.observationFeed.channel}, ` +
            `to set? ${!!config.observationFeed.to}, ` +
            `botToken set? ${!!config.observationFeed.botToken}); ` +
            `events will be received but not forwarded.`
          );
        }

        feed.connect();
      }
    },

    async stop() {
      if (feed) {
        feed.disconnect();
        feed = null;
        plugin.feed = null;
      }
      contextCache = null;
    },
  };

  return plugin;
}
