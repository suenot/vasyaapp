export type TranslationResult = { text: string; error?: never } | { text?: never; error: string };
export type TranslationListener = (result: TranslationResult) => void;
interface Job { key: string; run: () => Promise<string>; listeners: Set<TranslationListener>; started: boolean }

/** Viewport subscriptions own queued work; running IPC cannot be aborted, so stale listeners detach. */
export class TranslationScheduler {
  private jobs = new Map<string, Job>();
  private cache = new Map<string, TranslationResult>();
  private active = 0;
  private bytes = 0;
  private concurrency: number;
  private maxQueue: number;
  private maxEntries: number;
  private maxBytes: number;
  constructor(concurrency = 2, maxQueue = 32, maxEntries = 128, maxBytes = 1_048_576) {
    this.concurrency = concurrency; this.maxQueue = maxQueue; this.maxEntries = maxEntries; this.maxBytes = maxBytes;
  }
  subscribe(key: string, run: () => Promise<string>, listener: TranslationListener): () => void {
    const cached = this.cache.get(key);
    if (cached) { this.cache.delete(key); this.cache.set(key, cached); listener(cached); return () => {}; }
    let job = this.jobs.get(key);
    if (!job) {
      if (this.jobs.size >= this.maxQueue) { listener({ error: 'Translation queue is busy. Please retry.' }); return () => {}; }
      job = { key, run, listeners: new Set(), started: false }; this.jobs.set(key, job);
    }
    job.listeners.add(listener); this.pump();
    return () => { job!.listeners.delete(listener); if (!job!.started && job!.listeners.size === 0) this.jobs.delete(key); };
  }
  forget(key: string): void {
    const old = this.cache.get(key);
    if (old) { this.bytes -= this.weight(key, old); this.cache.delete(key); }
  }
  private weight(key: string, value: TranslationResult) { return (key.length + (value.text ?? value.error).length) * 2; }
  private pump(): void {
    for (const job of this.jobs.values()) {
      if (this.active >= this.concurrency) break;
      if (job.started || job.listeners.size === 0) continue;
      job.started = true; this.active++;
      Promise.resolve().then(job.run).then(text => {
        if (!text.trim()) throw new Error('Translation returned empty text.');
        return { text } as TranslationResult;
      }).catch(error => ({ error: error instanceof Error ? error.message : String(error) } as TranslationResult)).then(result => {
        this.jobs.delete(job.key); this.active--;
        if (job.listeners.size) {
          this.cache.set(job.key, result); this.bytes += this.weight(job.key, result);
          while (this.cache.size > this.maxEntries || this.bytes > this.maxBytes) {
            const oldest = this.cache.keys().next().value as string | undefined;
            if (oldest === undefined) break; this.forget(oldest);
          }
          for (const listener of job.listeners) listener(result);
        }
        this.pump();
      });
    }
  }
}

export async function prepareOutgoingText(text: string, target: string | null, translate: (text: string, target: string) => Promise<string>, backendUnchanged: () => boolean): Promise<string> {
  const result = target && text.trim() ? await translate(text, target) : text;
  if (text.trim() && !result.trim()) throw new Error('Translation returned empty text. Message was not sent.');
  if (!backendUnchanged()) throw new Error('Translation settings or connection changed. Message was not sent; retry in the intended chat.');
  return result;
}
export function canClearSentDraft(sent: { context: string; revision: number }, current: { context: string; revision: number }): boolean {
  return sent.context === current.context && sent.revision === current.revision;
}
