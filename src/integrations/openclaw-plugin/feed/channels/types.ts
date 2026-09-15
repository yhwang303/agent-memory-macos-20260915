export interface FeedChannel {
  id: string;
  send(message: string): Promise<void>;
}
