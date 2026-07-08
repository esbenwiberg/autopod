export interface PendingRequest {
  resolve: (response: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  detachedReason?: string;
}

export interface PendingResolveResult {
  resolved: boolean;
  detached: boolean;
  detachedReason?: string;
}

export class PendingRequests {
  private requests = new Map<string, PendingRequest>();

  waitForResponse(escalationId: string, timeoutMs: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(escalationId);
        reject(new Error(`Escalation ${escalationId} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.requests.set(escalationId, { resolve, reject, timer });
    });
  }

  resolve(escalationId: string, response: string): boolean {
    return this.resolveWithState(escalationId, response).resolved;
  }

  resolveWithState(escalationId: string, response: string): PendingResolveResult {
    const pending = this.requests.get(escalationId);
    if (!pending) return { resolved: false, detached: false };

    clearTimeout(pending.timer);
    this.requests.delete(escalationId);
    pending.resolve(response);
    return {
      resolved: true,
      detached: pending.detachedReason !== undefined,
      detachedReason: pending.detachedReason,
    };
  }

  reject(escalationId: string, error: Error): boolean {
    const pending = this.requests.get(escalationId);
    if (!pending) return false;

    clearTimeout(pending.timer);
    this.requests.delete(escalationId);
    pending.reject(error);
    return true;
  }

  hasPending(escalationId: string): boolean {
    return this.requests.has(escalationId);
  }

  isDetached(escalationId: string): boolean {
    return this.requests.get(escalationId)?.detachedReason !== undefined;
  }

  markDetached(escalationId: string, reason: string): boolean {
    const pending = this.requests.get(escalationId);
    if (!pending) return false;

    pending.detachedReason = reason;
    return true;
  }

  markAllDetached(reason: string): number {
    let count = 0;
    for (const pending of this.requests.values()) {
      if (pending.detachedReason === undefined) {
        pending.detachedReason = reason;
        count++;
      }
    }
    return count;
  }

  cancelAll(): void {
    for (const [, pending] of this.requests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('All pending requests cancelled'));
    }
    this.requests.clear();
  }

  get size(): number {
    return this.requests.size;
  }
}
