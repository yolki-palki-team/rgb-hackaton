import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

export class LocalStore {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path),{recursive:true,mode:0o700});
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS local_records (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    if (path !== ':memory:') chmodSync(path,0o600);
  }
  get<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM local_records WHERE key=?').get(key) as {value:string}|undefined;
    return row ? JSON.parse(row.value) as T : null;
  }
  set(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO local_records(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));
  }
  close() { this.db.close(); }
}
