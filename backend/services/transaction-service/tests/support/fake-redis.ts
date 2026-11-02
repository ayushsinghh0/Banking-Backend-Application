/**
 * Just enough of ioredis for @banksphere/common's Cache: GET, SET (PX, NX), DEL, INCR, EXPIRE, pipelines and
 * the lock-release EVAL, over a Map. `failing` makes every command reject (Redis down).
 */
export class FakeRedis {
  readonly store = new Map<string, string>();
  readonly commands: string[] = [];
  failing = false;

  private run<T>(name: string, fn: () => T): Promise<T> {
    this.commands.push(name);
    return this.failing ? Promise.reject(new Error('redis down')) : Promise.resolve(fn());
  }

  get(key: string) {
    return this.run(`get ${key}`, () => this.store.get(key) ?? null);
  }

  set(key: string, value: string, ...args: unknown[]) {
    return this.run(`set ${key}`, () => {
      if (args.includes('NX') && this.store.has(key)) return null;
      this.store.set(key, value);
      return 'OK';
    });
  }

  del(...keys: string[]) {
    return this.run(`del ${keys.join(' ')}`, () => keys.filter((k) => this.store.delete(k)).length);
  }

  incr(key: string) {
    return this.run(`incr ${key}`, () => this.bump(key));
  }

  eval(_script: string, _keys: number, key: string, token: string) {
    return this.run(`eval ${key}`, () => (this.store.get(key) === token ? Number(this.store.delete(key)) : 0));
  }

  pipeline() {
    const queued: Array<() => unknown> = [];
    const chain = {
      incr: (key: string) => {
        queued.push(() => this.bump(key));
        return chain;
      },
      expire: (_key: string, _seconds: number) => {
        queued.push(() => 1);
        return chain;
      },
      exec: () => this.run('pipeline', () => queued.map((op) => [null, op()])),
    };
    return chain;
  }

  private bump(key: string): number {
    const next = Number(this.store.get(key) ?? 0) + 1;
    this.store.set(key, String(next));
    return next;
  }
}
