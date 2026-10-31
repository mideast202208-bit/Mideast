import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { migrate, migrateV3, migrateV4,migrateV5,migrateV6,migrateV7,migrateV8 } from './migrations.mjs';
import {normalizeSearch} from './international.mjs';

export const LATEST_SCHEMA_VERSION=8;

export function openDatabase(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_versions(version INTEGER PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS users(
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN('admin','manager','agent','accountant')),
      active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(
      hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), csrf TEXT NOT NULL,
      expires_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS contacts(
      id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT UNIQUE, email TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'manual', owner_id TEXT NOT NULL REFERENCES users(id),
      custom TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS leads(
      id TEXT PRIMARY KEY, contact_id TEXT NOT NULL REFERENCES contacts(id), title TEXT NOT NULL,
      stage TEXT NOT NULL DEFAULT 'new' CHECK(stage IN('new','contacted','qualified','proposal','won','lost')),
      value_minor INTEGER NOT NULL DEFAULT 0 CHECK(value_minor>=0),
      owner_id TEXT NOT NULL REFERENCES users(id), custom TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tasks(
      id TEXT PRIMARY KEY, contact_id TEXT REFERENCES contacts(id), lead_id TEXT REFERENCES leads(id),
      title TEXT NOT NULL, due_at TEXT, status TEXT NOT NULL DEFAULT 'open' CHECK(status IN('open','done')),
      owner_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tickets(
      id TEXT PRIMARY KEY, contact_id TEXT NOT NULL REFERENCES contacts(id), title TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN('low','normal','high')),
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN('open','pending','resolved')),
      description TEXT NOT NULL DEFAULT '', owner_id TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS conversations(
      id TEXT PRIMARY KEY, contact_id TEXT NOT NULL UNIQUE REFERENCES contacts(id),
      last_inbound TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS messages(
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
      provider_id TEXT UNIQUE, direction TEXT NOT NULL CHECK(direction IN('in','out')),
      kind TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', media_id TEXT,
      payload TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL, error_code TEXT,
      created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS webhook_events(
      id TEXT PRIMARY KEY, digest TEXT UNIQUE NOT NULL, payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new', attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS provider_statuses(
      id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, status TEXT NOT NULL,
      provider_time TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS studio_fields(
      id TEXT PRIMARY KEY, entity TEXT NOT NULL CHECK(entity IN('contact','lead')),
      field_key TEXT NOT NULL, label TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN('text','number','date','select','boolean')),
      required INTEGER NOT NULL DEFAULT 0, options TEXT NOT NULL DEFAULT '[]',
      UNIQUE(entity,field_key));
    CREATE TABLE IF NOT EXISTS automations(
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      trigger TEXT NOT NULL CHECK(trigger IN('contact.created','lead.created','lead.stage_changed','whatsapp.received','ticket.created')),
      condition_stage TEXT, task_title TEXT NOT NULL, due_hours INTEGER NOT NULL DEFAULT 24 CHECK(due_hours BETWEEN 0 AND 8760),
      active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS automation_runs(
      rule_id TEXT NOT NULL REFERENCES automations(id), event_id TEXT NOT NULL,
      task_id TEXT NOT NULL REFERENCES tasks(id), PRIMARY KEY(rule_id,event_id));
    CREATE TABLE IF NOT EXISTS attachments(
      id TEXT PRIMARY KEY, contact_id TEXT NOT NULL REFERENCES contacts(id), message_id TEXT UNIQUE REFERENCES messages(id),
      name TEXT NOT NULL, mime TEXT NOT NULL, content BLOB NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS invoices(
      id TEXT PRIMARY KEY, number TEXT NOT NULL UNIQUE,
      contact_id TEXT NOT NULL REFERENCES contacts(id), description TEXT NOT NULL,
      amount_minor INTEGER NOT NULL CHECK(amount_minor>0), currency TEXT NOT NULL DEFAULT 'EGP',
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN('draft','issued','void')),
      due_at TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS payments(
      id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES invoices(id),
      amount_minor INTEGER NOT NULL CHECK(amount_minor>0), reference TEXT NOT NULL,
      created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit(
      id TEXT PRIMARY KEY, user_id TEXT, action TEXT NOT NULL, entity TEXT NOT NULL,
      entity_id TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS contact_owner ON contacts(owner_id);
    CREATE INDEX IF NOT EXISTS lead_owner ON leads(owner_id,stage);
    CREATE INDEX IF NOT EXISTS message_conversation ON messages(conversation_id,created_at);
    CREATE INDEX IF NOT EXISTS message_queue ON messages(status,direction);
    CREATE INDEX IF NOT EXISTS session_expiry ON sessions(expires_at);
    INSERT OR IGNORE INTO schema_versions(version) VALUES(1);
  `);
  migrate(db);
  migrateV3(db);
  migrateV4(db);
  migrateV5(db);
  migrateV6(db);
  migrateV7(db);
  migrateV8(db);
  db.function('me_search_normalize',{deterministic:true},normalizeSearch);
  return db;
}

export function transaction(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = action(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
