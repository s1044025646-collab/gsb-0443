import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";

export const DATA_DIR = process.env.GSB_DATA_DIR ?? path.join(process.cwd(), "data");
export const DB_PATH = process.env.GSB_DB_PATH ?? path.join(DATA_DIR, "grundy.db");

export function openDb(dbPath: string = DB_PATH): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS rule_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rules TEXT NOT NULL,
      duplicates TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_version_id INTEGER NOT NULL REFERENCES rule_versions(id),
      heaps TEXT NOT NULL,
      turn INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS moves (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id INTEGER NOT NULL REFERENCES positions(id),
      rule_version_id INTEGER NOT NULL,
      move_no INTEGER NOT NULL,
      heap_index INTEGER NOT NULL,
      take INTEGER NOT NULL,
      before_heaps TEXT NOT NULL,
      after_heaps TEXT NOT NULL,
      request_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (position_id, request_id)
    );
    CREATE TABLE IF NOT EXISTS analyses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id INTEGER,
      rule_version_id INTEGER NOT NULL,
      heaps TEXT NOT NULL,
      result TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}
