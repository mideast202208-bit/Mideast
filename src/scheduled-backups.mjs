import {lstatSync,realpathSync} from 'node:fs';
import {resolve,dirname,basename} from 'node:path';
import {maybeSnapshot} from './backups.mjs';
import {uploadEncryptedToDrive} from './drive-backup.mjs';

const busy=new WeakSet();
const get=(db,key)=>db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value;
const set=(db,key,value)=>db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,String(value));
const retryMs=3600000;
const safeErrors=new Set(['DRIVE_OAUTH_CONFIGURATION_REQUIRED','PRIVATE_DRIVE_FOLDER_REQUIRED','ENCRYPTED_BACKUP_REQUIRED','ENCRYPTED_BACKUP_INTEGRITY_FAILED','DRIVE_OAUTH_REFRESH_FAILED','DRIVE_FOLDER_UNAVAILABLE','DRIVE_FOLDER_MUST_BE_PRIVATE','DRIVE_UPLOAD_SESSION_FAILED','INVALID_DRIVE_UPLOAD_SESSION','DRIVE_UPLOAD_FAILED','DRIVE_UPLOAD_VERIFICATION_FAILED','BACKUP_FILE_UNAVAILABLE']);

export function offsiteConfiguration(env){
 const enabled=env.BACKUP_OFFSITE_ENABLED==='1';
 return {enabled,configured:enabled&&Boolean(env.BACKUP_PUBLIC_KEY&&env.DRIVE_CLIENT_ID&&env.DRIVE_CLIENT_SECRET&&env.DRIVE_REFRESH_TOKEN&&/^[A-Za-z0-9_-]{5,150}$/.test(env.DRIVE_FOLDER_ID||''))};
}

export async function maybeOffsiteBackup(db,env,transport=fetch){
 if(env.RECOVERY_MODE==='1'||env.BACKUP_OFFSITE_ENABLED!=='1')return;
 const hours=Number(env.BACKUP_INTERVAL_HOURS||0);
 if(!Number.isFinite(hours)||hours<1||hours>8760)return;
 const sha256=get(db,'operations.last_backup_sha256'),last=get(db,'operations.last_offsite_at');
 const age=last?Date.now()-Date.parse(last):Infinity;
 if(age>=0&&age<hours*3600000&&get(db,'operations.last_offsite_sha256')===sha256)return;
 const attempted=Date.parse(get(db,'operations.last_offsite_attempt_at')||'');
 if(Number.isFinite(attempted)&&Date.now()-attempted>=0&&Date.now()-attempted<retryMs)return;
 set(db,'operations.last_offsite_attempt_at',new Date().toISOString());
 try{
  if(!offsiteConfiguration(env).configured)throw new Error('DRIVE_OAUTH_CONFIGURATION_REQUIRED');
  const name=get(db,'operations.last_backup_filename');
  if(get(db,'operations.backup_encrypted')!=='true'||!name||basename(name)!==name||!name.endsWith('.mebak')||!/^[a-f0-9]{64}$/.test(sha256||''))throw new Error('ENCRYPTED_BACKUP_REQUIRED');
  let path;
  try{const folder=realpathSync(resolve(env.BACKUP_DIR||'backups'));path=resolve(folder,name);const info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink()||dirname(realpathSync(path))!==folder)throw new Error();}catch{throw new Error('BACKUP_FILE_UNAVAILABLE');}
  const result=await uploadEncryptedToDrive(path,sha256,env,transport);
  // Never acknowledge success until the uploader has checked Google's size and checksum.
  set(db,'operations.last_offsite_at',new Date().toISOString());
  set(db,'operations.last_offsite_sha256',sha256);
  set(db,'operations.last_offsite_file_id',result.file_id);
  set(db,'operations.offsite_provider','google_drive');
  set(db,'operations.last_offsite_error','');
  return {provider:result.provider,file_id:result.file_id,bytes:result.bytes,sha256};
 }catch(error){
  const code=safeErrors.has(error.message)?error.message:'DRIVE_BACKUP_FAILED';
  set(db,'operations.last_offsite_error',code);set(db,'operations.last_offsite_failure_at',new Date().toISOString());
  throw new Error(code);
 }
}

export async function runScheduledBackups(db,key,env,transport=fetch){
 if(env.RECOVERY_MODE==='1'||busy.has(db))return;
 busy.add(db);
 try{await maybeSnapshot(db,key,env);return await maybeOffsiteBackup(db,env,transport);}
 finally{busy.delete(db);}
}
