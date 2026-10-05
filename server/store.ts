import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/** One serialized transaction queue owns all writes in this local demo process. */
export class JsonStore<T extends object> {
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(private readonly filename: string, private state: T) {}

  static async open<T extends object>(filename: string, initial: T): Promise<JsonStore<T>> {
    let state = initial;
    try {
      state = JSON.parse(await readFile(filename, 'utf8')) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await mkdir(dirname(filename), { recursive: true });
    return new JsonStore(filename, state);
  }

  transact<R>(work: (draft: T) => { value: R; changed: boolean }): Promise<R> {
    const operation = this.queue.then(async () => {
      const draft = structuredClone(this.state);
      const { value, changed } = work(draft);
      if (changed) {
        const temporary = `${this.filename}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify(draft), { encoding: 'utf8', mode: 0o600 });
          await rename(temporary, this.filename);
        } catch (error) {
          await rm(temporary, { force: true }).catch(() => undefined);
          throw error;
        }
        // Publish only after the complete settlement has been persisted.
        this.state = draft;
      }
      return value;
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
}
