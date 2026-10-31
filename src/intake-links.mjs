import {createHmac,timingSafeEqual} from 'node:crypto';
import {fail} from './service.mjs';

export function registrationLink(contactId,source,key,origin){
  if(!key)return origin+'/apply?source='+source;
  const expiry=Math.floor(Date.now()/1000)+7*86400,payload=contactId+'.'+expiry;
  const signature=createHmac('sha256',key).update('intake-create-v1:'+payload).digest('base64url');
  return origin+'/apply?source='+source+'&client='+encodeURIComponent(payload+'.'+signature);
}
export function resolveRegistrationLink(value,key){
  if(!value)return null;
  const match=String(value).match(/^([a-f0-9-]{36})\.(\d{10})\.([A-Za-z0-9_-]{43})$/);
  if(!match)fail(400,'رابط التسجيل غير صالح');
  const stamp=Number(match[2]),time=Math.floor(Date.now()/1000);
  if(stamp<=time||stamp>time+8*86400)fail(410,'انتهت صلاحية رابط التسجيل؛ تواصل مع الفريق للحصول على رابط جديد');
  const expected=createHmac('sha256',key).update('intake-create-v1:'+match[1]+'.'+match[2]).digest();
  const actual=Buffer.from(match[3],'base64url');
  if(actual.length!==expected.length||actual.toString('base64url')!==match[3]||!timingSafeEqual(actual,expected))fail(400,'رابط التسجيل غير صالح');
  return match[1];
}
