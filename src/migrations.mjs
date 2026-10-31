export function migrateV8(db){
 if(db.prepare('SELECT 1 FROM schema_versions WHERE version=8').get())return;
 db.exec('BEGIN IMMEDIATE');
 try{db.exec(`
 CREATE TABLE marketing_plans(id TEXT PRIMARY KEY,name TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('active','paused')),local_time TEXT NOT NULL,weekdays TEXT NOT NULL,accounts TEXT NOT NULL,templates TEXT NOT NULL,repeat INTEGER NOT NULL DEFAULT 1,cursor INTEGER NOT NULL DEFAULT 0,next_date TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,last_error TEXT,created_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE TABLE marketing_occurrences(plan_id TEXT NOT NULL REFERENCES marketing_plans(id),revision INTEGER NOT NULL,local_date TEXT NOT NULL,position INTEGER NOT NULL,post_id TEXT NOT NULL UNIQUE REFERENCES marketing_posts(id),PRIMARY KEY(plan_id,revision,local_date));
 CREATE INDEX marketing_plan_posts ON marketing_occurrences(plan_id,position);
 INSERT INTO schema_versions VALUES(8);
 `);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
}
export function migrateV7(db){
 if(db.prepare('SELECT 1 FROM schema_versions WHERE version=7').get())return;
 db.exec('BEGIN IMMEDIATE');
 try{db.exec(`
 CREATE TABLE marketing_assets(id TEXT PRIMARY KEY,name TEXT NOT NULL,mime TEXT NOT NULL,content BLOB NOT NULL,created_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
 CREATE TABLE marketing_posts(id TEXT PRIMARY KEY,title TEXT NOT NULL,body TEXT NOT NULL,campaign TEXT NOT NULL DEFAULT '',asset_id TEXT REFERENCES marketing_assets(id),media_url TEXT NOT NULL DEFAULT '',link_url TEXT NOT NULL DEFAULT '',include_registration INTEGER NOT NULL DEFAULT 0,created_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE TABLE marketing_targets(id TEXT PRIMARY KEY,post_id TEXT NOT NULL REFERENCES marketing_posts(id),account_key TEXT NOT NULL,channel TEXT NOT NULL,account_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN('draft','scheduled','publishing','processing','published','blocked','failed','unknown','cancelled')),scheduled_at TEXT,provider_id TEXT,container_id TEXT,error_code TEXT,attempted_at TEXT,updated_at TEXT NOT NULL,UNIQUE(post_id,account_key));
 CREATE INDEX marketing_due ON marketing_targets(status,scheduled_at);
 CREATE TABLE marketing_account_state(account_key TEXT PRIMARY KEY,identity_hash TEXT NOT NULL,can_read INTEGER NOT NULL DEFAULT 0,can_publish INTEGER NOT NULL DEFAULT 0,permissions TEXT NOT NULL DEFAULT '[]',checked_at TEXT NOT NULL,error_code TEXT);
 CREATE TABLE marketing_feed(account_key TEXT NOT NULL,provider_id TEXT NOT NULL,body TEXT NOT NULL,media_url TEXT NOT NULL DEFAULT '',permalink TEXT NOT NULL DEFAULT '',media_type TEXT NOT NULL DEFAULT '',published_at TEXT NOT NULL,synced_at TEXT NOT NULL,PRIMARY KEY(account_key,provider_id));
 CREATE TABLE marketing_saved_videos(id TEXT PRIMARY KEY,account_key TEXT NOT NULL,title TEXT NOT NULL,url TEXT NOT NULL,embed_url TEXT NOT NULL,created_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,UNIQUE(account_key,url));
 INSERT INTO schema_versions VALUES(7);
 `);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
}
export function migrateV6(db){
 if(db.prepare('SELECT 1 FROM schema_versions WHERE version=6').get())return;
 db.exec('BEGIN IMMEDIATE');
 try{db.exec(`
  CREATE TABLE social_profiles(id TEXT PRIMARY KEY,channel TEXT NOT NULL CHECK(channel IN('facebook','instagram','tiktok','youtube')),name TEXT NOT NULL,url TEXT NOT NULL,account_key TEXT UNIQUE,created_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,UNIQUE(channel,url));
  CREATE TABLE thread_student_context(thread_key TEXT PRIMARY KEY,student_id TEXT NOT NULL REFERENCES app_records(id),linked_by TEXT NOT NULL REFERENCES users(id),updated_at TEXT NOT NULL);
  CREATE TABLE message_student_links(kind TEXT NOT NULL CHECK(kind IN('social','whatsapp')),message_id TEXT NOT NULL,student_id TEXT NOT NULL REFERENCES app_records(id),reference TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(kind,message_id));
  INSERT OR IGNORE INTO app_fields SELECT lower(hex(randomblob(16))),id,'nationality_code','كود الجنسية','text',0,'[]',NULL,20 FROM studio_apps WHERE app_key='me_students';
  INSERT OR IGNORE INTO app_fields SELECT lower(hex(randomblob(16))),id,'phone_country','دولة رقم الهاتف','text',0,'[]',NULL,21 FROM studio_apps WHERE app_key='me_students';
  INSERT INTO schema_versions VALUES(6);
 `);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
}
export function migrateV5(db){
 if(db.prepare('SELECT 1 FROM schema_versions WHERE version=5').get())return;
 db.exec('BEGIN IMMEDIATE');
 try{db.exec(`
  CREATE TABLE communication_accounts(id TEXT PRIMARY KEY,channel TEXT NOT NULL CHECK(channel IN('facebook','instagram','whatsapp')),
   account_id TEXT NOT NULL,name TEXT NOT NULL,configuration_cipher TEXT NOT NULL,intake_user TEXT NOT NULL REFERENCES users(id),
   active INTEGER NOT NULL DEFAULT 0,verified_at TEXT,subscribed INTEGER NOT NULL DEFAULT 0,last_event_at TEXT,created_at TEXT NOT NULL,
   UNIQUE(channel,account_id));
  CREATE TABLE message_accounts(message_id TEXT PRIMARY KEY REFERENCES messages(id),phone_id TEXT NOT NULL);
  CREATE TABLE wa_thread_accounts(conversation_id TEXT NOT NULL REFERENCES conversations(id),phone_id TEXT NOT NULL,last_inbound TEXT,
   PRIMARY KEY(conversation_id,phone_id));
  CREATE TABLE assistant_chats(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),question TEXT NOT NULL,answer TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE communication_thread_state(thread_key TEXT PRIMARY KEY,status TEXT NOT NULL CHECK(status IN('open','done')),updated_at TEXT NOT NULL);
  CREATE TABLE communication_seen(user_id TEXT NOT NULL REFERENCES users(id),thread_key TEXT NOT NULL,seen_at TEXT NOT NULL,PRIMARY KEY(user_id,thread_key));
  INSERT INTO schema_versions VALUES(5);
 `);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
}
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

export function migrateV4(db){
  if(db.prepare('SELECT 1 FROM schema_versions WHERE version=4').get())return;
  db.exec('BEGIN IMMEDIATE');
  try{db.exec(`
    CREATE TABLE intake_registrations(id TEXT PRIMARY KEY,reference TEXT NOT NULL UNIQUE,
      request_key TEXT NOT NULL UNIQUE,fingerprint TEXT NOT NULL,contact_id TEXT NOT NULL REFERENCES contacts(id),
      lead_id TEXT NOT NULL REFERENCES leads(id),student_id TEXT NOT NULL REFERENCES app_records(id),
      admission_id TEXT NOT NULL REFERENCES app_records(id),source TEXT NOT NULL,campaign TEXT NOT NULL DEFAULT '',
      receipt_hash TEXT NOT NULL UNIQUE,receipt_cipher TEXT NOT NULL,file_id TEXT NOT NULL REFERENCES attachments(id),
      delivery_status TEXT NOT NULL,delivery_reason TEXT,message_id TEXT REFERENCES messages(id),created_at TEXT NOT NULL);
    CREATE TABLE channel_accounts(channel TEXT PRIMARY KEY CHECK(channel IN('facebook','instagram')),
      account_id TEXT NOT NULL DEFAULT '',profile_url TEXT NOT NULL DEFAULT '',version TEXT NOT NULL DEFAULT '',
      token_cipher TEXT,secret_cipher TEXT,verify_cipher TEXT,intake_user TEXT REFERENCES users(id),
      active INTEGER NOT NULL DEFAULT 0,verified_at TEXT,last_event_at TEXT,created_at TEXT NOT NULL);
    CREATE TABLE social_threads(id TEXT PRIMARY KEY,channel TEXT NOT NULL REFERENCES channel_accounts(channel),
      account_id TEXT NOT NULL,sender_id TEXT NOT NULL,contact_id TEXT NOT NULL REFERENCES contacts(id),
      last_inbound TEXT,created_at TEXT NOT NULL,UNIQUE(channel,account_id,sender_id));
    CREATE TABLE social_messages(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL REFERENCES social_threads(id),
      provider_id TEXT UNIQUE,direction TEXT NOT NULL CHECK(direction IN('in','out')),
      body TEXT NOT NULL,status TEXT NOT NULL,error_code TEXT,created_at TEXT NOT NULL);
    CREATE TABLE social_events(id TEXT PRIMARY KEY,channel TEXT NOT NULL,digest TEXT NOT NULL UNIQUE,
      payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'new',error_code TEXT,created_at TEXT NOT NULL);
    CREATE INDEX social_queue ON social_events(status,created_at);
    CREATE TABLE integration_keys(id TEXT PRIMARY KEY,name TEXT NOT NULL,key_hash TEXT NOT NULL UNIQUE,
      prefix TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,created_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,last_used_at TEXT);
    CREATE TABLE reply_templates(id TEXT PRIMARY KEY,name TEXT NOT NULL,body TEXT NOT NULL,
      category TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE lab_runs(id TEXT PRIMARY KEY,scenario TEXT NOT NULL,result TEXT NOT NULL,
      created_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
    INSERT INTO schema_versions VALUES(4);
  `);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
}
export function migrateV9(db){
  if(db.prepare('SELECT 1 FROM schema_versions WHERE version=9').get())return;
  db.exec('BEGIN IMMEDIATE');
  try{db.exec(`
    CREATE TABLE customer_email_jobs(
      id TEXT PRIMARY KEY,contact_id TEXT NOT NULL REFERENCES contacts(id),created_by TEXT NOT NULL REFERENCES users(id),
      request_key TEXT NOT NULL,recipient_cipher TEXT NOT NULL,subject TEXT NOT NULL,body TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN('queued','sending','accepted','error','unknown')),
      provider_id TEXT,error_code TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      UNIQUE(created_by,request_key));
    CREATE INDEX customer_email_contact ON customer_email_jobs(contact_id,created_at);
    CREATE INDEX customer_email_queue ON customer_email_jobs(status,created_at);
    INSERT INTO schema_versions VALUES(9);
  `);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
}
