import { useCallback } from 'react';
import { invoke } from '../transport';
import { useDownloadStore, DownloadItemInfo } from '../store/downloadStore';

interface QueueItem {
  accountId: string;
  chatId: number;
  messageId: number;
  resolve: (value: any) => void;
  reject: (reason: any) => void;
}

const MAX_CONCURRENT = 3;

class MediaDownloadQueue {
  private queue: QueueItem[] = [];
  private activeItems: QueueItem[] = [];
  private completed = 0;
  private failed = 0;
  private seenKeys = new Set<string>();
  private resultCache = new Map<string, any>();
  private pendingPromises = new Map<string, Promise<any>>();

  /** Move all queued items for chatId to front of queue */
  prioritize(chatId: number) {
    const prioritized = this.queue.filter(item => item.chatId === chatId);
    const rest = this.queue.filter(item => item.chatId !== chatId);
    this.queue = [...prioritized, ...rest];
    this.syncStore();
  }

  /** Remove queued (not active) items that are NOT for the given chatId */
  trimNonPriority(activeChatId: number, keepMax = 10) {
    const forChat = this.queue.filter(item => item.chatId === activeChatId);
    const other = this.queue.filter(item => item.chatId !== activeChatId);
    const trimmed = other.slice(0, keepMax);
    for (const item of other.slice(keepMax)) {
      this.seenKeys.delete(`${item.chatId}_${item.messageId}`);
      item.reject('cancelled');
    }
    this.queue = [...forChat, ...trimmed];
    this.syncStore();
  }

  enqueue(item: Omit<QueueItem, 'resolve' | 'reject'>, opts?: { front?: boolean }): Promise<any> {
    const key = `${item.chatId}_${item.messageId}`;
    // Return cached result if a previous download succeeded
    if (this.resultCache.has(key)) {
      return Promise.resolve(this.resultCache.get(key));
    }
    // Return in-progress promise if download is underway (component remounted);
    // a user-initiated request still bumps the queued item to the front.
    if (this.pendingPromises.has(key)) {
      if (opts?.front) {
        const idx = this.queue.findIndex(i => i.chatId === item.chatId && i.messageId === item.messageId);
        if (idx > 0) {
          const [qi] = this.queue.splice(idx, 1);
          this.queue.unshift(qi);
          this.syncStore();
        }
      }
      return this.pendingPromises.get(key)!;
    }
    if (this.seenKeys.has(key)) {
      return Promise.resolve(null);
    }
    this.seenKeys.add(key);

    const promise = new Promise((resolve, reject) => {
      const qi = { ...item, resolve, reject };
      // User-initiated downloads jump ahead of queued viewport auto-downloads.
      if (opts?.front) this.queue.unshift(qi);
      else this.queue.push(qi);
      this.syncStore();
      this.processNext();
    });
    this.pendingPromises.set(key, promise);
    promise.finally(() => this.pendingPromises.delete(key));
    return promise;
  }

  /** Drop a download that is still waiting in the queue (scrolled out of view).
      Active downloads are left to finish — they land in the result cache. */
  cancelQueued(chatId: number, messageId: number): boolean {
    const idx = this.queue.findIndex(i => i.chatId === chatId && i.messageId === messageId);
    if (idx === -1) return false;
    const [item] = this.queue.splice(idx, 1);
    this.seenKeys.delete(`${chatId}_${messageId}`);
    item.reject('cancelled');
    this.syncStore();
    return true;
  }

  getStats() {
    return {
      queued: this.queue.length,
      active: this.activeItems.length,
      completed: this.completed,
      failed: this.failed,
    };
  }

  private async processNext() {
    if (this.activeItems.length >= MAX_CONCURRENT || this.queue.length === 0) return;

    const item = this.queue.shift()!;
    this.activeItems.push(item);
    this.syncStore();

    try {
      const result = await invoke('download_media', {
        accountId: item.accountId,
        chatId: item.chatId,
        messageId: item.messageId,
      });
      this.completed++;
      // Cache successful result so remounted components get it instantly
      const key = `${item.chatId}_${item.messageId}`;
      if (result) this.resultCache.set(key, result);
      item.resolve(result);
    } catch (error) {
      // Allow retry on failure
      const key = `${item.chatId}_${item.messageId}`;
      this.seenKeys.delete(key);
      this.failed++;
      item.reject(error);
    } finally {
      this.activeItems = this.activeItems.filter(i => i !== item);
      this.syncStore();
      this.processNext();
    }
  }

  private syncStore() {
    const toInfo = (item: QueueItem, status: DownloadItemInfo['status']): DownloadItemInfo => ({
      chatId: item.chatId,
      messageId: item.messageId,
      status,
    });

    useDownloadStore.getState().update({
      queued: this.queue.length,
      active: this.activeItems.length,
      completed: this.completed,
      failed: this.failed,
      activeItems: this.activeItems.map(i => toInfo(i, 'active')),
      queuedItems: this.queue.slice(0, 20).map(i => toInfo(i, 'queued')),
    });
  }
}

// Singleton queue
const globalQueue = new MediaDownloadQueue();

export function useMediaQueue() {
  return useCallback(
    (accountId: string, chatId: number, messageId: number, opts?: { front?: boolean }) =>
      globalQueue.enqueue({ accountId, chatId, messageId }, opts),
    []
  );
}

/** Cancel a download that hasn't started yet (e.g. its message left the viewport). */
export function cancelQueuedDownload(chatId: number, messageId: number): boolean {
  return globalQueue.cancelQueued(chatId, messageId);
}

/** Call when user switches to a new chat -- prioritizes that chat's downloads */
export function prioritizeChat(chatId: number) {
  globalQueue.prioritize(chatId);
  globalQueue.trimNonPriority(chatId);
}

export function getQueueStats() {
  return globalQueue.getStats();
}
