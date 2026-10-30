export function migrate(db) {
  if (db.prepare('SELECT 1 FROM schema_versions WHERE version=2').get()) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      ALTER TABLE studio_fields ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE automations ADD COLUMN conditions TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE automations ADD COLUMN actions TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE automations ADD COLUMN delay_minutes INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE studio_apps(id TEXT PRIMARY KEY, app_key TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
      CREATE TABLE app_fields(id TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES studio_apps(id),
        field_key TEXT NOT NULL, label TEXT NOT NULL, type TEXT NOT NULL
          CHECK(type IN('text','number','date','select','boolean','relation')),
        required INTEGER NOT NULL DEFAULT 0, options TEXT NOT NULL DEFAULT '[]',
        relation_target TEXT, position INTEGER NOT NULL DEFAULT 0, UNIQUE(app_id,field_key));
      CREATE TABLE app_records(id TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES studio_apps(id),
        name TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES users(id),
        data TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX app_record_owner ON app_records(app_id,owner_id);
      CREATE TABLE automation_jobs(id TEXT PRIMARY KEY, rule_id TEXT NOT NULL REFERENCES automations(id),
        event_id TEXT NOT NULL, record TEXT NOT NULL, trigger TEXT NOT NULL,
        due_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', error_code TEXT,
        created_at TEXT NOT NULL, UNIQUE(rule_id,event_id));
      CREATE INDEX automation_due ON automation_jobs(status,due_at);
      CREATE TABLE pipeline_stages(stage_key TEXT PRIMARY KEY, label TEXT NOT NULL, position INTEGER NOT NULL);
      CREATE TABLE wa_templates(id TEXT PRIMARY KEY, name TEXT NOT NULL, language TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, components TEXT NOT NULL DEFAULT '[]',
        synced_at TEXT NOT NULL, UNIQUE(name,language));
      CREATE TABLE media_jobs(message_id TEXT PRIMARY KEY REFERENCES messages(id),
        status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        next_at TEXT NOT NULL, error_code TEXT);
      CREATE TABLE contact_preferences(contact_id TEXT PRIMARY KEY REFERENCES contacts(id),
        whatsapp_opt_in INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
      CREATE TABLE login_factors(user_id TEXT PRIMARY KEY REFERENCES users(id),
        secret_cipher TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, last_counter INTEGER);
      INSERT INTO pipeline_stages VALUES('new','جديد',0),('contacted','تم التواصل',1),
        ('qualified','مؤهل',2),('proposal','عرض سعر',3),('won','تم التعاقد',4),('lost','لم يكتمل',5);
      INSERT INTO schema_versions VALUES(2);
    `);
    db.exec('COMMIT');
  } catch(error) { db.exec('ROLLBACK'); throw error; }
}

export function migrateV3(db){
  if(db.prepare('SELECT 1 FROM schema_versions WHERE version=3').get())return;
  db.exec('BEGIN IMMEDIATE');
  try{db.exec(`
    CREATE TABLE customer_notes(id TEXT PRIMARY KEY,contact_id TEXT NOT NULL REFERENCES contacts(id),
      body TEXT NOT NULL,created_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
    CREATE INDEX customer_note_contact ON customer_notes(contact_id,created_at);
    CREATE TABLE quotes(id TEXT PRIMARY KEY,number TEXT NOT NULL UNIQUE,contact_id TEXT NOT NULL REFERENCES contacts(id),
      description TEXT NOT NULL,amount_minor INTEGER NOT NULL CHECK(amount_minor>0),currency TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN('draft','sent','accepted','rejected','converted')),
      valid_until TEXT,acceptance_reference TEXT,invoice_id TEXT UNIQUE REFERENCES invoices(id),
      created_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE INDEX quote_contact ON quotes(contact_id,created_at);
    INSERT INTO schema_versions VALUES(3);
  `);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
}
