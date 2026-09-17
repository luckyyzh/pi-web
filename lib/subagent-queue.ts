export type SubagentQueueState = "queued" | "running";

export interface EnqueueOptions {
  /**
   * Optional readiness gate. While it returns false the task stays queued
   * without occupying a concurrency slot; call `wake(parentId)` after the
   * dependency it waits on completes (no polling). If it throws, the task is
   * rejected with that error and later tasks are unaffected.
   */
  ready?: () => boolean;
}

interface QueueItem<T> {
  run: () => Promise<T>;
  ready?: () => boolean;
  onState: (state: SubagentQueueState) => void;
  onCancel?: () => void | Promise<void>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  state: SubagentQueueState;
  cancelled: boolean;
  failed: boolean;
}

type ParentQueue<T> = {
  limit: number;
  active: number;
  items: QueueItem<T>[];
};

export interface EnqueuedSubagent<T> {
  promise: Promise<T>;
  cancel(): boolean;
}

/** FIFO per parent session among ready tasks; separate parents do not block one another. */
export class SubagentQueue<T> {
  private readonly parents = new Map<string, ParentQueue<T>>();

  enqueue(
    parentId: string,
    limit: number,
    run: () => Promise<T>,
    onState: (state: SubagentQueueState) => void,
    onCancel?: () => void | Promise<void>,
    options?: EnqueueOptions,
  ): EnqueuedSubagent<T> {
    const parent = this.parents.get(parentId) ?? { limit: 1, active: 0, items: [] };
    parent.limit = Math.max(1, Math.floor(limit) || 1);
    let item!: QueueItem<T>;
    const promise = new Promise<T>((resolve, reject) => {
      item = { run, ready: options?.ready, onState, onCancel, resolve, reject, state: "queued", cancelled: false, failed: false };
    });
    parent.items.push(item);
    this.parents.set(parentId, parent);
    try {
      onState("queued");
    } catch (error) {
      item.failed = true;
      item.reject(error);
    }
    this.pump(parentId, parent);
    return {
      promise,
      cancel: () => {
        if (item.state !== "queued" || item.cancelled || item.failed) return false;
        item.cancelled = true;
        try {
          Promise.resolve(item.onCancel?.()).then(
            () => item.resolve(undefined as T),
            (error) => item.reject(error),
          );
        } catch (error) {
          item.reject(error);
        }
        this.pump(parentId, parent);
        return true;
      },
    };
  }

  /**
   * Explicitly re-schedule a parent's queue, e.g. after a ready dependency
   * completes. Scheduling only happens on enqueue/cancel/wake/completion;
   * there is no polling.
   */
  wake(parentId: string): void {
    const parent = this.parents.get(parentId);
    if (parent) this.pump(parentId, parent);
  }

  private pump(parentId: string, parent: ParentQueue<T>): void {
    while (parent.active < parent.limit) {
      // Pick the first ready, non-cancelled item in enqueue order; unready
      // items stay queued and never occupy a concurrency slot.
      let startAt = -1;
      for (let i = 0; i < parent.items.length; i += 1) {
        const item = parent.items[i];
        if (item.cancelled || item.failed) {
          parent.items.splice(i, 1);
          i -= 1;
          continue;
        }
        let ready = true;
        try {
          ready = item.ready ? item.ready() : true;
        } catch (error) {
          // A readiness failure rejects only this task; later tasks proceed.
          item.failed = true;
          parent.items.splice(i, 1);
          i -= 1;
          queueMicrotask(() => item.reject(error));
          continue;
        }
        if (ready) {
          startAt = i;
          break;
        }
      }
      if (startAt === -1) {
        if (parent.active === 0 && parent.items.length === 0 && this.parents.get(parentId) === parent) this.parents.delete(parentId);
        return;
      }
      const [item] = parent.items.splice(startAt, 1);
      item.state = "running";
      parent.active += 1;
      // Call run() synchronously (existing callers rely on that timing) but
      // convert a synchronous throw into a handled rejection so it cannot
      // stall the slot or surface as an unhandled rejection.
      let started: Promise<T>;
      try {
        item.onState("running");
        started = Promise.resolve(item.run());
      } catch (error) {
        started = Promise.reject(error);
      }
      void started.then(item.resolve, item.reject).finally(() => {
        parent.active -= 1;
        this.pump(parentId, parent);
      });
    }
  }
}
