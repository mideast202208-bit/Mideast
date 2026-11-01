import {createReadStream,createWriteStream,mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createHash} from 'node:crypto';
import {fileDigest} from './recovery.mjs';
const reject=code=>{throw new Error(code);};
async function accessToken(env,transport){
 if(!env.DRIVE_CLIENT_ID||!env.DRIVE_CLIENT_SECRET||!env.DRIVE_REFRESH_TOKEN)reject('DRIVE_OAUTH_CONFIGURATION_REQUIRED');
 const response=await transport('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:env.DRIVE_CLIENT_ID,client_secret:env.DRIVE_CLIENT_SECRET,refresh_token:env.DRIVE_REFRESH_TOKEN,grant_type:'refresh_token'}).toString(),redirect:'error',signal:AbortSignal.timeout(30000)});
 if(!response.ok)reject('DRIVE_OAUTH_REFRESH_FAILED');const token=await response.json();if(typeof token.access_token!=='string'||!token.access_token)reject('DRIVE_OAUTH_REFRESH_FAILED');return token.access_token;
}
export async function uploadEncryptedToDrive(path,sha256,env,transport=fetch){
 if(!/^[a-f0-9]{64}$/.test(sha256)||!path.endsWith('.mebak')||await fileDigest(path)!==sha256)reject('ENCRYPTED_BACKUP_INTEGRITY_FAILED');
 if(!/^[A-Za-z0-9_-]{5,150}$/.test(env.DRIVE_FOLDER_ID||''))reject('PRIVATE_DRIVE_FOLDER_REQUIRED');
 const token=await accessToken(env,transport),auth={Authorization:'Bearer '+token},bytes=statSync(path).size;
 const folder=await transport('https://www.googleapis.com/drive/v3/files/'+env.DRIVE_FOLDER_ID+'?fields=id,mimeType,trashed,capabilities(canAddChildren),permissions(type,role)',{headers:auth,redirect:'error',signal:AbortSignal.timeout(30000)});
 if(!folder.ok)reject('DRIVE_FOLDER_UNAVAILABLE');const metadata=await folder.json();if(metadata.mimeType!=='application/vnd.google-apps.folder'||metadata.trashed||metadata.capabilities?.canAddChildren!==true||!Array.isArray(metadata.permissions)||metadata.permissions.some(p=>p.type!=='user'))reject('DRIVE_FOLDER_MUST_BE_PRIVATE');
 const name=path.split(/[\\/]/).at(-1),session=await transport('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,size,md5Checksum',{method:'POST',headers:{...auth,'Content-Type':'application/json','X-Upload-Content-Type':'application/octet-stream','X-Upload-Content-Length':String(bytes)},body:JSON.stringify({name,parents:[env.DRIVE_FOLDER_ID],appProperties:{me_crm_backup:'1',sha256}}),redirect:'error',signal:AbortSignal.timeout(30000)});
 if(!session.ok)reject('DRIVE_UPLOAD_SESSION_FAILED');let url;try{url=new URL(session.headers.get('location'));}catch{reject('INVALID_DRIVE_UPLOAD_SESSION');}if(url.protocol!=='https:'||url.hostname!=='www.googleapis.com'||!url.pathname.startsWith('/upload/drive/v3/files'))reject('INVALID_DRIVE_UPLOAD_SESSION');
 const uploaded=await transport(url.href,{method:'PUT',headers:{...auth,'Content-Type':'application/octet-stream','Content-Length':String(bytes)},body:createReadStream(path),duplex:'half',redirect:'error',signal:AbortSignal.timeout(300000)});
 if(!uploaded.ok)reject('DRIVE_UPLOAD_FAILED');const file=await uploaded.json();if(!/^[A-Za-z0-9_-]{5,150}$/.test(file.id||'')||Number(file.size)!==bytes||file.md5Checksum!==await fileDigest(path,'md5'))reject('DRIVE_UPLOAD_VERIFICATION_FAILED');
 return {provider:'google_drive',file_id:file.id,bytes,sha256};
}
export async function runOffsiteBackup(env,transport=fetch){
 let origin;try{origin=new URL(env.CRM_ORIGIN);}catch{reject('CRM_ORIGIN_REQUIRED');}if(origin.protocol!=='https:'||origin.username||origin.password||origin.search||origin.hash||origin.pathname!=='/')reject('INVALID_CRM_ORIGIN');
 if(!env.CRM_BACKUP_EXPORT_TOKEN||env.CRM_BACKUP_EXPORT_TOKEN.length<32)reject('BACKUP_EXPORT_TOKEN_REQUIRED');
 const folder=mkdtempSync(join(env.TMPDIR||tmpdir(),'me-offsite-'));try{
  const auth={Authorization:'Bearer '+env.CRM_BACKUP_EXPORT_TOKEN},response=await transport(origin.origin+'/internal/backup/export',{method:'POST',headers:auth,redirect:'error',signal:AbortSignal.timeout(300000)});
  if(!response.ok)reject('BACKUP_EXPORT_FAILED');const expected=response.headers.get('x-backup-sha256'),length=Number(response.headers.get('content-length'));if(!/^[a-f0-9]{64}$/.test(expected||'')||!Number.isSafeInteger(length)||length<100||length>16*1024**3)reject('INVALID_BACKUP_EXPORT');
  const filename='mid-east-'+new Date().toISOString().replace(/[:.]/g,'-')+'.mebak',path=join(folder,filename),digest=createHash('sha256');let size=0;
  const tap=new Transform({transform(chunk,_,callback){size+=chunk.length;if(size>length)callback(new Error('BACKUP_EXPORT_SIZE_MISMATCH'));else{digest.update(chunk);callback(null,chunk);}}});
  await pipeline(Readable.fromWeb(response.body),tap,createWriteStream(path,{flags:'wx',mode:0o600}));if(size!==length||digest.digest('hex')!==expected)reject('BACKUP_EXPORT_HASH_MISMATCH');
  const uploaded=await uploadEncryptedToDrive(path,expected,env,transport);
  const receipt=await transport(origin.origin+'/internal/backup/receipt',{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify({sha256:expected,file_id:uploaded.file_id}),redirect:'error',signal:AbortSignal.timeout(30000)});if(!receipt.ok)reject('OFFSITE_RECEIPT_FAILED');
  return {status:'verified',provider:uploaded.provider,bytes:uploaded.bytes,sha256:expected,checked_at:new Date().toISOString()};
 }finally{rmSync(folder,{recursive:true,force:true});}
}
