import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { openDatabase } from '../src/db.mjs';
import { createSnapshot } from '../src/backups.mjs';

process.umask(0o077);
const dbPath=process.env.DB_PATH||resolve('data/mid-east.sqlite'),db=openDatabase(dbPath);
const keyPath=process.env.KEY_PATH||resolve(dirname(dbPath),'server.key');
const key=process.env.APP_ENCRYPTION_KEY?Buffer.from(process.env.APP_ENCRYPTION_KEY,'hex'):existsSync(keyPath)?readFileSync(keyPath):null;
try{
  const path=await createSnapshot(db,key,process.env.BACKUP_DIR||'backups');
  console.log('Consistent database snapshot created:',path);
  console.log('Includes sensitive records; a key sidecar is included when present. Encrypt the entire set before offsite transfer.');
}finally{db.close();}
