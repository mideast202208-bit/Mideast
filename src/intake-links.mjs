import {createHmac,timingSafeEqual} from 'node:crypto';
import {fail} from './service.mjs';

export function registrationLink(contactId,source,key,origin,enquiryId=''){
  if(!key)return origin+'/apply?source='+source;
  const expiry=Math.floor(Date.now()/1000)+7*86400,payload=contactId+'.'+expiry;
  const signature=createHmac('sha256',key).update('intake-create-v1:'+payload+(enquiryId?':'+enquiryId:'')).digest('base64url');
  return origin+'/apply?'+new URLSearchParams({source,client:payload+'.'+signature,...(enquiryId?{enquiry:enquiryId}:{})});
}
export function resolveRegistrationLink(value,key,enquiryId=''){
  if(!value&&!enquiryId)return null;
  if(enquiryId&&!/^[a-f0-9-]{36}$/.test(enquiryId))fail(400,'مرجع الاستفسار غير صالح');
  const match=String(value).match(/^([a-f0-9-]{36})\.(\d{10})\.([A-Za-z0-9_-]{43})$/);
  if(!match)fail(400,'رابط التسجيل غير صالح');
  const stamp=Number(match[2]),time=Math.floor(Date.now()/1000);
  if(stamp<=time||stamp>time+8*86400)fail(410,'انتهت صلاحية رابط التسجيل؛ تواصل مع الفريق للحصول على رابط جديد');
  const expected=createHmac('sha256',key).update('intake-create-v1:'+match[1]+'.'+match[2]+(enquiryId?':'+enquiryId:'')).digest();
  const actual=Buffer.from(match[3],'base64url');
  if(actual.length!==expected.length||actual.toString('base64url')!==match[3]||!timingSafeEqual(actual,expected))fail(400,'رابط التسجيل غير صالح');
  return match[1];
}
