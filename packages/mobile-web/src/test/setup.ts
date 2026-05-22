class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function installLocalStorage(target: Window & typeof globalThis): void {
  if (typeof target.localStorage?.getItem === 'function') return;

  Object.defineProperty(target, 'localStorage', {
    configurable: true,
    value: new MemoryStorage(),
  });
}

installLocalStorage(window);

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
