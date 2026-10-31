import {createHash,timingSafeEqual} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRecoveryBundle} from './recovery.mjs';
import {storageHealth} from './storage-health.mjs';
import {readiness} from './operations.mjs';
import {audit,fail} from './service.mjs';
const busy=new WeakSet();
const set=(db,k,v)=>db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k,String(v));
function authorized(req,env){const expected=env.BACKUP_EXPORT_TOKEN,actual=String(req.headers.authorization||'').startsWith('Bearer ')?String(req.headers.authorization).slice(7):'';return expected?.length>=32&&actual.length>=32&&timingSafeEqual(createHash('sha256').update(expected).digest(),createHash('sha256').update(actual).digest());}
export async function handleBackupMachine(ctx){
 const {path,method,req,res,db,env,secretKey,jsonBody,sendJson,rateLimit}=ctx;if(!path.startsWith('/internal/backup/'))return false;
 if(!authorized(req,env))fail(401,'Unauthorized');if(env.RECOVERY_MODE==='1')fail(409,'RECOVERY_MODE');
 if(path==='/internal/backup/status'&&method==='GET'){const r=readiness(db);sendJson(res,200,{checked_at:r.checked_at,backups:r.backups});return true;}
 if(path==='/internal/backup/receipt'&&method==='POST'){
  const input=await jsonBody(req),expected=db.prepare("SELECT value FROM settings WHERE key='operations.last_backup_sha256'").get()?.value;
  if(!/^[a-f0-9]{64}$/.test(input.sha256||'')||input.sha256!==expected||!/^[a-zA-Z0-9_-]{5,150}$/.test(input.file_id||''))fail(400,'INVALID_BACKUP_RECEIPT');
  set(db,'operations.last_offsite_at',new Date().toISOString());set(db,'operations.last_offsite_sha256',input.sha256);set(db,'operations.offsite_provider','google_drive');audit(db,null,'offsite_confirmed','backup','encrypted',{provider:'google_drive'});sendJson(res,200,{ok:true});return true;
 }
 if(path!=='/internal/backup/export'||method!=='POST')fail(404,'Not found');
 rateLimit('backup-export',4,3600000);if(busy.has(db))fail(409,'BACKUP_ALREADY_RUNNING');busy.add(db);
 try{
  const result=await createRecoveryBundle(db,secretKey,{directory:env.BACKUP_DIR||resolve('backups'),sourceRoot:env.BACKUP_SOURCE_ROOT||fileURLToPath(new URL('..',import.meta.url)),publicKey:env.BACKUP_PUBLIC_KEY?.replaceAll('\\n','\n'),env});
  set(db,'operations.last_backup_at',result.created_at);set(db,'operations.last_backup_sha256',result.sha256);set(db,'operations.backup_encrypted','true');set(db,'operations.last_backup_error','');audit(db,null,'exported','backup','encrypted',{bytes:result.bytes});
  res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':result.bytes,'Content-Disposition':'attachment; filename="'+result.filename+'"','X-Backup-SHA256':result.sha256,'Cache-Control':'no-store'});await pipeline(createReadStream(result.path),res);return true;
 }catch(error){set(db,'operations.last_backup_error','BACKUP_FAILED');set(db,'operations.last_backup_failure_at',new Date().toISOString());throw error;}finally{busy.delete(db);}
}
export function backupDiagnostics(db,user,env){if(user.role!=='admin')fail(403,'فحص التخزين ومفاتيح الاستعادة للمالك');return {...storageHealth(db,env),...{backups:readiness(db).backups},runtime:{node:process.version,memory:process.memoryUsage(),uptime_seconds:Math.floor(process.uptime()),independent_workers:true}};}
