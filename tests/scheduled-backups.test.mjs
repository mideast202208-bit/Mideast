import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,createHash} from 'node:crypto';
import {mkdtempSync,rmSync,readdirSync,readFileSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {openDatabase} from '../src/db.mjs';
import {runScheduledBackups,maybeOffsiteBackup,offsiteConfiguration} from '../src/scheduled-backups.mjs';
import {readiness} from '../src/operations.mjs';
import {restoreRecoveryBundle} from '../src/recovery.mjs';

const keys=generateKeyPairSync('rsa',{modulusLength:3072,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
const get=(db,k)=>db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value;
const set=(db,k,v)=>db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k,String(v));
const past=hours=>new Date(Date.now()-hours*3600000).toISOString();
function fixture(){
 const folder=mkdtempSync(join(tmpdir(),'me-daily-drive-')),db=openDatabase(':memory:');
 db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?)').run('qa-owner','Synthetic owner','owner@example.test','synthetic-password-hash','admin',1,new Date().toISOString());
 const env={NODE_ENV:'production',BACKUP_INTERVAL_HOURS:'24',BACKUP_OFFSITE_ENABLED:'1',BACKUP_REQUIRE_ENCRYPTED:'1',BACKUP_PUBLIC_KEY:keys.publicKey,BACKUP_SOURCE_ROOT:resolve('.'),BACKUP_DIR:folder,DRIVE_CLIENT_ID:'synthetic-client',DRIVE_CLIENT_SECRET:'synthetic-secret',DRIVE_REFRESH_TOKEN:'synthetic-refresh',DRIVE_FOLDER_ID:'synthetic-folder'};
 return {db,env,folder,close(){db.close();rmSync(folder,{recursive:true,force:true});}};
}
function provider(){
 const uploads=[],metadata=[];let fail=false,calls=0;
 const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
 return {uploads,metadata,get calls(){return calls;},set failUpload(v){fail=v;},transport:async(url,options={})=>{
  calls++;
  if(url==='https://oauth2.googleapis.com/token')return json({access_token:'synthetic-short-lived'});
  if(url.includes('/drive/v3/files/synthetic-folder'))return json({mimeType:'application/vnd.google-apps.folder',trashed:false,capabilities:{canAddChildren:true},permissions:[{type:'user',role:'owner'}]});
  if(options.method==='POST'&&url.includes('uploadType=resumable')){metadata.push(JSON.parse(options.body));return new Response('',{headers:{location:'https://www.googleapis.com/upload/drive/v3/files?upload_id=synthetic'}});}
  if(options.method==='PUT'){
   if(fail)return json({},503);
   const chunks=[];for await(const b of options.body)chunks.push(b);const bytes=Buffer.concat(chunks);uploads.push(bytes);
   return json({id:'synthetic-file-'+uploads.length,size:String(bytes.length),md5Checksum:createHash('md5').update(bytes).digest('hex')});
  }
  throw new Error('Unexpected request');
 }};
}

test('a scheduled tick creates a new encrypted backup, uploads it, checks it and skips duplicate ticks',async()=>{
 const f=fixture(),p=provider();try{
  const result=await runScheduledBackups(f.db,Buffer.alloc(32,8),f.env,p.transport);
  assert.equal(result.provider,'google_drive');assert.equal(result.file_id,'synthetic-file-1');assert.equal(p.uploads.length,1);
  const magic=Buffer.from('MECRM-BACKUP-1\n');assert(p.uploads[0].subarray(0,magic.length).equals(magic));
  assert.equal(createHash('sha256').update(p.uploads[0]).digest('hex'),get(f.db,'operations.last_offsite_sha256'));
  assert.match(p.metadata[0].description,new RegExp('SHA256: '+result.sha256));
  assert.equal(readiness(f.db).backups.offsite_status,'ok');
  assert.equal(await runScheduledBackups(f.db,Buffer.alloc(32,8),f.env,p.transport),undefined);
  assert.equal(p.uploads.length,1);assert.equal(readdirSync(f.folder).filter(x=>x.endsWith('.mebak')).length,1);
  const tomorrow=25;set(f.db,'operations.last_backup_at',past(tomorrow));set(f.db,'operations.last_backup_attempt_at',past(tomorrow));set(f.db,'operations.last_offsite_at',past(tomorrow));set(f.db,'operations.last_offsite_attempt_at',past(tomorrow));
  set(f.db,'synthetic.next_day_marker','new synthetic data');
  const second=await runScheduledBackups(f.db,Buffer.alloc(32,8),f.env,p.transport);
  assert.equal(second.file_id,'synthetic-file-2');assert.notEqual(second.sha256,result.sha256);assert.notEqual(p.metadata[1].name,p.metadata[0].name);
  const restored=join(f.folder,'restored-next-day');await restoreRecoveryBundle(join(f.folder,get(f.db,'operations.last_backup_filename')),restored,keys.privateKey);
  const restoredDb=openDatabase(join(restored,'data/mid-east.sqlite'));try{assert.equal(get(restoredDb,'synthetic.next_day_marker'),'new synthetic data');}finally{restoredDb.close();}
 }finally{f.close();}
});
test('a failed upload keeps its local encrypted backup and retries it after an hour, without a false success',async()=>{
 const f=fixture(),p=provider();try{
  p.failUpload=true;await assert.rejects(()=>runScheduledBackups(f.db,Buffer.alloc(32,8),f.env,p.transport),/DRIVE_UPLOAD_FAILED/);
  const name=get(f.db,'operations.last_backup_filename'),original=readFileSync(join(f.folder,name));
  assert.equal(get(f.db,'operations.last_offsite_at'),undefined);assert.equal(readiness(f.db).backups.offsite_status,'error');
  const calls=p.calls;await runScheduledBackups(f.db,Buffer.alloc(32,8),f.env,p.transport);assert.equal(p.calls,calls);
  p.failUpload=false;set(f.db,'operations.last_offsite_attempt_at',past(2));await runScheduledBackups(f.db,Buffer.alloc(32,8),f.env,p.transport);
  assert.equal(get(f.db,'operations.last_backup_filename'),name);assert.deepEqual(p.uploads[0],original);assert.equal(get(f.db,'operations.last_offsite_error'),'');
 }finally{f.close();}
});
test('missing OAuth setup creates only the encrypted local backup and reports configuration failure without requesting tokens',async()=>{
 const f=fixture(),p=provider();try{
  delete f.env.DRIVE_REFRESH_TOKEN;
  await assert.rejects(()=>runScheduledBackups(f.db,Buffer.alloc(32,8),f.env,p.transport),/DRIVE_OAUTH_CONFIGURATION_REQUIRED/);
  assert.equal(p.calls,0);assert.ok(get(f.db,'operations.last_backup_at'));assert.equal(get(f.db,'operations.last_offsite_at'),undefined);
  assert.equal(offsiteConfiguration(f.env).configured,false);
  assert(!JSON.stringify(offsiteConfiguration(f.env)).includes(f.env.DRIVE_CLIENT_SECRET));
 }finally{f.close();}
});
test('overlapping ticks share one upload; recovery mode performs no backup or network operation',async()=>{
 const f=fixture(),p=provider();try{
  await Promise.all([runScheduledBackups(f.db,Buffer.alloc(32,8),f.env,p.transport),runScheduledBackups(f.db,Buffer.alloc(32,8),f.env,p.transport)]);
  assert.equal(p.uploads.length,1);const calls=p.calls;
  await runScheduledBackups(f.db,Buffer.alloc(32,8),{...f.env,RECOVERY_MODE:'1'},p.transport);assert.equal(p.calls,calls);
 }finally{f.close();}
});
test('unremembered older local backups produce a fresh encrypted seed for upload',async()=>{
 const f=fixture(),p=provider();try{
  set(f.db,'operations.last_backup_at',new Date().toISOString());
  const result=await runScheduledBackups(f.db,Buffer.alloc(32,8),f.env,p.transport);
  assert.ok(result.sha256);assert.equal(p.uploads.length,1);assert.ok(get(f.db,'operations.last_backup_filename'));
 }finally{f.close();}
});
test('a traversal or symlink cannot substitute an arbitrary file for the remembered encrypted backup',async()=>{
 const f=fixture(),p=provider();try{
  await runScheduledBackups(f.db,Buffer.alloc(32,8),f.env,p.transport);
  const name=get(f.db,'operations.last_backup_filename'),calls=p.calls;
  for(const replacement of ['../outside.mebak','redirect.mebak']){
   if(replacement==='redirect.mebak')symlinkSync(join(f.folder,name),join(f.folder,replacement));
   set(f.db,'operations.last_backup_filename',replacement);set(f.db,'operations.last_offsite_at',past(25));set(f.db,'operations.last_offsite_attempt_at',past(2));
   await assert.rejects(()=>maybeOffsiteBackup(f.db,f.env,p.transport),/ENCRYPTED_BACKUP_REQUIRED|BACKUP_FILE_UNAVAILABLE/);
   assert.equal(p.calls,calls);
  }
 }finally{f.close();}
});
