import {DatabaseSync} from 'node:sqlite';
import {existsSync,readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRecoveryBundle,requiresRecoveryKey} from './recovery.mjs';
import {storageHealth} from './storage-health.mjs';
import {LATEST_SCHEMA_VERSION} from './db.mjs';
export async function startupPreflight(env){
 const path=env.DB_PATH||resolve('data/mid-east.sqlite');if(!existsSync(path))return {existing:false};
 const db=new DatabaseSync(path,{readOnly:true});
 try{
  if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('DATABASE_PREFLIGHT_INTEGRITY_FAILED');
  const version=db.prepare('SELECT MAX(version) n FROM schema_versions').get().n;if(version>LATEST_SCHEMA_VERSION)throw new Error('DATABASE_NEWER_THAN_APPLICATION');
  const keyPath=env.KEY_PATH||resolve(dirname(path),'server.key'),key=env.APP_ENCRYPTION_KEY?Buffer.from(env.APP_ENCRYPTION_KEY,'hex'):existsSync(keyPath)?readFileSync(keyPath):null;
  if(requiresRecoveryKey(db)&&key?.length!==32)throw new Error('EXISTING_DATABASE_RECOVERY_KEY_MISSING');
  if(env.REQUIRE_PERSISTENT_STORAGE==='1'){
   const health=storageHealth(db,env);if(!health.storage.database_under_mount||!health.storage.key_under_mount||!health.storage.backups_under_mount)throw new Error('PERSISTENT_PATH_REQUIRED');
  }
  let backup=null;if(version<LATEST_SCHEMA_VERSION){
   if(!env.BACKUP_PUBLIC_KEY)throw new Error('MIGRATION_REQUIRES_ENCRYPTED_BACKUP');
   backup=await createRecoveryBundle(db,key,{directory:env.BACKUP_DIR||resolve('backups'),sourceRoot:env.BACKUP_SOURCE_ROOT||fileURLToPath(new URL('..',import.meta.url)),publicKey:env.BACKUP_PUBLIC_KEY.replaceAll('\\n','\n'),env});
  }
  return {existing:true,schema_version:version,migration_pending:version<LATEST_SCHEMA_VERSION,backup:backup?{filename:backup.filename,sha256:backup.sha256}:null};
 }finally{db.close();}
}
