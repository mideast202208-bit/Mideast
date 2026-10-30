import { transaction } from './db.mjs';
import { uid,now,fail,text,audit,runAutomations,getContact,manager } from './service.mjs';
import { token,hash,normalizePhone } from './security.mjs';
import { encryptSecret,decryptSecret } from './integration-settings.mjs';
import { intakeSettings,intakeOwner,channelNames } from './omni-config.mjs';
import { validateAppData } from './studio.mjs';
import { queueMessage } from './whatsapp.mjs';
import { resolveRegistrationLink } from './intake-links.mjs';

export const intakeLimits=Object.freeze({maxFiles:12,maxFileMB:5,maxTotalMB:25,maxBodyMB:36});

const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function cleanIntake(input){
  if(input.company_url)fail(400,'تعذر إرسال النموذج');
  if(input.consent!==true)fail(400,'الموافقة على معالجة الطلب مطلوبة');
  const name=text(input.name,'اسم الطالب',160);
  let phone=text(input.phone,'رقم الهاتف',40).replace(/[٠-٩]/g,d=>'٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[۰-۹]/g,d=>'۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[\s()\-]/g,'');
  if(/^01[0125]\d{8}$/.test(phone))phone='+20'+phone.slice(1);
  phone=normalizePhone(phone);
  const email=text(input.email||'','البريد',254,false).toLowerCase();
  if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fail(400,'بريد غير صالح');
  const source=['website','facebook','instagram','whatsapp','api'].includes(input.source)?input.source:'website';
  const nonAcademic=input.level==='غير دراسي';
  const requested_service=text(input.requested_service||'','الخدمة المطلوبة',200,false);
  const certificate=text(input.certificate||(nonAcademic?'أخرى':''),'نوع الشهادة',80);
  if(!['ثانوي سوداني','IGCSE','دبلومة أمريكية','شهادة عربية','أخرى'].includes(certificate))fail(400,'شهادة غير متاحة');
  const academic_year=text(input.academic_year||(nonAcademic?String(new Date().getFullYear()):''),'سنة التقديم',9);
  if(!/^\d{4}(?:\/\d{4})?$/.test(academic_year))fail(400,'أدخل سنة تقديم صحيحة');
  const level=input.level||'بكالوريوس';if(!['بكالوريوس','ماجستير','دكتوراه','غير دراسي'].includes(level))fail(400,'مرحلة دراسية غير صالحة');
  const result={name,phone,email,source,certificate,academic_year,level,nationality:text(input.nationality||'','الجنسية',80,false),university:text(input.university||'أحتاج استشارة','الجامعة',160),faculty:text(input.faculty||'أحتاج استشارة','التخصص',160),notes:text(input.notes||'','الملاحظات',2000,false),campaign:text(input.campaign||'','الحملة',150,false),whatsapp_opt_in:input.whatsapp_opt_in===true};
  if(!/^[A-Za-z0-9_-]{16,128}$/.test(input.request_key||''))fail(400,'مفتاح الطلب غير صالح؛ أعد فتح النموذج');
  return {...result,...(requested_service?{requested_service}:{}),request_key:input.request_key,...(input.link_token?{link_token:text(input.link_token,'رابط التسجيل',200)}:{})};
}
function intakeFiles(files=[]){
  if(!Array.isArray(files)||files.length>intakeLimits.maxFiles)fail(400,'بحد أقصى 12 مستندًا');
  let total=0;
  return files.map(f=>{
    if(!f||typeof f.content!=='string'||f.content.length>7*1024*1024||!/^[A-Za-z0-9+/]*={0,2}$/.test(f.content))fail(400,'ملف غير صالح');
    const bytes=Buffer.from(f.content,'base64');total+=bytes.length;
    if(!bytes.length||bytes.length>intakeLimits.maxFileMB*1024*1024||total>intakeLimits.maxTotalMB*1024*1024)fail(413,'حد كل ملف 5 ميجابايت والمجموع 25 ميجابايت');
    const mime=f.mime;
    if(!(mime==='application/pdf'&&bytes.subarray(0,5).toString()==='%PDF-')&&
      !(mime==='image/jpeg'&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)&&
      !(mime==='image/png'&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))))fail(400,'مسموح PDF وJPG وPNG حقيقي فقط');
    return {name:text(f.name,'اسم الملف',160),mime,bytes};
  });
}
export function registrationFile(record,input){
  const rows=[...(input.requested_service?[['الخدمة المطلوبة',input.requested_service]]:[]),['رقم التسجيل',record.reference],['اسم الطالب',input.name],['الهاتف',input.phone],['البريد',input.email||'غير مذكور'],['المصدر',channelNames[input.source]||input.source],['الجنسية',input.nationality],['الشهادة',input.certificate],['سنة التقديم',input.academic_year],['المرحلة',input.level],['الجامعة المطلوبة',input.university],['التخصص المطلوب',input.faculty]];
  return '<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Middle East · '+esc(record.reference)+'</title><style>body{font:16px/1.8 Tahoma,Arial;max-width:850px;margin:40px auto;padding:25px;color:#132b39}header{border-bottom:4px solid #189d8a;padding:20px 0}small{color:#5e7480}dl{display:grid;grid-template-columns:180px 1fr}dt,dd{margin:0;padding:12px;border-bottom:1px solid #eee}dt{font-weight:bold}footer{background:#edf6f4;padding:20px;margin-top:25px}button{background:#102e39;color:white;padding:14px;border:0;border-radius:8px}@media print{button{display:none}body{margin:0}}</style><header><small>MIDDLE EAST · STUDENT SERVICES</small><h1>ملف التسجيل واستلام الطلب</h1><p>'+esc(record.reference)+' · '+esc(new Date(record.created_at).toLocaleDateString('ar-EG'))+'</p></header><dl>'+rows.map(([k,v])=>'<dt>'+esc(k)+'</dt><dd>'+esc(v)+'</dd>').join('')+'</dl><h3>الخطوة التالية</h3><p>فريق ميد إيست هيراجع بياناتك والمستندات، ويتواصل معك لتحديد الخطوات والرسوم المناسبة لطلبك.</p><p>جهّز جواز السفر، الشهادة الدراسية، كشف الدرجات وصورة شخصية حسب متطلبات الجهة المختصة.</p><footer>استلام التسجيل لا يعني قبولًا جامعيًا أو اعتمادًا للمستندات أو سداد رسوم. الملف صادر من Middle East للخدمات التعليمية.<br>واتساب المكتب: +20 11 30343708</footer></html>';
}
export function createRegistration(db,input,key,origin){
  const settings=intakeSettings(db);if(!settings.enabled)fail(503,'التسجيل متوقف مؤقتًا');
  const clean=cleanIntake(input),files=intakeFiles(input.files);
  const fingerprint=hash(JSON.stringify({...clean,files:files.map(f=>({name:f.name,sha:hash(f.bytes)}))}));
  const duplicate=db.prepare('SELECT * FROM intake_registrations WHERE request_key=?').get(clean.request_key);
  if(duplicate){if(duplicate.fingerprint!==fingerprint)fail(409,'مفتاح الطلب استُخدم لبيانات مختلفة');return receiptResult(duplicate,key,origin,true);}
  const owner=intakeOwner(db);if(!owner)fail(503,'لا يوجد موظف استقبال متاح');
  const apps=Object.fromEntries(db.prepare("SELECT app_key,id FROM studio_apps WHERE app_key IN('me_students','me_admissions','me_documents')").all().map(a=>[a.app_key,a.id]));
  if(!apps.me_students||!apps.me_admissions||!apps.me_documents)fail(503,'تطبيقات الطلاب غير مجهزة');
  const record={id:uid(),reference:'ME-'+new Date().getUTCFullYear()+'-'+token().slice(0,10).toUpperCase(),created_at:now()};
  const receipt=token(),fileId=uid(),studentId=uid(),admissionId=uid();let leadId=uid();
  transaction(db,()=>{
    const linkedId=resolveRegistrationLink(clean.link_token,key);
    const linked=linkedId?db.prepare('SELECT * FROM contacts WHERE id=?').get(linkedId):null;
    if(linkedId&&!linked)fail(400,'رابط العميل غير متاح');
    const byPhone=db.prepare('SELECT * FROM contacts WHERE phone=?').get(clean.phone);
    if(linked&&((linked.phone&&linked.phone!==clean.phone)||(byPhone&&byPhone.id!==linked.id)))fail(409,'الرقم مرتبط بملف مختلف؛ تواصل مع الفريق لمراجعة ربط الحساب');
    let contact=linked||byPhone,created=!contact;
    if(!contact){
      contact={id:uid(),name:clean.name,phone:clean.phone,email:clean.email,owner_id:owner.id,source:clean.source};
      db.prepare('INSERT INTO contacts VALUES(?,?,?,?,?,?,?,?,?)').run(contact.id,contact.name,contact.phone,contact.email,clean.source,owner.id,'{}',now(),now());
      runAutomations(db,'contact.created',contact,contact.id);
    }
    if(linked&&!linked.phone){db.prepare("UPDATE contacts SET phone=?,email=CASE WHEN email='' THEN ? ELSE email END,updated_at=? WHERE id=?").run(clean.phone,clean.email,now(),linked.id);}
    const assigned=db.prepare("SELECT * FROM users WHERE id=? AND active=1 AND role IN('admin','manager','agent')").get(contact.owner_id);
    if(!assigned)fail(409,'ملف الرقم يحتاج مراجعة إسناد من الإدارة');
    const actor={...assigned,role:'admin'};
    const student=validateAppData(db,actor,apps.me_students,{guardian:contact.id,certificate:clean.certificate,academic_year:clean.academic_year,nationality:clean.nationality,notes:[clean.requested_service?'الخدمة المطلوبة: '+clean.requested_service:'',clean.notes].filter(Boolean).join('\n')});
    db.prepare('INSERT INTO app_records VALUES(?,?,?,?,?,?,?)').run(studentId,apps.me_students,clean.name,assigned.id,student,now(),now());
    const admission=validateAppData(db,actor,apps.me_admissions,{student:studentId,reference:record.reference,university:clean.university,faculty:clean.faculty,level:clean.level,application_status:'استكمال البيانات',...(clean.requested_service?{requested_service:clean.requested_service}:{})});
    db.prepare('INSERT INTO app_records VALUES(?,?,?,?,?,?,?)').run(admissionId,apps.me_admissions,record.reference+' · '+clean.name,assigned.id,admission,now(),now());
    const existingEnquiry=db.prepare("SELECT id FROM leads WHERE contact_id=? AND stage NOT IN('won','lost') AND title LIKE 'استفسار%' ORDER BY created_at DESC LIMIT 1").get(contact.id);
    if(existingEnquiry){leadId=existingEnquiry.id;}else{
      const lead={id:leadId,contact_id:contact.id,title:(clean.requested_service||clean.level)+' · '+clean.name,stage:'new',owner_id:assigned.id};
      db.prepare('INSERT INTO leads VALUES(?,?,?,?,?,?,?,?,?)').run(leadId,contact.id,lead.title,'new',0,assigned.id,'{}',now(),now());
      runAutomations(db,'lead.created',lead,leadId);
    }
    db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?)').run(uid(),contact.id,leadId,'مراجعة التسجيل '+record.reference,new Date(Date.now()+2*3600000).toISOString(),'open',assigned.id,now());
    db.prepare('INSERT INTO attachments VALUES(?,?,?,?,?,?,?)').run(fileId,contact.id,null,'registration-'+record.reference+'.html','text/html',Buffer.from(registrationFile(record,clean)),now());
    const indexDocument=(name,attachmentId)=>{
      const values=validateAppData(db,actor,apps.me_documents,{student:studentId,application:admissionId,document_type:'مستند آخر',document_status:'صورة مستلمة',received_date:now().slice(0,10),file_reference:attachmentId});
      db.prepare('INSERT INTO app_records VALUES(?,?,?,?,?,?,?)').run(uid(),apps.me_documents,name,assigned.id,values,now(),now());
    };
    indexDocument('ملف التسجيل '+record.reference,fileId);
    for(const file of files){
      const attachmentId=uid();db.prepare('INSERT INTO attachments VALUES(?,?,?,?,?,?,?)').run(attachmentId,contact.id,null,file.name,file.mime,file.bytes,now());
      indexDocument(file.name,attachmentId);
    }
    if(clean.whatsapp_opt_in)db.prepare('INSERT INTO contact_preferences VALUES(?,1,?) ON CONFLICT(contact_id) DO UPDATE SET whatsapp_opt_in=1,updated_at=excluded.updated_at').run(contact.id,now());
    const delivery=clean.whatsapp_opt_in?'pending':'not_requested';
    db.prepare('INSERT INTO intake_registrations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(record.id,record.reference,clean.request_key,fingerprint,contact.id,leadId,studentId,admissionId,clean.source,clean.campaign,hash(receipt),encryptSecret(receipt,key),fileId,delivery,null,null,record.created_at);
    audit(db,null,'registered','intake',record.id,{source:clean.source,contact_created:created,files:files.length});
  });
  return receiptResult(db.prepare('SELECT * FROM intake_registrations WHERE id=?').get(record.id),key,origin,false);
}
function receiptResult(row,key,origin,replayed){
  const receipt=decryptSecret(row.receipt_cipher,key);
  return {reference:row.reference,receipt_url:origin+'/receipt/'+receipt,replayed,delivery_status:row.delivery_status};
}
export function receiptByToken(db,value){
  if(!/^[a-f0-9]{64}$/.test(value||''))fail(404,'الملف غير متاح');
  const row=db.prepare('SELECT r.*,a.content FROM intake_registrations r JOIN attachments a ON a.id=r.file_id WHERE r.receipt_hash=?').get(hash(value));
  if(!row)fail(404,'الملف غير متاح');return row;
}
export function listRegistrations(db,user){
  if(user.role==='accountant')fail(403,'سجل التسجيلات لفريق العملاء');
  return db.prepare('SELECT r.id,r.reference,r.contact_id,r.lead_id,r.student_id,r.admission_id,r.source,r.campaign,r.file_id,r.delivery_status,r.delivery_reason,r.created_at,json_extract(a.data,?) AS requested_service,c.name,c.phone,c.owner_id,m.status AS message_status FROM intake_registrations r JOIN contacts c ON c.id=r.contact_id JOIN app_records a ON a.id=r.admission_id LEFT JOIN messages m ON m.id=r.message_id'+(manager(user)?'':' WHERE c.owner_id=?')+' ORDER BY r.created_at DESC LIMIT 500').all('$.requested_service',...(manager(user)?[]:[user.id]));
}
export function registrationFiles(db,user,id){
  if(user.role==='accountant')fail(403,'الملفات لفريق العملاء');
  const row=db.prepare('SELECT contact_id,admission_id FROM intake_registrations WHERE id=?').get(id);
  if(!row)fail(404,'التسجيل غير متاح');getContact(db,user,row.contact_id);
  return db.prepare(`SELECT a.id,a.name,a.mime,length(a.content) AS size FROM app_records d
    JOIN studio_apps s ON s.id=d.app_id JOIN attachments a ON a.id=json_extract(d.data,'$.file_reference')
    WHERE s.app_key='me_documents' AND json_extract(d.data,'$.application')=? AND a.contact_id=? ORDER BY a.created_at,a.name`).all(row.admission_id,row.contact_id);
}
export async function processIntakeDelivery(db,config,key,origin){
  const row=db.prepare("SELECT * FROM intake_registrations WHERE delivery_status='pending' ORDER BY created_at LIMIT 1").get();if(!row)return;
  const block=reason=>db.prepare("UPDATE intake_registrations SET delivery_status='blocked',delivery_reason=? WHERE id=?").run(reason,row.id);
  const preference=db.prepare('SELECT whatsapp_opt_in FROM contact_preferences WHERE contact_id=?').get(row.contact_id);
  if(!preference?.whatsapp_opt_in){block('CONSENT_REQUIRED');return;}
  const settings=intakeSettings(db),template=db.prepare('SELECT * FROM wa_templates WHERE name=? AND language=?').get(settings.welcome_template||'',settings.welcome_language||'ar');
  if(!config.accessToken||!config.phoneId||!config.version){block('WHATSAPP_NOT_CONFIGURED');return;}
  if(template?.status==='PENDING'){
    db.prepare("UPDATE intake_registrations SET delivery_reason='TEMPLATE_REVIEW_PENDING' WHERE id=?").run(row.id);return;
  }
  if(!template||template.status!=='APPROVED'){block('APPROVED_TEMPLATE_REQUIRED');return;}
  const components=JSON.parse(template.components),body=components.find(c=>c.type==='BODY');
  if(components.some(c=>c.type==='HEADER'&&['IMAGE','VIDEO','DOCUMENT'].includes(c.format))||components.some(c=>c.type==='BUTTONS'&&c.buttons?.some(b=>/\{\{/.test(b.url||'')))){block('TEMPLATE_NEEDS_OTHER_COMPONENTS');return;}
  const variables=[...new Set((body?.text||'').match(/\{\{\d+\}\}/g)||[])];
  const slots=settings.welcome_slots||[];
  if(variables.length!==slots.length||variables.some((v,i)=>!variables.includes('{{'+(i+1)+'}}'))){block('TEMPLATE_VARIABLES_MISMATCH');return;}
  const contact=db.prepare('SELECT * FROM contacts WHERE id=?').get(row.contact_id);
  let conversation=db.prepare('SELECT * FROM conversations WHERE contact_id=?').get(contact.id);
  if(!conversation){conversation={id:uid(),contact_id:contact.id,last_inbound:null};db.prepare('INSERT INTO conversations(id,contact_id,created_at) VALUES(?,?,?)').run(conversation.id,contact.id,now());}
  try{
    const values={name:db.prepare('SELECT name FROM app_records WHERE id=?').get(row.student_id).name,reference:row.reference,receipt_url:origin+'/receipt/'+decryptSecret(row.receipt_cipher,key)};
    const result=queueMessage(db,{id:contact.owner_id},conversation,{kind:'template',template_name:template.name,language:template.language,components:slots.length?[{type:'body',parameters:slots.map(s=>({type:'text',text:values[s]}))}]:[]},config);
    db.prepare("UPDATE intake_registrations SET delivery_status='queued',delivery_reason=NULL,message_id=? WHERE id=?").run(result.id,row.id);
  }catch{block('QUEUE_REJECTED');}
}
