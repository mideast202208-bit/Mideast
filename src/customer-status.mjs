import {findStudents,studentDossier} from './student-files.mjs';
import {parsePhoneNumberFromString} from 'libphonenumber-js';
import {internationalPhone,normalizeSearch} from './international.mjs';

const digits=value=>String(value||'').normalize('NFKC').replace(/[٠-٩]/g,c=>'٠١٢٣٤٥٦٧٨٩'.indexOf(c)).replace(/[۰-۹]/g,c=>'۰۱۲۳۴۵۶۷۸۹'.indexOf(c));
const normalized=value=>digits(value).toUpperCase();
const oneLine=value=>String(value||'').replace(/https?:\/\/\S+/gi,'').replace(/\s+/g,' ').trim().slice(0,160);
const denied='لا يمكن عرض ملف غير مرتبط برقم واتساب المرسل أو ببيانات لا تطابقه. أرسل بياناتك أنت فقط، أو تواصل مع الموظف المسؤول لمراجعة الربط؛ لن نشارك مستندات أو بيانات أشخاص آخرين.';
const noFile='لا يوجد ملف طالب مرتبط بهذا الرقم حاليًا. تواصل مع الفريق أو أكمل نموذج التسجيل؛ لن يُنشأ مستند أو قبول من هذه الرسالة.';
const states=new Set(['استكمال البيانات','جمع المستندات','جاهز للتقديم','تم التقديم','قبول مبدئي','قبول نهائي','مغلق']);
export const whatsappLookupPrompt='أهلًا بك في ميدل إيست للخدمات التعليمية. لمراجعة طلبك، اكتب اسم الطالب أو رقم الهاتف المسجل أو رقم الملف في رسالة واحدة. سنعرض بيانات الملف المرتبط برقم واتساب الذي تراسلنا منه فقط. إذا كان الرقم مرتبطًا بأكثر من طالب، أرسل رقم الملف المحدد.';
const namePrefix=/^(?:(?:أنا|انا)\s+)?(?:اسمي|اسم\s+الطالب|الاسم|my\s+name\s+is|name)\s*[:：-]?\s*/i;
const phonePrefix=/^(?:رقمي|رقم\s+(?:هاتفي|تليفوني|الهاتف|التليفون|الجوال|الموبايل)|هاتفي|تليفوني|phone|mobile)\s*[:：-]?\s*/i;
const greeting=value=>/^(?:السلامعليكم(?:ورحمةالله(?:وبركاته)?)?|وعليكمالسلام|مرحبا|مرحباً|اهلا|اهلابكم|اهلابك|صباحالخير|مساءالخير|hello|hi|hey|help|مساعده|مساعدة|ابدا|ابدأ|القائمه|القائمة)$/.test(normalizeSearch(value));
const thanks=value=>/^(?:شكرا|شكرالك|تمام|حاضر|ماشي|thankyou|thanks|ok)$/.test(normalizeSearch(value));
const humanIntent=value=>/(?:موظف|موظفه|خدمهالعملاء|المسؤول|human|agent|support)/.test(normalizeSearch(value));
const genericReferenceText=value=>/^(?:ملف|ملفي|رقمالملف|حاله|حالتي|حالهملف|حالهملفي|طلب|طلبي|رقمالطلب|حالهالطلب|حالهطلبي|متابعه|متابعهطلبي|متابعهالطلب|status|file|application|request|requeststatus)$/.test(normalizeSearch(value));
const statusIntent=value=>/ملف|حالة|طلب|مستند|متابع|بياناتي|اسمي|\bstatus\b|\bfile\b|\bapplication\b/i.test(String(value||''));
const result=(body,kind,extra={})=>({body,kind,...extra});

// Only the latest outbound on this exact company account can represent an active prompt.
// A staff reply, another number, failure or expiry never keeps a hidden lookup session alive.
function promptState(db,{conversationId,phoneId,at=Date.now()}={}){
 if(!conversationId||!phoneId)return {awaiting:false,recent:false};
 const row=db.prepare(`SELECT m.id,m.created_at,m.status,EXISTS(SELECT 1 FROM audit a WHERE a.entity='message' AND a.entity_id=m.id AND a.action='auto_lookup_prompt') prompted,EXISTS(SELECT 1 FROM audit a WHERE a.entity='message' AND a.entity_id=m.id AND a.action IN('auto_lookup_denied','auto_lookup_not_found')) feedback
 FROM messages m LEFT JOIN message_accounts ma ON ma.message_id=m.id WHERE m.conversation_id=? AND m.direction='out' AND COALESCE(ma.phone_id,?)=? ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1`).get(conversationId,String(phoneId),String(phoneId));
 const age=row?at-Date.parse(row.created_at):NaN,valid=Boolean(row&&!['failed','blocked','unknown'].includes(row.status)&&age>=0&&age<86400000);
 // A request for a staff member ends this prompt's conversation. Derive that
 // from persisted, same-account inbound history so a restart cannot revive it.
 const handedOff=Boolean(row?.prompted&&valid&&db.prepare(`SELECT m.body FROM messages m LEFT JOIN message_accounts ma ON ma.message_id=m.id
 WHERE m.conversation_id=? AND m.direction='in' AND COALESCE(ma.phone_id,?)=? AND m.rowid>(SELECT rowid FROM messages WHERE id=?)`).all(conversationId,String(phoneId),String(phoneId),row.id).some(message=>humanIntent(message.body)));
 const awaiting=Boolean(row?.prompted&&valid&&!handedOff);
 return {awaiting,recent:Boolean(valid&&(row.prompted||row.feedback)&&age<120000)};
}
function storedFields(db,actor,studentId,dossier){
 const student=db.prepare("SELECT data FROM app_records WHERE id=? AND owner_id=? AND EXISTS(SELECT 1 FROM studio_apps app WHERE app.id=app_records.app_id AND app.app_key='me_students')").get(studentId,actor.id);
 let studentData={};try{studentData=JSON.parse(student?.data||'{}');}catch{}
 const latest=dossier.latest_registration;
 const admission=latest?db.prepare(`SELECT a.data FROM app_records a JOIN studio_apps app ON app.id=a.app_id AND app.app_key='me_admissions'
 JOIN intake_registrations r ON r.admission_id=a.id AND r.student_id=? AND r.contact_id=? WHERE a.id=? AND a.owner_id=?`).get(studentId,dossier.contact_id,latest.admission_id,actor.id):null;
 let data={};try{data=JSON.parse(admission?.data||'{}');}catch{}
 if(data.student!==studentId||studentData.guardian!==dossier.contact_id)return [];
 return [['الجامعة المطلوبة',data.university],['الكلية أو التخصص المطلوب',data.faculty],['المرحلة الدراسية',data.level],['سنة التقديم',studentData.academic_year],['الخدمة المطلوبة',data.requested_service]].filter(([,value])=>typeof value==='string'&&oneLine(value)).map(([label,value])=>label+': '+oneLine(value));
}

// Never performs a global lookup. The signed inbound sender and assigned owner scope
// every identifier and every form field, even if the message contains someone else's data.
export function whatsappLookupReply(db,contact,senderPhone,body,context={}){
 if(!contact?.id||!contact.phone||senderPhone!==contact.phone)return null;
 const owner=db.prepare("SELECT id FROM users WHERE id=? AND active=1 AND role IN('admin','manager','agent')").get(contact.owner_id);
 if(!owner)return null;
 const actor={id:owner.id,role:'agent'},students=findStudents(db,actor,'',contact.id),raw=digits(body).trim(),query=normalized(raw),pending=promptState(db,context);
 const referenceTokens=query.match(/\b(?:ME|ST)-[A-Z0-9_-]*/g)||[],validReference=value=>/^(?:ME-\d{4}-[A-Z0-9]{6,32}|ST-[A-F0-9]{12})$/.test(value);
 const references=referenceTokens.filter(validReference),referenceLike=referenceTokens.length>0;
 // Remove complete reference tokens before checking another supplied identity. Any
 // leftover national phone/name must agree too; a valid owned reference cannot mask it.
 const remainder=raw.replace(/\b(?:ME|ST)-[A-Z0-9_-]*/gi,' ').replace(/^[\s:：,،;؛.!?؟-]+|[\s:：,،;؛.!?؟-]+$/g,'').trim();
 const phoneText=remainder.replace(phonePrefix,'').trim(),phoneLike=/^[+\d\s().-]{7,45}$/.test(phoneText),explicitName=namePrefix.test(remainder),nameText=remainder.replace(namePrefix,'').trim();
 const knownName=students.some(s=>normalizeSearch(s.name)===normalizeSearch(nameText));
 const identity=referenceLike||phoneLike||explicitName||knownName,intent=identity||statusIntent(raw),hello=greeting(raw);
 if(humanIntent(raw)||thanks(raw))return null;
 if(!students.length){
  if(identity)return result(noFile,'not_found',{registration:true});
  if((context.firstInbound||hello||intent)&&!pending.recent)return result(whatsappLookupPrompt,'prompt',{registration:true});
  if(pending.awaiting&&!hello)return result(noFile,'not_found',{registration:true});
  return null;
 }
 if(referenceTokens.some(t=>!validReference(t)))return result(denied,'denied');
 let ownPhone=false;
 if(phoneLike){try{const country=parsePhoneNumberFromString(contact.phone)?.country||'EG';ownPhone=internationalPhone(phoneText,country)===contact.phone;}catch{}if(!ownPhone)return result(denied,'denied');}
 // An explicitly supplied international phone must also agree with the sender, including
 // when an otherwise valid reference occurs in the same message.
 const explicitPhones=remainder.match(/(?<!\d)(?:\+|00)[1-9]\d[\d\s().-]{4,25}\d/g)||[];
 for(const phone of explicitPhones){try{if(internationalPhone(phone.trim(),parsePhoneNumberFromString(contact.phone)?.country||'EG')!==contact.phone)return result(denied,'denied');}catch{return result(denied,'denied');}}
 if(explicitName&&!knownName)return result(denied,'denied');
 if(referenceLike&&!references.length)return result(denied,'denied');
 if(references.length&&remainder&&!ownPhone&&!knownName&&!genericReferenceText(remainder))return result(denied,'denied');
 if(!intent){
  if(hello)return pending.recent?null:result(whatsappLookupPrompt,'prompt');
  if(context.firstInbound&&!pending.recent&&!thanks(raw))return result(whatsappLookupPrompt,'prompt');
  if(pending.awaiting&&!thanks(raw))return result('لم أجد تطابقًا مع البيانات المرسلة ضمن ملفات هذا الرقم. أرسل رقم الملف المسجل أو تواصل مع الموظف المسؤول لمراجعة الربط.','denied');
  return null;
 }
 if(!references.length&&!ownPhone&&!knownName){return pending.recent?null:result(whatsappLookupPrompt,'prompt');}
 let selected;
 if(references.length){const unique=[...new Set(references)];if(unique.length!==1)return result('اكتب رقم ملف واحد فقط لمراجعة حالته.','prompt');selected=students.find(s=>normalized(s.reference)===unique[0]);if(!selected)return result(denied,'denied');}
 else if(students.length===1)selected=students[0];
 else return result('هذا الرقم مرتبط بأكثر من ملف طالب. أرسل رقم الملف المحدد فقط؛ الاسم وحده لا يحدد الملف ولن نختار ملفًا نيابة عنك.','prompt');
 if(knownName&&normalizeSearch(selected.name)!==normalizeSearch(nameText))return result(denied,'denied');
 const dossier=studentDossier(db,actor,selected.id),saved=dossier.latest_registration?.registration_status;
 const state=states.has(saved)?saved:'تحتاج مراجعة الموظف المسؤول';
 const received=dossier.checklist.filter(d=>d.count>0).map(d=>d.label),missing=dossier.checklist.filter(d=>!d.count).map(d=>d.label);
 return result(['الطالب: '+oneLine(dossier.name),'رقم الملف: '+dossier.reference,'الحالة المسجلة بالنظام: '+state,...storedFields(db,actor,selected.id,dossier),'تصنيفات مستندات مستلمة: '+(received.join('، ')||'لم تُسجل بعد'),'تصنيفات بدون ملفات مرفوعة: '+(missing.join('، ')||'لا توجد تصنيفات فارغة ضمن الفهرس الحالي'),'هذا فهرس تصنيف واستلام وليس قائمة متطلبات نهائية؛ المطلوب النهائي يحدده الفريق حسب حالتك. هذه إفادة بالحالة المسجلة وليست قرار قبول جديدًا.'].join('\n'),'status');
}
export function whatsappStatusReply(db,contact,senderPhone,body){return whatsappLookupReply(db,contact,senderPhone,body)?.body||null;}
