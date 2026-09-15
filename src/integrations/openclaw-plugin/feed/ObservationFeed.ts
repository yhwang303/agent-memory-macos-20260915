import { EmojiAssigner } from './EmojiAssigner.js';
import type { FeedChannel } from './channels/types.js';

export class ObservationFeed {
  private baseUrl: string;
  private feedConfig: { enabled: boolean; channel: string; to: string; botToken?: string };
  private channel: FeedChannel | null = null;
  private abortController: AbortController | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private emojiAssigner = new EmojiAssigner();
  private connected = false;

  constructor(
    baseUrl: string,
    feedConfig: { enabled: boolean; channel: string; to: string; botToken?: string }
  ) {
    this.baseUrl = baseUrl;
    this.feedConfig = feedConfig;
  }

  async connect(): Promise<void> {
    if (!this.feedConfig.enabled) return;
    this.connected = true;
    this.reconnectDelay = 1000;
    this.doConnect();
  }

  private async doConnect(): Promise<void> {
    if (!this.connected) return;

    this.abortController = new AbortController();
    try {
      const res = await fetch(`${this.baseUrl}/stream`, {
        signal: this.abortController.signal,
        headers: { Accept: 'text/event-stream' },
      });

      if (!res.ok || !res.body) {
        throw new Error(`SSE connect failed: ${res.status}`);
      }

      this.reconnectDelay = 1000;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (this.connected) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let eventType = '';
        let eventData = '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            eventData = line.slice(6).trim();
          } else if (line === '' && eventData) {
            await this.handleEvent(eventType, eventData);
            eventType = '';
            eventData = '';
          }
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') return;
    }

    if (this.connected) {
      await new Promise(r => setTimeout(r, this.reconnectDelay));
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
      this.doConnect();
    }
  }

  private async handleEvent(type: string, data: string): Promise<void> {
    if (!this.channel) return;
    try {
      const parsed = JSON.parse(data);
      if (type === 'new_observation') {
        const emoji = this.emojiAssigner.assign(parsed.project || 'default');
        const msg = `${emoji} *New observation* (${parsed.type || 'unknown'})\n${parsed.content || ''}`;
        await this.channel.send(msg);
      } else if (type === 'new_summary') {
        const msg = `📋 *Summary generated* for session \`${parsed.session_id}\``;
        await this.channel.send(msg);
      }
    } catch {
      // Parse error, skip
    }
  }

  disconnect(): void {
    this.connected = false;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.channel = null;
  }

  setChannel(channel: FeedChannel): void {
    this.channel = channel;
  }

  isConnected(): boolean {
    return this.connected;
  }
}
