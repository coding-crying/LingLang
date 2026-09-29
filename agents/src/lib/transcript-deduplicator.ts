/** Call only after transcript validation, immediately before committing history. */
export class TranscriptDeduplicator {
  private readonly seen = new Set<string>();
  private lastText = '';
  private lastAt = -Infinity;

  accept(text: string, itemId?: string, now = Date.now()): boolean {
    if (itemId) {
      if (this.seen.has(itemId)) return false;
      this.seen.add(itemId);
      // Bound memory for long sessions. Distinct utterance IDs always win over text.
      if (this.seen.size > 256) this.seen.delete(this.seen.values().next().value!);
    } else if (text === this.lastText && now >= this.lastAt && now - this.lastAt <= 500) {
      return false;
    }
    this.lastText = text;
    this.lastAt = now;
    return true;
  }
}
