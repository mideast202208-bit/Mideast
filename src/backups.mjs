import { backup } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

export async function createSnapshot(db,key,directory){
  const needsKey=db.prepare("SELECT COUNT(*) n FROM settings WHERE key IN('wa.accessToken','wa.appSecret','wa.verifyToken')").get().n || db.prepare('SELECT COUNT(*) n FROM login_factors').get().n;
  if(needsKey&&(!key||key.length!==32))throw new Error('Encryption key is required for a recoverable backup');
  if(key&&key.length!==32)throw new Error('Invalid encryption key');
  const folder=resolve(directory);mkdirSync(folder,{recursive:true,mode:0o700});
  const path=resolve(folder,`mid-east-${new Date().toISOString().replace(/[:.]/g,'-')}.sqlite`);
  await backup(db,path);chmodSync(path,0o600);
  writeFileSync(path+'.sha256',createHash('sha256').update(readFileSync(path)).digest('hex')+'\n',{mode:0o600});
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
  const path=await createSnapshot(db,key,env.BACKUP_DIR||'backups');
  db.prepare("INSERT INTO settings VALUES('operations.last_backup_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(new Date().toISOString());
  return path;
}
