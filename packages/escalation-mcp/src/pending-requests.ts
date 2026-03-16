export interface PendingRequest {
  resolve: (response: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
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
    const pending = this.requests.get(escalationId);
    if (!pending) return false;

    clearTimeout(pending.timer);
    this.requests.delete(escalationId);
    pending.resolve(response);
    return true;
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
