// Opens each learner's event store on first use and keeps it open.
import { join } from "node:path";
import { fsrsScheduler, type Scheduler } from "@myelin/core";
import { EventStore } from "./store.js";

export class Stores {
  private open = new Map<string, EventStore>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    readonly dataDir: string,
    readonly scheduler: Scheduler = fsrsScheduler(),
  ) {}

  static pathFor(dataDir: string, userId: string): string {
    if (!/^[a-z0-9_]+$/.test(userId)) throw new Error(`bad user id ${userId}`);
    return join(dataDir, "users", `${userId}.sqlite`);
  }

  get(userId: string): EventStore {
    let s = this.open.get(userId);
    if (!s) {
      s = new EventStore(Stores.pathFor(this.dataDir, userId), this.scheduler);
      this.open.set(userId, s);
    }
    return s;
  }

  /** Polls open stores that have listeners, so events the CLI writes reach open devices. */
  watch(intervalMs = 1000): void {
    this.timer ??= setInterval(() => {
      for (const s of this.open.values()) if (s.listenerCount > 0) s.catchUp();
    }, intervalMs);
    this.timer.unref();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const s of this.open.values()) s.close();
    this.open.clear();
  }
}
