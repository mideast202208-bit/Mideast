import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,existsSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../src/db.mjs';
import {encryptSecret,decryptSecret} from '../src/integration-settings.mjs';
import {createRecoveryBundle,restoreRecoveryBundle,requiresRecoveryKey} from '../src/recovery.mjs';
import {healthStatus} from '../src/storage-health.mjs';
import {startupPreflight} from '../src/startup-preflight.mjs';
import {createApp} from '../src/server.mjs';
import {hashPassword} from '../src/security.mjs';
import {uid,now} from '../src/service.mjs';
import {maybeSnapshot} from '../src/backups.mjs';
const keys=generateKeyPairSync('rsa',{modulusLength:3072,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}}),sourceRoot=resolve('.'),key=Buffer.alloc(32,7);
async function fixture(){const folder=mkdtempSync(join(tmpdir(),'me-recovery-')),path=join(folder,'live.sqlite'),db=openDatabase(path),user=uid();db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?)').run(user,'Synthetic owner','owner@example.test',await hashPassword('Synthetic-recovery-only-2026!'),'admin',1,now());
 db.prepare('INSERT INTO contacts VALUES(?,?,?,?,?,?,?,?,?)').run('contact','Synthetic student '+user,'+201000000001','','synthetic',user,'{}',now(),now());
 db.prepare('INSERT INTO conversations VALUES(?,?,?,?)').run('thread','contact',now(),now());
 db.prepare('INSERT INTO messages(id,conversation_id,provider_id,direction,kind,body,status,created_at) VALUES(?,?,?,?,?,?,?,?)').run('message','thread','synthetic-provider','in','text','Synthetic message','received',now());
 db.prepare('INSERT INTO attachments VALUES(?,?,?,?,?,?,?)').run('file','contact','message','synthetic.pdf','application/pdf',Buffer.from('%PDF-1.7\nSynthetic document'),now());
 db.prepare('INSERT INTO settings VALUES(?,?)').run('wa.accessToken',encryptSecret('synthetic-secret-not-real',key));
 db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run('synthetic-session',user,'csrf','2099-01-01T00:00:00.000Z');writeFileSync(join(folder,'server.key'),key);return {folder,path,db,user};}
test('encrypted streaming recovery preserves records, BLOB files, encrypted integration settings and app sources; sessions are revoked',async()=>{
 const f=await fixture();try{
  const b=await createRecoveryBundle(f.db,key,{directory:join(f.folder,'backups'),sourceRoot,publicKey:keys.publicKey,env:{META_APP_SECRET:'synthetic-env-secret',DB_PATH:f.path}});const bytes=readFileSync(b.path);assert.ok(!bytes.includes(Buffer.from('synthetic-secret-not-real')));assert.ok(!bytes.includes(Buffer.from('Synthetic student')));assert.ok(!bytes.includes(Buffer.from('SQLite format')));assert.ok(!bytes.includes(Buffer.from('synthetic-env-secret')));assert.equal(createHash('sha256').update(bytes).digest('hex'),b.sha256);
  const target=join(f.folder,'restored'),result=await restoreRecoveryBundle(b.path,target,keys.privateKey);assert.equal(result.integrity,'ok');assert.equal(result.foreign_key_errors,0);assert.ok(existsSync(join(target,'app/deploy/Dockerfile')));assert.ok(existsSync(join(target,'app/public/app.js')));assert.deepEqual(readFileSync(join(target,'data/server.key')),key);assert.match(readFileSync(join(target,'.env.recovery'),'utf8'),/RECOVERY_MODE=1/);
  const restored=new DatabaseSync(join(target,'data/mid-east.sqlite'));try{assert.equal(restored.prepare('SELECT COUNT(*) n FROM sessions').get().n,0);assert.equal(restored.prepare('SELECT COUNT(*) n FROM contacts').get().n,1);assert.equal(restored.prepare('SELECT COUNT(*) n FROM messages').get().n,1);assert.deepEqual(Buffer.from(restored.prepare('SELECT content FROM attachments').get().content),Buffer.from('%PDF-1.7\nSynthetic document'));assert.equal(decryptSecret(restored.prepare("SELECT value FROM settings WHERE key='wa.accessToken'").get().value,key),'synthetic-secret-not-real');}finally{restored.close();}
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM sessions').get().n,1);await assert.rejects(()=>restoreRecoveryBundle(b.path,target,keys.privateKey),/TARGET_EXISTS/);
 }finally{f.db.close();rmSync(f.folder,{recursive:true,force:true});}
});
test('wrong private keys and modified authenticated ciphertext cannot create a restored instance',async()=>{
 const f=await fixture();try{const b=await createRecoveryBundle(f.db,key,{directory:join(f.folder,'b'),sourceRoot,publicKey:keys.publicKey});const bytes=readFileSync(b.path);bytes[bytes.length-20]^=1;const bad=join(f.folder,'bad.mebak');writeFileSync(bad,bytes);const target=join(f.folder,'bad-target');await assert.rejects(()=>restoreRecoveryBundle(bad,target,keys.privateKey));assert.equal(existsSync(target),false);const wrong=generateKeyPairSync('rsa',{modulusLength:3072,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});await assert.rejects(()=>restoreRecoveryBundle(b.path,target,wrong.privateKey));assert.equal(existsSync(target),false);}finally{f.db.close();rmSync(f.folder,{recursive:true,force:true});}
});
test('backup failures record safe metadata, back off and never write plaintext when encryption is required',async()=>{
 const f=await fixture();try{const env={BACKUP_INTERVAL_HOURS:'24',BACKUP_DIR:join(f.folder,'b'),BACKUP_REQUIRE_ENCRYPTED:'1'};await assert.rejects(()=>maybeSnapshot(f.db,key,env),/BACKUP_FAILED/);assert.equal(f.db.prepare("SELECT value FROM settings WHERE key='operations.last_backup_error'").get().value,'BACKUP_FAILED');assert.equal(await maybeSnapshot(f.db,key,env),undefined);assert.equal(existsSync(env.BACKUP_DIR),false);}finally{f.db.close();rmSync(f.folder,{recursive:true,force:true});}
});
test('isolated recovery disables both worker loops and direct external integration tests',async()=>{
 const f=await fixture();let calls=0;const app=createApp({db:f.db,secretKey:key,env:{PUBLIC_ORIGIN:'http://127.0.0.1:3000',RECOVERY_MODE:'1',META_PHONE_NUMBER_ID:'123'},transport:async()=>{calls++;throw new Error('must never run')}});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
 try{await app.tick();await app.marketingTick();assert.equal(calls,0);const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'owner@example.test',password:'Synthetic-recovery-only-2026!'})});assert.equal(login.status,200);const token=await login.json(),headers={'Content-Type':'application/json',Cookie:login.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':token.csrf};const probe=await fetch(base+'/api/integrations/whatsapp/test',{method:'POST',headers,body:'{}'});assert.ok([409,500].includes(probe.status));assert.equal(calls,0);const health=await fetch(base+'/health');assert.equal(health.status,200);assert.equal((await health.json()).mode,'recovery');}finally{await new Promise(r=>app.server.close(r));f.db.close();rmSync(f.folder,{recursive:true,force:true});}
});
test('health detects unavailable databases and full disk without returning sensitive paths',async()=>{
 const f=await fixture();try{const r=healthStatus(f.db,{}, {statfs:()=>({bavail:0,bsize:4096,blocks:100})});assert.equal(r.code,503);assert.equal(r.body.reason,'STORAGE_LOW');assert.ok(!JSON.stringify(r.body).includes(f.path));f.db.close();assert.equal(healthStatus(f.db).code,503);}finally{try{f.db.close();}catch{}rmSync(f.folder,{recursive:true,force:true});}
});
test('preflight does not migrate or rewrite an existing database and refuses a missing encryption key',async()=>{
 const f=await fixture();try{const before=f.db.prepare('SELECT COUNT(*) n FROM messages').get().n;const result=await startupPreflight({DB_PATH:f.path,KEY_PATH:join(f.folder,'server.key')});assert.equal(result.migration_pending,false);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM messages').get().n,before);await assert.rejects(()=>startupPreflight({DB_PATH:f.path,KEY_PATH:join(f.folder,'missing.key')}),/RECOVERY_KEY_MISSING/);assert.equal(requiresRecoveryKey(f.db),true);}finally{f.db.close();rmSync(f.folder,{recursive:true,force:true});}
});
test('machine backup scope never grants CRM access, and storage diagnostics remain owner-only',async()=>{
 const f=await fixture(),agent=uid();f.db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?)').run(agent,'Synthetic agent','agent@example.test',f.db.prepare('SELECT password FROM users WHERE id=?').get(f.user).password,'agent',1,now());
 const machine='synthetic-backup-export-credential-32-only',app=createApp({db:f.db,secretKey:key,env:{PUBLIC_ORIGIN:'http://127.0.0.1:3000',BACKUP_EXPORT_TOKEN:machine,BACKUP_PUBLIC_KEY:keys.publicKey,BACKUP_DIR:join(f.folder,'backups'),BACKUP_SOURCE_ROOT:sourceRoot}});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
 try{
  assert.equal((await fetch(base+'/internal/backup/export',{method:'POST'})).status,401);assert.equal((await fetch(base+'/api/data',{headers:{Authorization:'Bearer '+machine}})).status,401);
  const login=async email=>{const r=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password:'Synthetic-recovery-only-2026!'})});const b=await r.json();return {Cookie:r.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':b.csrf};};
  const owner=await login('owner@example.test'),other=await login('agent@example.test');assert.equal((await fetch(base+'/api/operations/storage',{headers:owner})).status,200);assert.equal((await fetch(base+'/api/operations/storage',{headers:other})).status,403);assert.equal((await fetch(base+'/api/export',{headers:other})).status,403);assert.equal((await fetch(base+'/api/files/file',{headers:other})).status,404);
  const r=await fetch(base+'/internal/backup/export',{method:'POST',headers:{Authorization:'Bearer '+machine}});assert.equal(r.status,200);const bytes=Buffer.from(await r.arrayBuffer());assert.equal(createHash('sha256').update(bytes).digest('hex'),r.headers.get('x-backup-sha256'));assert.ok(!bytes.includes(Buffer.from('Synthetic student')));
  const ack=await fetch(base+'/internal/backup/receipt',{method:'POST',headers:{Authorization:'Bearer '+machine,'Content-Type':'application/json'},body:JSON.stringify({sha256:r.headers.get('x-backup-sha256'),file_id:'synthetic-drive-file'})});assert.equal(ack.status,200);assert.ok(f.db.prepare("SELECT value FROM settings WHERE key='operations.last_offsite_at'").get().value);
 }finally{await new Promise(r=>app.server.close(r));f.db.close();rmSync(f.folder,{recursive:true,force:true});}
});
test('a new app instance reopens persistent data without an empty database or lost file',async()=>{
 const f=await fixture();f.db.close();let db=openDatabase(f.path),app=createApp({db,secretKey:key,env:{RECOVERY_MODE:'1',PUBLIC_ORIGIN:'http://127.0.0.1:3000'}});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));await new Promise(r=>app.server.close(r));db.close();
 db=openDatabase(f.path);try{assert.equal(db.prepare('SELECT COUNT(*) n FROM contacts').get().n,1);assert.equal(db.prepare('SELECT COUNT(*) n FROM attachments').get().n,1);assert.equal(decryptSecret(db.prepare("SELECT value FROM settings WHERE key='wa.accessToken'").get().value,key),'synthetic-secret-not-real');assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');}finally{db.close();rmSync(f.folder,{recursive:true,force:true});}
});
