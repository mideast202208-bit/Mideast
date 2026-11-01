import { backup } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import {fileDigest,requiresRecoveryKey,createRecoveryBundle} from './recovery.mjs';

export async function createSnapshot(db,key,directory){
  const needsKey=requiresRecoveryKey(db);
  if(needsKey&&(!key||key.length!==32))throw new Error('Encryption key is required for a recoverable backup');
  if(key&&key.length!==32)throw new Error('Invalid encryption key');
  const folder=resolve(directory);mkdirSync(folder,{recursive:true,mode:0o700});
  const path=resolve(folder,`mid-east-${new Date().toISOString().replace(/[:.]/g,'-')}.sqlite`);
  await backup(db,path);chmodSync(path,0o600);
  writeFileSync(path+'.sha256',await fileDigest(path)+'\n',{mode:0o600});
  if(key){
    writeFileSync(path+'.key',key,{mode:0o600,flag:'wx'});
    writeFileSync(path+'.key.sha256',createHash('sha256').update(key).digest('hex')+'\n',{mode:0o600,flag:'wx'});
  }
  return path;
}
export async function maybeSnapshot(db,key,env){
  if(!db.prepare('SELECT id FROM users LIMIT 1').get())return;
  const hours=Number(env.BACKUP_INTERVAL_HOURS||0);if(!Number.isFinite(hours)||hours<1||hours>8760)return;
  const last=db.prepare("SELECT value FROM settings WHERE key='operations.last_backup_at'").get()?.value;
  if(last&&Date.now()-Date.parse(last)<hours*3600000)return;
  const get=name=>db.prepare('SELECT value FROM settings WHERE key=?').get(name)?.value;
  const set=(name,value)=>db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(name,String(value));
  const attempted=get('operations.last_backup_attempt_at');if(attempted&&Date.now()-Date.parse(attempted)<3600000)return;
  set('operations.last_backup_attempt_at',new Date().toISOString());
  try{
    if((env.NODE_ENV==='production'||env.BACKUP_REQUIRE_ENCRYPTED==='1')&&!env.BACKUP_PUBLIC_KEY)throw new Error('BACKUP_PUBLIC_KEY_REQUIRED');
    const result=env.BACKUP_PUBLIC_KEY?await createRecoveryBundle(db,key,{directory:env.BACKUP_DIR||'backups',sourceRoot:env.BACKUP_SOURCE_ROOT||resolve(new URL('..',import.meta.url).pathname),publicKey:env.BACKUP_PUBLIC_KEY.replaceAll('\\n','\n'),env}):{path:await createSnapshot(db,key,env.BACKUP_DIR||'backups')};
    set('operations.last_backup_at',new Date().toISOString());set('operations.backup_encrypted',Boolean(result.sha256));set('operations.last_backup_error','');if(result.sha256)set('operations.last_backup_sha256',result.sha256);return result.path;
  }catch{set('operations.last_backup_error','BACKUP_FAILED');set('operations.last_backup_failure_at',new Date().toISOString());throw new Error('BACKUP_FAILED');}
}
