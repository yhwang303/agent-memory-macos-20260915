import type { FeedChannel } from './types.js';
import { TelegramChannel } from './telegram.js';
import { DiscordChannel } from './discord.js';
import { SlackChannel } from './slack.js';

/**
 * Build the concrete notification channel from the user-supplied
 * `observationFeed` config block. Returns null when the channel cannot
 * be constructed (missing required fields), so callers can degrade
 * gracefully without crashing the plugin host.
 */
export function buildChannel(cfg: {
  channel: string;
  to: string;
  botToken?: string;
}): FeedChannel | null {
  if (!cfg.to) return null;

  switch (cfg.channel) {
    case 'telegram': {
      if (!cfg.botToken) return null;
      return new TelegramChannel(cfg.botToken, cfg.to);
    }
    case 'discord':
      return new DiscordChannel(cfg.to);
    case 'slack':
      return new SlackChannel(cfg.to);
    default:
      return null;
  }
}
