import {createHmac,timingSafeEqual} from 'node:crypto';
import {fail} from './service.mjs';

export function registrationLink(contactId,source,key,origin,enquiryId='',scope=''){
  if(!key)return origin+'/apply?source='+source;
  const expiry=Math.floor(Date.now()/1000)+7*86400,payload=contactId+'.'+expiry;
  const signature=createHmac('sha256',key).update('intake-create-v1:'+payload+(enquiryId?':'+enquiryId:'')+(scope?':'+scope:'')).digest('base64url');
  return origin+'/apply?'+new URLSearchParams({source,client:payload+'.'+signature,...(enquiryId?{enquiry:enquiryId}:{}),...(scope?{scope}:{})});
}
export function resolveRegistrationLink(value,key,enquiryId='',scope=''){
  if(!value&&!enquiryId&&!scope)return null;
  if(scope&&(scope!=='whatsapp' || !enquiryId))fail(400,'نطاق رابط التسجيل غير صالح');
  if(enquiryId&&!/^[a-f0-9-]{36}$/.test(enquiryId))fail(400,'مرجع الاستفسار غير صالح');
  const match=String(value).match(/^([a-f0-9-]{36})\.(\d{10})\.([A-Za-z0-9_-]{43})$/);
  if(!match)fail(400,'رابط التسجيل غير صالح');
  const stamp=Number(match[2]),time=Math.floor(Date.now()/1000);
  if(stamp<=time||stamp>time+8*86400)fail(410,'انتهت صلاحية رابط التسجيل؛ تواصل مع الفريق للحصول على رابط جديد');
  const expected=createHmac('sha256',key).update('intake-create-v1:'+match[1]+'.'+match[2]+(enquiryId?':'+enquiryId:'')+(scope?':'+scope:'')).digest();
  const actual=Buffer.from(match[3],'base64url');
  if(actual.length!==expected.length||actual.toString('base64url')!==match[3]||!timingSafeEqual(actual,expected))fail(400,'رابط التسجيل غير صالح');
  return match[1];
}

export function whatsappRegistrationOpportunity(db,contactId,leadId){
  return db.prepare(`SELECT l.id,'whatsapp' AS source,'' AS campaign FROM leads l
    JOIN contacts c ON c.id=l.contact_id AND c.owner_id=l.owner_id
    WHERE l.id=? AND l.contact_id=? AND l.stage NOT IN('won','lost')
    AND NOT EXISTS(SELECT 1 FROM intake_registrations r WHERE r.lead_id=l.id)`).get(leadId,contactId);
}
