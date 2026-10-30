import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fail, text, audit } from './service.mjs';

export function loadServerKey(env){
  if(env.APP_ENCRYPTION_KEY){
    if(!/^[a-fA-F0-9]{64}$/.test(env.APP_ENCRYPTION_KEY))throw new Error('APP_ENCRYPTION_KEY must be 32 bytes in hex');
    return Buffer.from(env.APP_ENCRYPTION_KEY,'hex');
  }
  const path=env.KEY_PATH || resolve(dirname(env.DB_PATH || 'data/mid-east.sqlite'),'server.key');
  mkdirSync(dirname(path),{recursive:true,mode:0o700});
  if(!existsSync(path))writeFileSync(path,randomBytes(32),{mode:0o600,flag:'wx'});
  chmodSync(path,0o600);const key=readFileSync(path);if(key.length!==32)throw new Error('Invalid server encryption key');return key;
}
export function encryptSecret(value,key){
  const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);
  const data=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
  return [nonce,cipher.getAuthTag(),data].map(v=>v.toString('base64url')).join('.');
}
export function decryptSecret(value,key){
  const parts=value.split('.').map(v=>Buffer.from(v,'base64url'));
  const decipher=createDecipheriv('aes-256-gcm',key,parts[0]);decipher.setAuthTag(parts[1]);
  return Buffer.concat([decipher.update(parts[2]),decipher.final()]).toString('utf8');
}
const names={appSecret:'META_APP_SECRET',verifyToken:'META_VERIFY_TOKEN',accessToken:'META_ACCESS_TOKEN',
  phoneId:'META_PHONE_NUMBER_ID',version:'META_GRAPH_VERSION',intakeUser:'META_INTAKE_USER_ID',wabaId:'META_WABA_ID'};
const secretNames=new Set(['appSecret','verifyToken','accessToken']);
export function effectiveConfig(db,env,key){
  const config={};
  for(const [name,envName] of Object.entries(names)){
    const stored=db.prepare('SELECT value FROM settings WHERE key=?').get('wa.'+name)?.value;
    config[name]=stored===undefined?env[envName]:secretNames.has(name)?decryptSecret(stored,key):stored;
  }
  config.autoMedia=db.prepare("SELECT value FROM settings WHERE key='wa.autoMedia'").get()?.value==='true';
  return config;
}
export function saveIntegration(db,user,input,key){
  if(user.role!=='admin')fail(403,'إعداد أسرار الربط للمالك فقط');
  const cleaned=[];
  for(const name of Object.keys(names)){
    if(input[name]===undefined || (secretNames.has(name)&&input[name]===''))continue;
    const value=text(input[name],name,secretNames.has(name)?4096:150);
    if(['phoneId','wabaId'].includes(name)&&!/^\d+$/.test(value))fail(400,'المعرّف يجب أن يكون أرقامًا');
    if(name==='phoneId'&&db.prepare("SELECT 1 FROM communication_accounts WHERE channel='whatsapp' AND account_id=?").get(value))fail(409,'الرقم مضاف ضمن حسابات واتساب الإضافية');
    if(name==='phoneId'&&db.prepare("SELECT COUNT(*) n FROM communication_accounts WHERE channel='whatsapp'").get().n>=10)fail(409,'وصلت للحد المسموح من أرقام واتساب');
    if(name==='version'&&!/^v\d+\.\d+$/.test(value))fail(400,'إصدار Graph غير صالح');
    if(name==='intakeUser'&&!db.prepare("SELECT id FROM users WHERE id=? AND active=1 AND role IN('admin','manager','agent')").get(value))fail(400,'اختر موظف استقبال نشطًا');
    cleaned.push(['wa.'+name,secretNames.has(name)?encryptSecret(value,key):value]);
  }
  if(input.autoMedia!==undefined){if(typeof input.autoMedia!=='boolean')fail(400,'حالة تنزيل الملفات غير صالحة');cleaned.push(['wa.autoMedia',String(input.autoMedia)]);}
  for(const pair of cleaned)db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(...pair);
  audit(db,user,'configured','integration','whatsapp',{changed:cleaned.map(([name])=>name)});
}
