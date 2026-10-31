import {backup,DatabaseSync} from 'node:sqlite';
import {createReadStream,createWriteStream,existsSync,mkdirSync,mkdtempSync,lstatSync,readdirSync,readFileSync,writeFileSync,renameSync,rmSync,statSync,openSync,fsyncSync,closeSync} from 'node:fs';
import {resolve,join,dirname,relative,sep} from 'node:path';
import {createHash,randomBytes,randomUUID,createCipheriv,createDecipheriv,publicEncrypt,privateDecrypt,createPublicKey,constants} from 'node:crypto';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createGzip,createGunzip} from 'node:zlib';
import {decryptSecret} from './integration-settings.mjs';
const MAGIC=Buffer.from('MECRM-BACKUP-1\n'),MAX_FILES=10000,MAX_FILE=16*1024**3;
const directories=new Set(['src','public','scripts','deploy','content','tests','docs','.github']);
const rootFiles=new Set(['package.json','package-lock.json','render.yaml','.dockerignore','.gitignore']);
export async function fileDigest(path,algorithm='sha256'){const h=createHash(algorithm);for await(const b of createReadStream(path))h.update(b);return h.digest('hex');}
export function requiresRecoveryKey(db){
 const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name));
 for(const [table,where] of [['settings',"key IN('wa.accessToken','wa.appSecret','wa.verifyToken')"],['login_factors','1'],['intake_registrations','1'],['channel_accounts','token_cipher IS NOT NULL OR secret_cipher IS NOT NULL OR verify_cipher IS NOT NULL'],['communication_accounts','1']])if(tables.has(table)&&db.prepare('SELECT 1 FROM '+table+' WHERE '+where+' LIMIT 1').get())return true;
 return false;
}
function counts(db){return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>[name,db.prepare('SELECT COUNT(*) n FROM "'+name.replaceAll('"','""')+'"').get().n]));}
function inventory(root){const rows=[];function walk(folder){for(const item of readdirSync(folder,{withFileTypes:true})){const path=join(folder,item.name),rel=relative(root,path).split(sep).join('/');if(item.isSymbolicLink())continue;if(item.isDirectory()){if(folder!==root||directories.has(item.name))walk(path);}else if(item.isFile()&&(folder!==root||rootFiles.has(item.name)||/^README.*\.md$/.test(item.name))){if(item.name==='.env'||item.name.endsWith('.key')||item.name.endsWith('.pem'))continue;rows.push({name:'app/'+rel,path,size:statSync(path).size});}}}walk(root);return rows;}
const entryDigest=e=>e.data?Promise.resolve(createHash('sha256').update(e.data).digest('hex')):fileDigest(e.path);
async function* archive(entries){for(const e of entries){yield Buffer.from(JSON.stringify({name:e.name,size:e.size})+'\n');if(e.data)yield e.data;else for await(const chunk of createReadStream(e.path))yield chunk;yield Buffer.from('\n');}}
export async function createRecoveryBundle(db,key,options){
 const {directory,sourceRoot,publicKey,env={}}=options;if(!publicKey)throw new Error('BACKUP_RECIPIENT_PUBLIC_KEY_REQUIRED');
 if(requiresRecoveryKey(db)&&(!key||key.length!==32))throw new Error('RECOVERY_KEY_REQUIRED');
 if(key&&key.length!==32)throw new Error('INVALID_RECOVERY_KEY');
 const recipient=createPublicKey(publicKey);if(recipient.asymmetricKeyType!=='rsa'||recipient.asymmetricKeyDetails.modulusLength<3072)throw new Error('RSA_3072_OR_STRONGER_REQUIRED');
 const folder=resolve(directory);mkdirSync(folder,{recursive:true,mode:0o700});const temp=mkdtempSync(join(folder,'.recovery-'));
 const filename='mid-east-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID()+'.mebak',destination=join(folder,filename),partial=destination+'.partial';
 try{
  const snapshot=join(temp,'database.sqlite');await backup(db,snapshot,{rate:100});const check=new DatabaseSync(snapshot,{readOnly:true});let tableCounts,schema;
  try{if(check.prepare('PRAGMA quick_check').get().quick_check!=='ok'||check.prepare('PRAGMA foreign_key_check').all().length)throw new Error('SNAPSHOT_INTEGRITY_FAILED');tableCounts=counts(check);schema=check.prepare('SELECT MAX(version) n FROM schema_versions').get().n;}finally{check.close();}
  const entries=[{name:'data/mid-east.sqlite',path:snapshot,size:statSync(snapshot).size},...inventory(resolve(sourceRoot))];
  if(key)entries.push({name:'data/server.key',data:Buffer.from(key),size:key.length});
  const runtime={};for(const [k,v] of Object.entries(env))if(/^(META_[A-Z_]+|PUBLIC_ORIGIN|NODE_ENV|BACKUP_INTERVAL_HOURS)$/.test(k))runtime[k]=v;
  const runtimeBytes=Buffer.from(JSON.stringify(runtime));entries.push({name:'runtime.env.json',data:runtimeBytes,size:runtimeBytes.length});
  if(entries.length>MAX_FILES||entries.some(e=>e.size>MAX_FILE)||entries.reduce((sum,e)=>sum+e.size,0)>MAX_FILE)throw new Error('BACKUP_SIZE_LIMIT');
  const checks=[];for(const e of entries)checks.push({name:e.name,size:e.size,sha256:await entryDigest(e)});
  const manifest={format:1,created_at:new Date().toISOString(),schema_version:schema,app_version:JSON.parse(readFileSync(join(sourceRoot,'package.json'),'utf8')).version,source_commit:env.RENDER_GIT_COMMIT||null,table_counts:tableCounts,entries:checks};
  const m=Buffer.from(JSON.stringify(manifest));entries.unshift({name:'manifest.json',data:m,size:m.length});
  const dataKey=randomBytes(32),nonce=randomBytes(12),wrapped=publicEncrypt({key:recipient,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},dataKey);
  const header=Buffer.from(JSON.stringify({algorithm:'AES-256-GCM+RSA-OAEP-SHA256',nonce:nonce.toString('base64'),wrapped_key:wrapped.toString('base64'),recipient_sha256:createHash('sha256').update(recipient.export({type:'spki',format:'der'})).digest('hex')}));
  const length=Buffer.alloc(4);length.writeUInt32BE(header.length);const prefix=Buffer.concat([MAGIC,length,header]),cipher=createCipheriv('aes-256-gcm',dataKey,nonce);cipher.setAAD(prefix);
  const body=join(temp,'sealed');await pipeline(Readable.from(archive(entries)),createGzip(),cipher,createWriteStream(body,{flags:'wx',mode:0o600}));
  const tag=cipher.getAuthTag();async function* envelope(){yield prefix;for await(const b of createReadStream(body))yield b;yield tag;}
  await pipeline(Readable.from(envelope()),createWriteStream(partial,{flags:'wx',mode:0o600}));const fd=openSync(partial,'r');try{fsyncSync(fd);}finally{closeSync(fd);}renameSync(partial,destination);
  const sha256=await fileDigest(destination);writeFileSync(destination+'.sha256',sha256+'\n',{mode:0o600,flag:'wx'});dataKey.fill(0);
  return {path:destination,filename,sha256,bytes:statSync(destination).size,schema_version:schema,app_version:manifest.app_version,created_at:manifest.created_at,table_counts:tableCounts};
 }catch(error){rmSync(partial,{force:true});throw error;}finally{rmSync(temp,{recursive:true,force:true});}
}
class ArchiveReader{
 constructor(stream){this.iterator=stream[Symbol.asyncIterator]();this.buffer=Buffer.alloc(0);this.ended=false;}
 async read(n){while(this.buffer.length<n&&!this.ended){const r=await this.iterator.next();if(r.done)this.ended=true;else this.buffer=Buffer.concat([this.buffer,r.value]);}if(this.buffer.length<n)throw new Error('TRUNCATED_ARCHIVE');const r=this.buffer.subarray(0,n);this.buffer=this.buffer.subarray(n);return r;}
 async line(){for(let i=0;i<8192;i++){const b=await this.read(1);if(b[0]===10)return Buffer.concat(this.lineParts||[]).toString();(this.lineParts||=[]).push(b);}throw new Error('INVALID_ARCHIVE_HEADER');}
 async nextHeader(){this.lineParts=[];if(this.ended&&!this.buffer.length)return null;if(!this.buffer.length){const r=await this.iterator.next();if(r.done){this.ended=true;return null;}this.buffer=r.value;}return JSON.parse(await this.line());}
}
const validName=name=>typeof name==='string'&&/^(manifest\.json|runtime\.env\.json|data\/(mid-east\.sqlite|server\.key)|app\/[A-Za-z0-9_.\/-]+)$/.test(name)&&!name.split('/').some(p=>p==='.'||p==='..')&&!name.includes('//');
export async function restoreRecoveryBundle(source,target,privateKey,passphrase){
 source=resolve(source);target=resolve(target);if(existsSync(target))throw new Error('RESTORE_TARGET_EXISTS');
 mkdirSync(dirname(target),{recursive:true,mode:0o700});const stage=mkdtempSync(join(dirname(target),'.restore-')),compressed=join(stage,'.authenticated.gz');let extractionStream,compressedStream;
 try{
  const fd=openSync(source,'r');let prefix,header,bodyStart,total=statSync(source).size,tag;
  try{const pre=Buffer.alloc(MAGIC.length+4);const fs=await import('node:fs');if(fs.readSync(fd,pre,0,pre.length,0)!==pre.length||!pre.subarray(0,MAGIC.length).equals(MAGIC))throw new Error('INVALID_BACKUP_FORMAT');const len=pre.readUInt32BE(MAGIC.length);if(len<1||len>16384||total<pre.length+len+17)throw new Error('INVALID_BACKUP_HEADER');const h=Buffer.alloc(len);fs.readSync(fd,h,0,len,pre.length);header=JSON.parse(h);prefix=Buffer.concat([pre,h]);bodyStart=prefix.length;tag=Buffer.alloc(16);fs.readSync(fd,tag,0,16,total-16);}finally{closeSync(fd);}
  if(header.algorithm!=='AES-256-GCM+RSA-OAEP-SHA256')throw new Error('UNSUPPORTED_BACKUP_ALGORITHM');
  const dataKey=privateDecrypt({key:privateKey,passphrase,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},Buffer.from(header.wrapped_key,'base64'));
  const decipher=createDecipheriv('aes-256-gcm',dataKey,Buffer.from(header.nonce,'base64'));decipher.setAAD(prefix);decipher.setAuthTag(tag);
  await pipeline(createReadStream(source,{start:bodyStart,end:total-17}),decipher,createWriteStream(compressed,{flags:'wx',mode:0o600}));dataKey.fill(0);
  // Authenticate the complete ciphertext before decompressing or trusting paths.
  compressedStream=createReadStream(compressed);extractionStream=compressedStream.pipe(createGunzip());const reader=new ArchiveReader(extractionStream);let manifest=null,expected=new Map(),seen=new Set(),count=0;
  for(;;){const h=await reader.nextHeader();if(!h)break;if(++count>MAX_FILES+1||!validName(h.name)||seen.has(h.name)||!Number.isSafeInteger(h.size)||h.size<0||h.size>MAX_FILE)throw new Error('INVALID_ARCHIVE_ENTRY');seen.add(h.name);
   if(!manifest){if(h.name!=='manifest.json'||h.size>2*1024**2)throw new Error('MANIFEST_REQUIRED');manifest=JSON.parse((await reader.read(h.size)).toString());if(manifest.format!==1||!Array.isArray(manifest.entries)||manifest.entries.length>MAX_FILES)throw new Error('INVALID_MANIFEST');let bytes=0;for(const e of manifest.entries){if(!validName(e.name)||expected.has(e.name)||!Number.isSafeInteger(e.size)||e.size<0||e.size>MAX_FILE||!/^\w{64}$/.test(e.sha256))throw new Error('INVALID_MANIFEST');bytes+=e.size;if(bytes>MAX_FILE)throw new Error('BACKUP_SIZE_LIMIT');expected.set(e.name,e);} }
   else{const e=expected.get(h.name);if(!e||e.size!==h.size)throw new Error('UNEXPECTED_ARCHIVE_ENTRY');const destination=join(stage,h.name);mkdirSync(dirname(destination),{recursive:true,mode:0o700});const hash=createHash('sha256'),out=createWriteStream(destination,{flags:'wx',mode:0o600});async function* contents(){let left=h.size;while(left){const b=await reader.read(Math.min(left,65536));left-=b.length;hash.update(b);yield b;}}await pipeline(Readable.from(contents()),out);if(hash.digest('hex')!==e.sha256)throw new Error('RESTORED_HASH_MISMATCH');}
   if((await reader.read(1))[0]!==10)throw new Error('INVALID_ARCHIVE_DELIMITER');
  }
  if(!manifest||seen.size!==expected.size+1||!seen.has('data/mid-east.sqlite'))throw new Error('INCOMPLETE_BACKUP');
  const path=join(stage,'data/mid-east.sqlite'),db=new DatabaseSync(path);let restoredCounts;
  try{db.exec('PRAGMA foreign_keys=ON');if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('RESTORED_DATABASE_INVALID');restoredCounts=counts(db);if(JSON.stringify(restoredCounts)!==JSON.stringify(manifest.table_counts))throw new Error('RESTORED_COUNTS_MISMATCH');const key=seen.has('data/server.key')?readFileSync(join(stage,'data/server.key')):null;if(requiresRecoveryKey(db)&&key?.length!==32)throw new Error('RESTORED_KEY_MISSING');
   for(const [table,column] of [['settings','value'],['channel_accounts','token_cipher'],['channel_accounts','secret_cipher'],['channel_accounts','verify_cipher'],['communication_accounts','configuration_cipher'],['intake_registrations','receipt_cipher'],['login_factors','secret_cipher']]){if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table))continue;const where=table==='settings'?"key IN('wa.accessToken','wa.appSecret','wa.verifyToken')":column+' IS NOT NULL';for(const row of db.prepare('SELECT '+column+' cipher FROM '+table+' WHERE '+where).all())if(row.cipher)decryptSecret(row.cipher,key);}
   db.exec('DELETE FROM sessions');
  }finally{db.close();}
  writeFileSync(join(stage,'.env.recovery'),'RECOVERY_MODE=1\nDB_PATH='+join(target,'data/mid-east.sqlite')+'\nKEY_PATH='+join(target,'data/server.key')+'\nPUBLIC_ORIGIN=http://127.0.0.1:3000\n',{mode:0o600});rmSync(compressed);if(existsSync(target))throw new Error('RESTORE_TARGET_EXISTS');renameSync(stage,target);
  return {directory:target,integrity:'ok',foreign_key_errors:0,schema_version:manifest.schema_version,table_counts:restoredCounts,sessions_revoked:true,recovery_mode_required:true,app_version:manifest.app_version};
 }catch(error){rmSync(stage,{recursive:true,force:true});throw error;}finally{extractionStream?.destroy();compressedStream?.destroy();}
}
