import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { encryptSecret, decryptSecret } from './integration-settings.mjs';
import { fail, audit } from './service.mjs';
const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(bytes){let bits=0,value=0,out='';for(const byte of bytes){value=(value<<8)|byte;bits+=8;while(bits>=5){out+=alphabet[(value>>>(bits-5))&31];bits-=5;}}if(bits)out+=alphabet[(value<<(5-bits))&31];return out;}
function decode32(text){let bits=0,value=0;const out=[];for(const ch of text.toUpperCase().replace(/=+$/,'')){const index=alphabet.indexOf(ch);if(index<0)throw new Error('Invalid base32');value=(value<<5)|index;bits+=5;if(bits>=8){out.push((value>>>(bits-8))&255);bits-=8;}}return Buffer.from(out);}
export function totp(secret,counter,digits=6){
  const bytes=Buffer.alloc(8);bytes.writeBigUInt64BE(BigInt(counter));
  const result=createHmac('sha1',decode32(secret)).update(bytes).digest();const offset=result.at(-1)&15;
  const number=result.readUInt32BE(offset)&0x7fffffff;return String(number%10**digits).padStart(digits,'0');
}
export function verifyFactor(db,userId,code,key,{requireEnabled=true}={}){
  if(typeof code!=='string'||!/^\d{6}$/.test(code))return false;
  const factor=db.prepare('SELECT * FROM login_factors WHERE user_id=?').get(userId);
  if(!factor || (requireEnabled&&!factor.enabled))return false;
  const secret=decryptSecret(factor.secret_cipher,key),counter=Math.floor(Date.now()/30000);
  for(const step of [counter-1,counter,counter+1]){
    if(step<0 || (factor.last_counter!==null&&step<=factor.last_counter))continue;
    if(timingSafeEqual(Buffer.from(code),Buffer.from(totp(secret,step)))){
      const result=db.prepare('UPDATE login_factors SET last_counter=? WHERE user_id=? AND (last_counter IS NULL OR last_counter<?)').run(step,userId,step);
      return Boolean(result.changes);
    }
  }
  return false;
}
export async function handleMfa({db,user,path,method,req,jsonBody,sendJson,res,key}){
  const respond=(status,data)=>{sendJson(res,status,data);return true;};
  if(path==='/api/security/mfa'&&method==='GET')return respond(200,{enabled:Boolean(db.prepare('SELECT enabled FROM login_factors WHERE user_id=?').get(user.id)?.enabled)});
  if(path==='/api/security/mfa/enroll'&&method==='POST'){
    if(db.prepare('SELECT enabled FROM login_factors WHERE user_id=?').get(user.id)?.enabled)fail(409,'المصادقة مفعلة بالفعل');
    const secret=base32(randomBytes(20));
    db.prepare('INSERT INTO login_factors(user_id,secret_cipher) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET secret_cipher=excluded.secret_cipher,last_counter=NULL').run(user.id,encryptSecret(secret,key));
    audit(db,user,'enrollment_started','mfa',user.id);
    return respond(200,{secret,uri:`otpauth://totp/${encodeURIComponent('Mid East:'+user.email)}?secret=${secret}&issuer=Mid%20East&algorithm=SHA1&digits=6&period=30`});
  }
  if(path==='/api/security/mfa/confirm'&&method==='POST'){
    const input=await jsonBody(req);if(!verifyFactor(db,user.id,input.code,key,{requireEnabled:false}))fail(400,'رمز التحقق غير صحيح أو استُخدم بالفعل');
    db.prepare('UPDATE login_factors SET enabled=1 WHERE user_id=?').run(user.id);audit(db,user,'enabled','mfa',user.id);return respond(200,{ok:true});
  }
  if(path==='/api/security/mfa/disable'&&method==='POST'){
    const input=await jsonBody(req);if(!verifyFactor(db,user.id,input.code,key))fail(400,'رمز التحقق غير صحيح أو استُخدم بالفعل');
    db.prepare('DELETE FROM login_factors WHERE user_id=?').run(user.id);audit(db,user,'disabled','mfa',user.id);return respond(200,{ok:true});
  }
  return false;
}
