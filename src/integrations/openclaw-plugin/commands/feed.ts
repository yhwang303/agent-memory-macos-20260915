import type { ObservationFeed } from '../feed/ObservationFeed.js';

export function feedCommand(feed: ObservationFeed | null): string {
  if (!feed) return 'Observation feed: DISABLED';
  return `Observation feed: ${feed.isConnected() ? 'CONNECTED' : 'DISCONNECTED'}`;
}
