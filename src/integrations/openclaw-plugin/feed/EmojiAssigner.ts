const EMOJI_POOL = ['🤖', '🧠', '💡', '🔧', '📝', '🎯', '⚡', '🌟', '🔍', '📊', '🛠️', '🎨'];

export class EmojiAssigner {
  private assignments = new Map<string, string>();

  assign(agentId: string): string {
    if (this.assignments.has(agentId)) {
      return this.assignments.get(agentId)!;
    }
    let hash = 0;
    for (let i = 0; i < agentId.length; i++) {
      hash = ((hash << 5) - hash + agentId.charCodeAt(i)) | 0;
    }
    const emoji = EMOJI_POOL[Math.abs(hash) % EMOJI_POOL.length];
    this.assignments.set(agentId, emoji);
    return emoji;
  }

  reset(): void {
    this.assignments.clear();
  }
}
