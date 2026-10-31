import {findPhoneNumbersInText} from 'libphonenumber-js';
// Customer contact details stay available to transports, never to a staff browser.
// This is a response projection, not a mutation of stored records or messages.
export const canViewContactDetails = user => ['admin','manager'].includes(user?.role);
export function assertSafeStaffWrite(user,value){
  if(!user||canViewContactDetails(user))return;
  if(/\[(?:بيانات اتصال محجوبة|رابط تسجيل خاص محجوب)\]/.test(JSON.stringify(value))){
    const error=new Error('لا يمكن حفظ نسخة محجوبة؛ اطلب من الإدارة مراجعة الحقل الأصلي');error.status=400;throw error;
  }
  const check=(item,stored=false,depth=0)=>{
    if(depth>40||item===null||item===undefined)return;
    if(typeof item==='string'&&stored&&/^[\[{]/.test(item.trim())){try{check(JSON.parse(item),true,depth+1);}catch(error){if(error.status)throw error;}return;}
    if(typeof item!=='object')return;
    for(const [field,v] of Object.entries(item)){
      if(stored&&sensitiveKey(field)&&(v===null||typeof v!=='object')){const error=new Error('تعديل حقول الاتصال المخصصة متاح للإدارة فقط');error.status=403;throw error;}
      check(v,stored||/^(?:custom|data|payload|values|record)$/i.test(field),depth+1);
    }
  };
  check(value);
}
const hidden = '[بيانات اتصال محجوبة]';
const digits = value => String(value).replace(/[٠-٩]/g,c=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(c))).replace(/[۰-۹]/g,c=>String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c)));
const escapeRE = value => value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const sensitiveKey = key => /(?:^|_)(?:phone|email|mobile|telephone)(?:_|$)/i.test(key)&&!/^(?:has_phone|has_email|phone_country|phone_id|phone_id_set|email_available|email_enabled|email_configured)$/i.test(key);
const privateLinkKey = key => /^(?:receipt_url|receipt_token|receipt_cipher|receipt_hash)$/i.test(key);
const opaqueKey = key => /^(?:id|csrf|hash|token|signature|uri|provider_id|media_id|account_key|thread_key|key|[a-z_]+_id)$/i.test(key);
const fileReference = value => /^(?:ME-\d{4}-[A-F0-9]{10}|ST-[A-F0-9]{12})$/.test(value);
const uuid = value => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);

export function customerTextRedactor(db){
  // Include every customer's known values: notes can mention a different customer.
  const rows=db.prepare("SELECT phone,email FROM contacts WHERE phone IS NOT NULL OR email<>''").all();
  const phones=[...new Set(rows.map(r=>digits(r.phone||'').replace(/\D/g,'')).filter(n=>n.length>=7))];
  const emails=[...new Set(rows.map(r=>(r.email||'').trim()).filter(Boolean))];
  const digitPattern=n=>n.split('').map(d=>'['+d+'٠١٢٣٤٥٦٧٨٩'[Number(d)]+'۰۱۲۳۴۵۶۷۸۹'[Number(d)]+']').join('[\\s().\\-]*');
  const knownPhones=phones.map(n=>new RegExp('\\+?'+digitPattern(n),'g'));
  const knownEmails=emails.map(e=>new RegExp(escapeRE(e),'gi'));
  return value=>{
    let result=String(value);
    const protectedReferences=[];
    result=result.replace(/\b(?:ME-\d{4}-[A-F0-9]{10}|ST-[A-F0-9]{12})\b/g,match=>{protectedReferences.push(match);return '\u0001REF'+String.fromCharCode(65+protectedReferences.length-1)+'\u0002';});
    // Bearer receipt links expose the original registration with phone + email.
    result=result.replace(/(?:https?:\/\/[^\s<>"']+)?\/receipt\/[a-f0-9]{64}/gi,'[رابط تسجيل خاص محجوب]');
    result=result.replace(/(?:mailto:)?[^\s<>"'@]+@[^\s<>"'@]+\.[^\s<>"'@]+/gi,hidden);
    for(const pattern of knownEmails)result=result.replace(pattern,hidden);
    for(const pattern of knownPhones)result=result.replace(pattern,hidden);
    // Library validation avoids treating dates, amounts and random digits as phones.
    // Normalization keeps character offsets, so unrelated Arabic digits stay intact.
    for(const match of findPhoneNumbersInText(digits(result),'EG').filter(m=>m.number.isValid()).reverse())result=result.slice(0,match.startsAt)+hidden+result.slice(match.endsAt);
    result=result.replace(/\u0001REF(.)\u0002/g,(_,letter)=>protectedReferences[letter.charCodeAt(0)-65]||'');
    return result;
  };
}

export function projectCustomerResponse(db,user,value){
  if(!user||canViewContactDetails(user))return value;
  const redact=customerTextRedactor(db);
  const knownNumbers=new Set(db.prepare('SELECT phone FROM contacts WHERE phone IS NOT NULL').all().map(r=>digits(r.phone).replace(/\D/g,'')));
  const walk=(item,key='',depth=0,stored=false)=>{
    if(depth>40)return null;
    if(item===null||item===undefined)return item;
    if(Array.isArray(item))return item.map(v=>walk(v,'',depth+1,stored));
    if(typeof item==='object'){
      const output=Object.create(null);let details=false;
      for(const [field,v] of Object.entries(item)){
        if(sensitiveKey(field)&&(v===null||typeof v!=='object')){
          // A user's own login address is not a customer's address.
          if(field==='email'&&key==='user'&&!stored&&item.id===user.id&&item.role===user.role){output[field]=v;continue;}
          output[field]=null;details=true;
          if(/email/i.test(field))output.has_email=Boolean(v)||Boolean(item.has_email);
          else output.has_phone=Boolean(v)||Boolean(item.has_phone);
        }else if(privateLinkKey(field)){output[field]=null;details=true;}
        else if(field==='download_url'){output[field]=null;output.original_file_restricted=true;}
        else output[field]=walk(v,field,depth+1,stored||/^(?:custom|data|payload|metadata|values|record)$/i.test(field));
      }
      if(details)output.contact_details_hidden=true;
      return output;
    }
    if(typeof item!=='string')return typeof item==='number'&&!opaqueKey(key)&&knownNumbers.has(String(item))?null:item;
    // Structured JSON stored as TEXT must get the same field rules as objects.
    if(/^[\[{]/.test(item.trim())){try{return JSON.stringify(walk(JSON.parse(item),'',depth+1,true));}catch{}}
    if((!stored&&opaqueKey(key))||fileReference(item)||uuid(item))return item;
    return redact(item);
  };
  return walk(value);
}
