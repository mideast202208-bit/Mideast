import nodemailer from 'nodemailer';
import {windowOpen} from './security.mjs';
import {accountWindow} from './whatsapp.mjs';
import {uid,now,fail,text,manager,getContact,audit} from './service.mjs';
import {transaction} from './db.mjs';
import {accountSummary} from './accounts.mjs';
import {encryptSecret,decryptSecret} from './integration-settings.mjs';

const smtpHosts=new Set(['smtp.gmail.com','smtp.office365.com','smtp-mail.outlook.com','smtp.zoho.com','smtp.zoho.eu','smtp-relay.brevo.com']);
const address=value=>typeof value==='string'&&value.length<=254&&/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(value);
const activeMail=new WeakSet();
function mailConfig(db,key){const row=db.prepare("SELECT value FROM settings WHERE key='email.smtp'").get();if(!row)return null;try{return JSON.parse(decryptSecret(row.value,key));}catch{return null;}}
const configured=c=>Boolean(c?.verified_at&&c?.pass&&address(c?.from)&&smtpHosts.has(c?.host)&&[465,587].includes(c?.port));
function transportOptions(c){return {host:c.host,port:c.port,secure:c.port===465,requireTLS:true,auth:{user:c.user,pass:c.pass},tls:{rejectUnauthorized:true,minVersion:'TLSv1.2'},connectionTimeout:10000,greetingTimeout:10000,socketTimeout:20000,disableFileAccess:true,disableUrlAccess:true,maxRecipients:1,logger:false,debug:false};}
const makeTransport=(c,factory)=>factory?factory(transportOptions(c)):nodemailer.createTransport(transportOptions(c));
function mailSettingsSummary(db,user,key){
 if(!manager(user))fail(403,'إعداد بريد الشركة للإدارة');const c=mailConfig(db,key);return {configured:configured(c),host:c?.host||'',port:c?.port||465,user:c?.user||'',from:c?.from||'',password_set:Boolean(c?.pass),verified_at:c?.verified_at||null,allowed_hosts:[...smtpHosts],transport_security:'TLS_REQUIRED'};
}
function saveMailSettings(db,user,input,key){
 if(user.role!=='admin')fail(403,'إعداد بريد الشركة للمالك');const old=mailConfig(db,key)||{};
 const c={host:String(input.host||old.host||'').trim().toLowerCase(),port:Number(input.port||old.port||465),user:text(input.user??old.user??'','حساب البريد',254),from:text(input.from??old.from??'','بريد الإرسال',254).toLowerCase(),verified_at:null};
 // An address can be saved as a disabled draft. Never reuse another account's password.
 const sameAccount=c.host===old.host&&c.user===old.user;
 c.pass=input.password?text(input.password,'كلمة مرور التطبيق',500):(sameAccount?old.pass:undefined);
 if(!smtpHosts.has(c.host)||![465,587].includes(c.port)||!address(c.from)||/[\r\n]/.test(c.user))fail(400,'اختر خادم بريد مدعومًا وحسابًا وبريد إرسال صالحين');
 db.prepare("INSERT INTO settings VALUES('email.smtp',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(encryptSecret(JSON.stringify(c),key));audit(db,user,'configured','email','company',{verified:false});return mailSettingsSummary(db,user,key);
}
export function recoverCustomerEmailJobs(db){db.prepare("UPDATE customer_email_jobs SET status='unknown',error_code='RESTART_DURING_SEND',updated_at=? WHERE status='sending'").run(now());}

export function customerActivity(db,user,id){
 getContact(db,user,id);if(user.role==='accountant')fail(403,'المتابعة لفريق العملاء');
 const notes=db.prepare('SELECT n.id,n.body,n.created_at,u.name AS author FROM customer_notes n JOIN users u ON u.id=n.created_by WHERE n.contact_id=? ORDER BY n.created_at DESC,n.rowid DESC LIMIT 100').all(id);
 const events=db.prepare(`SELECT a.id,a.user_id,a.action,a.entity,a.metadata,a.created_at,u.name author FROM audit a LEFT JOIN users u ON u.id=a.user_id WHERE
 (a.entity='contact' AND a.entity_id=?) OR
 (a.entity='lead' AND a.entity_id IN(SELECT id FROM leads WHERE contact_id=?)) OR
 (a.entity='task' AND a.entity_id IN(SELECT id FROM tasks WHERE contact_id=?)) OR
 (a.entity='ticket' AND a.entity_id IN(SELECT id FROM tickets WHERE contact_id=?)) OR
 (a.entity='message' AND a.entity_id IN(SELECT m.id FROM messages m JOIN conversations v ON v.id=m.conversation_id WHERE v.contact_id=?)) OR
 (a.entity='social_message' AND a.entity_id IN(SELECT m.id FROM social_messages m JOIN social_threads t ON t.id=m.thread_id WHERE t.contact_id=?)) OR
 (a.entity='customer_email' AND a.entity_id IN(SELECT id FROM customer_email_jobs WHERE contact_id=?)) OR
 (a.entity='attachment' AND a.entity_id IN(SELECT id FROM attachments WHERE contact_id=?)) OR
 (a.entity IN('app_record','student_document') AND a.entity_id IN(SELECT r.id FROM app_records r WHERE json_extract(r.data,'$.guardian')=? OR json_extract(r.data,'$.student') IN(SELECT id FROM app_records WHERE json_extract(data,'$.guardian')=?)))
 OR (a.entity='intake' AND a.entity_id IN(SELECT id FROM intake_registrations WHERE contact_id=?))
OR (a.entity IN('communication_thread','student_conversation') AND (a.entity_id IN(SELECT 'social:'||id FROM social_threads WHERE contact_id=?) OR EXISTS(SELECT 1 FROM conversations v WHERE v.contact_id=? AND a.entity_id LIKE 'whatsapp:'||v.id||':%')))
ORDER BY a.created_at DESC,a.rowid DESC LIMIT 150`).all(id,id,id,id,id,id,id,id,id,id,id,id,id);
 const labels={created:'إنشاء سجل',updated:'تحديث سجل',noted:'إضافة ملاحظة',queued:'تجهيز رسالة للإرسال',accepted:'قبل مزود البريد الرسالة',error:'تعذر إرسال البريد',unknown:'نتيجة إرسال البريد تحتاج مراجعة',downloaded:'تنزيل مستند',viewed:'فتح ملف العميل',inbound_created:'إنشاء فرصة من رسالة واردة',whatsapp_created:'استقبال عميل من واتساب',registered:'تسجيل طلب',auto_status:'رد آلي بحالة الملف'};
 const timeline=events.filter(e=>e.action!=='noted').map(e=>{let metadata={};try{metadata=JSON.parse(e.metadata);}catch{}return {id:e.id,kind:e.entity,action:e.action,label:labels[e.action]||e.action,author:e.author||'النظام',actor_kind:e.user_id?'employee':'system',created_at:e.created_at,stage:metadata.stage||null};});
 for(const n of notes)timeline.push({...n,kind:'note',action:'noted',label:'ملاحظة متابعة',actor_kind:'employee'});
 timeline.sort((a,b)=>b.created_at.localeCompare(a.created_at)||b.id.localeCompare(a.id));
 const emails=db.prepare('SELECT id,subject,status,error_code,created_at,updated_at FROM customer_email_jobs WHERE contact_id=? ORDER BY created_at DESC LIMIT 50').all(id);
 return {notes,timeline,last_staff_activity:timeline.find(e=>e.actor_kind==='employee'&&e.action!=='viewed')||null,last_activity:timeline.find(e=>e.action!=='viewed')||timeline[0]||null,email_history:emails};
}

export function customerWorkspace(db,user,id,config,origin,key){
 const contact=getContact(db,user,id);if(user.role==='accountant')fail(403,'التواصل لفريق العملاء');
 const accounts=accountSummary(db,config,origin).filter(a=>a.active);
 const choices=[];
 const conversation=db.prepare('SELECT * FROM conversations WHERE contact_id=?').get(id);
 const optIn=Boolean(db.prepare('SELECT whatsapp_opt_in FROM contact_preferences WHERE contact_id=?').get(id)?.whatsapp_opt_in);
 for(const a of accounts.filter(a=>a.channel==='whatsapp')){
  const inbound=conversation?accountWindow(db,conversation,a.account_id):null;
  const known=conversation&&db.prepare('SELECT 1 FROM wa_thread_accounts WHERE conversation_id=? AND phone_id=?').get(conversation.id,a.account_id);
  choices.push({channel:'whatsapp',account_id:a.account_id,label:a.name,available:Boolean(contact.phone),reply_window_open:windowOpen(inbound),last_inbound:inbound,templates_allowed:optIn&&String(config.phoneId)===a.account_id,thread_key:conversation&&(known||String(config.phoneId)===a.account_id)?'whatsapp:'+conversation.id+':'+a.account_id:null,reason:contact.phone?'':'لا يوجد رقم مسجل لهذا العميل'});
 }
 for(const channel of ['facebook','instagram']){
  const threads=db.prepare('SELECT id,account_id,last_inbound FROM social_threads WHERE contact_id=? AND channel=?').all(id,channel);
  for(const t of threads){const a=accounts.find(a=>a.channel===channel&&a.account_id===t.account_id);if(a)choices.push({channel,account_id:t.account_id,thread_key:'social:'+t.id,label:a.name,available:true,reply_window_open:windowOpen(t.last_inbound),last_inbound:t.last_inbound});}
  if(!choices.some(c=>c.channel===channel))choices.push({channel,label:channel==='facebook'?'Messenger':'Instagram',available:false,reason:'لا توجد محادثة مرتبطة بهذا العميل على هذه القناة'});
 }
 if(!choices.some(a=>a.channel==='whatsapp'))choices.unshift({channel:'whatsapp',label:'WhatsApp',available:false,reason:'لا يوجد حساب واتساب شركة فعال'});
 const mail=mailConfig(db,key);choices.push({channel:'email',label:'البريد الإلكتروني',available:address(contact.email)&&configured(mail),reason:!address(contact.email)?'لا يوجد بريد صالح مسجل لهذا العميل':!configured(mail)?'بريد الشركة غير مهيأ أو لم ينجح اختباره':''});
 return {contact:{id:contact.id,name:contact.name,phone:contact.phone,email:contact.email,has_phone:Boolean(contact.phone),has_email:Boolean(contact.email)},channels:choices,...customerActivity(db,user,id),privacy:{contact_details_hidden:!manager(user),original_documents_for_management:true}};
}

function selectedChannel(db,user,id,input,config,origin,key){
 const workspace=customerWorkspace(db,user,id,config,origin,key),found=workspace.channels.find(c=>c.channel===input.channel&&c.available&&(input.channel==='email'||c.account_id===String(input.account_id||'')));
 if(!found)fail(409,'القناة غير متاحة لهذا العميل أو الحساب غير صحيح');return found;
}
function queueEmail(db,user,contact,input,key){
 const c=mailConfig(db,key);if(!configured(c)||!address(contact.email))fail(409,'بريد الشركة أو بريد العميل غير مهيأ');
 const requestKey=text(input.request_key,'مرجع الطلب',80);if(!/^[A-Za-z0-9_-]{12,80}$/.test(requestKey))fail(400,'مرجع الطلب غير صالح');
 const subject=text(input.subject,'عنوان الرسالة',200),body=text(input.body,'الرسالة',12000);if(/[\r\n]/.test(subject))fail(400,'عنوان الرسالة غير صالح');
 const old=db.prepare('SELECT * FROM customer_email_jobs WHERE request_key=? AND created_by=?').get(requestKey,user.id);
 if(old){if(old.contact_id!==contact.id||old.subject!==subject||old.body!==body)fail(409,'مرجع الطلب مستخدم لرسالة مختلفة');return {id:old.id,status:old.status,replayed:true};}
 if(db.prepare("SELECT COUNT(*) n FROM customer_email_jobs WHERE created_by=? AND created_at>?").get(user.id,new Date(Date.now()-3600000).toISOString()).n>=50)fail(429,'وصلت حد رسائل البريد المسموح خلال الساعة');
 const id=uid();db.prepare("INSERT INTO customer_email_jobs(id,contact_id,created_by,request_key,recipient_cipher,subject,body,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'queued',?,?)").run(id,contact.id,user.id,requestKey,encryptSecret(contact.email,key),subject,body,now(),now());audit(db,user,'queued','customer_email',id);return {id,status:'queued'};
}

export async function processCustomerEmail(db,key,factory){
 if(activeMail.has(db))return;const c=mailConfig(db,key);if(!configured(c))return;const job=db.prepare("SELECT * FROM customer_email_jobs WHERE status='queued' ORDER BY created_at,rowid LIMIT 1").get();if(!job)return;
 activeMail.add(db);let smtp;try{
  const sender=db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(job.created_by),contact=db.prepare('SELECT * FROM contacts WHERE id=?').get(job.contact_id);
  if(!sender||sender.role==='accountant'||!contact||(!manager(sender)&&contact.owner_id!==sender.id)||decryptSecret(job.recipient_cipher,key)!==contact.email){db.prepare("UPDATE customer_email_jobs SET status='error',error_code='CONTACT_OR_PERMISSION_CHANGED',updated_at=? WHERE id=?").run(now(),job.id);audit(db,null,'error','customer_email',job.id,{code:'CONTACT_OR_PERMISSION_CHANGED'});return;}
  const claimed=db.prepare("UPDATE customer_email_jobs SET status='sending',updated_at=? WHERE id=? AND status='queued'").run(now(),job.id);if(claimed.changes!==1)return;
  smtp=makeTransport(c,factory);const result=await smtp.sendMail({from:{name:'Middle East Education Services',address:c.from},to:contact.email,subject:job.subject,text:job.body,messageId:'<'+job.id+'@mideastedu-eg.com>',disableFileAccess:true,disableUrlAccess:true});
  const accepted=(result.accepted||[]).some(x=>String(typeof x==='string'?x:x?.address).toLowerCase()===contact.email.toLowerCase());
  const status=accepted?'accepted':'error';db.prepare('UPDATE customer_email_jobs SET status=?,provider_id=?,error_code=?,updated_at=? WHERE id=?').run(status,accepted?String(result.messageId||'').slice(0,250):null,accepted?null:'RECIPIENT_NOT_ACCEPTED',now(),job.id);audit(db,null,status,'customer_email',job.id);
 }catch(error){const certain=['EAUTH','ECONNECTION','EDNS','EENVELOPE'].includes(error.code)||Number(error.responseCode)>=400;const state=certain?'error':'unknown';db.prepare('UPDATE customer_email_jobs SET status=?,error_code=?,updated_at=? WHERE id=?').run(state,certain?'SMTP_REJECTED':'SMTP_RESULT_UNKNOWN',now(),job.id);audit(db,null,state,'customer_email',job.id,{code:certain?'SMTP_REJECTED':'SMTP_RESULT_UNKNOWN'});}
 finally{smtp?.close?.();activeMail.delete(db);}
}

export async function handleCustomerWorkspace(ctx){
 const {db,user,path,method,req,res,jsonBody,sendJson,secretKey,config,origin,smtpTransportFactory}=ctx;const send=(status,data)=>{sendJson(res,status,data);return true;};
 if(path==='/api/customer-mail/settings'){
  if(method==='GET')return send(200,mailSettingsSummary(db,user,secretKey));
  if(method==='PATCH')return send(200,saveMailSettings(db,user,await jsonBody(req),secretKey));
 }
 if(path==='/api/customer-mail/verify'&&method==='POST'){
  if(user.role!=='admin')fail(403,'اختبار بريد الشركة للمالك');const c=mailConfig(db,secretKey);if(!c?.pass)fail(409,'أضف كلمة مرور تطبيق بريد الشركة قبل اختبار الاتصال؛ الإرسال غير مفعّل');const smtp=makeTransport(c,smtpTransportFactory);
  try{await smtp.verify();c.verified_at=now();db.prepare("UPDATE settings SET value=? WHERE key='email.smtp'").run(encryptSecret(JSON.stringify(c),secretKey));audit(db,user,'verified','email','company');return send(200,{verified:true});}catch{fail(502,'تعذر التحقق من بريد الشركة؛ راجع كلمة مرور التطبيق وإعدادات المزود');}finally{smtp.close?.();}
 }
 const match=path.match(/^\/api\/contacts\/([^/]+)\/(workspace|open-channel|send-email|viewed)$/);if(!match)return false;
 const contact=getContact(db,user,match[1]);if(user.role==='accountant')fail(403,'التواصل لفريق العملاء');
 if(match[2]==='workspace'&&method==='GET')return send(200,customerWorkspace(db,user,contact.id,config,origin,secretKey));
 if(match[2]==='viewed'&&method==='POST'){
  const recent=db.prepare("SELECT 1 FROM audit WHERE entity='contact' AND entity_id=? AND user_id=? AND action='viewed' AND created_at>? LIMIT 1").get(contact.id,user.id,new Date(Date.now()-300000).toISOString());if(!recent)audit(db,user,'viewed','contact',contact.id);return send(200,{ok:true});
 }
 if(method!=='POST')fail(405,'طريقة غير مسموحة');const input=await jsonBody(req);
 if(['to','phone','email','recipient','recipient_id','contact_id','thread_key'].some(k=>k in input))fail(400,'يحدد الخادم جهة الاتصال من ملف العميل فقط');
 if(match[2]==='send-email')return send(201,queueEmail(db,user,contact,input,secretKey));
 if(match[2]==='open-channel'){
  const selected=selectedChannel(db,user,contact.id,input,config,origin,secretKey);if(selected.channel==='email')fail(400,'استخدم نموذج البريد داخل ملف العميل');
  if(selected.channel!=='whatsapp')return send(200,{key:selected.thread_key});
  let v=db.prepare('SELECT id FROM conversations WHERE contact_id=?').get(contact.id);transaction(db,()=>{if(!v){v={id:uid()};db.prepare('INSERT INTO conversations(id,contact_id,created_at) VALUES(?,?,?)').run(v.id,contact.id,now());}db.prepare('INSERT OR IGNORE INTO wa_thread_accounts VALUES(?,?,NULL)').run(v.id,selected.account_id);});return send(200,{key:'whatsapp:'+v.id+':'+selected.account_id});
 }
 return false;
}
