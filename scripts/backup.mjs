import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { openDatabase } from '../src/db.mjs';
import { createSnapshot } from '../src/backups.mjs';
import {createRecoveryBundle} from '../src/recovery.mjs';

process.umask(0o077);
const dbPath=process.env.DB_PATH||resolve('data/mid-east.sqlite'),db=openDatabase(dbPath);
const keyPath=process.env.KEY_PATH||resolve(dirname(dbPath),'server.key');
const key=process.env.APP_ENCRYPTION_KEY?Buffer.from(process.env.APP_ENCRYPTION_KEY,'hex'):existsSync(keyPath)?readFileSync(keyPath):null;
try{
  if(process.env.NODE_ENV==='production'||process.env.BACKUP_REQUIRE_ENCRYPTED==='1'){const result=await createRecoveryBundle(db,key,{directory:process.env.BACKUP_DIR||'backups',sourceRoot:resolve(new URL('..',import.meta.url).pathname),publicKey:process.env.BACKUP_PUBLIC_KEY?.replaceAll('\\n','\n'),env:process.env});console.log(JSON.stringify({filename:result.filename,sha256:result.sha256,bytes:result.bytes}));process.exitCode=0;}else{
  const path=await createSnapshot(db,key,process.env.BACKUP_DIR||'backups');
  console.log('Consistent database snapshot created:',path);
  console.log('Includes sensitive records; a key sidecar is included when present. Encrypt the entire set before offsite transfer.');
  }
}finally{db.close();}
