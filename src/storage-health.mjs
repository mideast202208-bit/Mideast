import {statfsSync,statSync,accessSync,constants,realpathSync,existsSync} from 'node:fs';
import {resolve,dirname,relative,isAbsolute} from 'node:path';
export function storageHealth(db,env={},probe={}){
 const path=db.prepare('PRAGMA database_list').all().find(r=>r.name==='main')?.file||null;
 const data={type:'sqlite',path:path||':memory:',journal_mode:db.prepare('PRAGMA journal_mode').get().journal_mode,busy_timeout_ms:db.prepare('PRAGMA busy_timeout').get().timeout,schema_version:db.prepare('SELECT MAX(version) n FROM schema_versions').get().n};
 const result={database:data,storage:{verified:false},recovery_mode:env.RECOVERY_MODE==='1',backup:{encrypted_configured:Boolean(env.BACKUP_PUBLIC_KEY),export_enabled:Boolean(env.BACKUP_EXPORT_TOKEN&&env.BACKUP_PUBLIC_KEY),offsite_configured:false}};
 if(!path)return result;
 try{
  const root=realpathSync(path),folder=dirname(root),mounted=resolve(env.PERSISTENT_DATA_DIR||'/app/data'),key=env.KEY_PATH||resolve(folder,'server.key'),backups=env.BACKUP_DIR||resolve('backups');
  const inside=p=>{const r=relative(mounted,resolve(p));return !r.startsWith('..')&&!isAbsolute(r);};
  const fs=(probe.statfs||statfsSync)(folder),free=Number(fs.bavail)*Number(fs.bsize),total=Number(fs.blocks)*Number(fs.bsize);accessSync(folder,constants.W_OK);
  result.storage={verified:true,database_bytes:statSync(root).size,wal_bytes:existsSync(root+'-wal')?statSync(root+'-wal').size:0,total_bytes:total,available_bytes:free,used_percent:Math.round((1-free/total)*1000)/10,database_under_mount:inside(root),key_under_mount:inside(key),backups_under_mount:inside(backups),minimum_free_bytes:Number(env.MIN_FREE_DISK_BYTES||5*1024**2),low_space:free<Number(env.MIN_FREE_DISK_BYTES||5*1024**2),writable_directory:true};
 }catch{result.storage={verified:false,error:'STORAGE_PROBE_FAILED'};}
 return result;
}
export function healthStatus(db,env={},probe={}){
 try{db.prepare('SELECT 1').get();const s=storageHealth(db,env,probe);if(s.database.path!==':memory:'&&!s.storage.verified)return {code:503,body:{status:'degraded',reason:'STORAGE_UNAVAILABLE'}};if(s.storage.low_space)return {code:503,body:{status:'degraded',reason:'STORAGE_LOW'}};return {code:200,body:{status:'ok',...(env.RECOVERY_MODE==='1'?{mode:'recovery'}:{})}};}catch{return {code:503,body:{status:'degraded',reason:'DATABASE_UNAVAILABLE'}};}
}
