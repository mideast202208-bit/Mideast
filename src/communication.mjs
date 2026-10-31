import {fail,manager,getContact,now,audit,text} from './service.mjs';
import {queueMessage,accountWindow} from './whatsapp.mjs';
import {socialThread,queueSocialReply} from './social.mjs';
import {accountLimits,accountSummary,saveExtraAccount,verifyExtraAccount,resolveWhatsAppConfig} from './accounts.mjs';
import {saveProfile} from './profiles.mjs';
import {findStudents,studentDossier,threadStudents,linkThreadStudent,openStudentWhatsApp,classifyDocument,attachStudentDocument} from './student-files.mjs';

export function communicationThread(db,user,key,base,secretKey){
 if(user.role==='accountant')fail(403,'مركز التواصل لفريق العملاء');
 const parts=key.split(':');
 if(parts[0]==='social'&&parts.length===2){const row=socialThread(db,user,parts[1]);return {...row,kind:'social',key,account_id:row.account_id};}
 if(parts[0]!=='whatsapp'||parts.length!==3||!/^\d{1,40}$/.test(parts[2]))fail(404,'المحادثة غير موجودة');
 const row=db.prepare('SELECT * FROM conversations WHERE id=?').get(parts[1]);if(!row)fail(404,'المحادثة غير موجودة');
 getContact(db,user,row.contact_id);
 const exists=db.prepare('SELECT 1 FROM wa_thread_accounts WHERE conversation_id=? AND phone_id=?').get(row.id,parts[2]);
 if(!exists&&String(base.phoneId)!==parts[2])fail(404,'المحادثة غير موجودة لهذا الرقم');
 return {...row,kind:'whatsapp',key,account_id:parts[2],last_inbound:accountWindow(db,row,parts[2]),config:resolveWhatsAppConfig(db,secretKey,base,parts[2])};
}
export function communicationMessages(db,user,key,base,secretKey){
 const row=communicationThread(db,user,key,base,secretKey);
 if(row.kind==='social')return db.prepare(`SELECT id,direction,body,status,error_code,created_at,(SELECT reference FROM message_student_links l WHERE l.kind='social' AND l.message_id=social_messages.id) student_reference FROM social_messages WHERE thread_id=? ORDER BY created_at DESC,rowid DESC LIMIT 300`).all(row.id).reverse();
 return db.prepare(`SELECT m.id,m.direction,m.kind,m.body,m.status,m.error_code,m.created_at,m.media_id,(SELECT reference FROM message_student_links l WHERE l.kind='whatsapp' AND l.message_id=m.id) student_reference,
  (SELECT id FROM attachments WHERE message_id=m.id LIMIT 1) AS attachment_id
  FROM messages m LEFT JOIN message_accounts a ON a.message_id=m.id WHERE m.conversation_id=? AND COALESCE(a.phone_id,?)=? ORDER BY m.created_at DESC,m.rowid DESC LIMIT 300`).all(row.id,base.phoneId||'',row.account_id).reverse();
}
export function communicationData(db,user,base,origin){
 if(user.role==='accountant')fail(403,'مركز التواصل لفريق العملاء');
 const args=manager(user)?[]:[user.id],scope=manager(user)?'':' WHERE c.owner_id=?';
 const socials=db.prepare('SELECT t.*,c.name,c.phone,c.owner_id FROM social_threads t JOIN contacts c ON c.id=t.contact_id'+scope+' ORDER BY COALESCE(t.last_inbound,t.created_at) DESC LIMIT 300').all(...args).map(r=>({...r,key:'social:'+r.id,kind:'social'}));
 const conversations=db.prepare('SELECT v.*,c.name,c.phone,c.owner_id FROM conversations v JOIN contacts c ON c.id=v.contact_id'+scope+' ORDER BY COALESCE(v.last_inbound,v.created_at) DESC LIMIT 300').all(...args);
 const whatsapp=conversations.flatMap(r=>{
  let rows=db.prepare('SELECT phone_id,last_inbound FROM wa_thread_accounts WHERE conversation_id=?').all(r.id);
  if(!rows.length&&base.phoneId)rows=[{phone_id:String(base.phoneId),last_inbound:r.last_inbound}];
  return rows.map(a=>({...r,last_inbound:a.last_inbound,channel:'whatsapp',kind:'whatsapp',account_id:a.phone_id,key:'whatsapp:'+r.id+':'+a.phone_id}));
 });
 const accounts=accountSummary(db,base,origin),accountName=(channel,id)=>accounts.find(a=>a.channel===channel&&a.account_id===id)?.name||'حساب غير نشط';
 const threads=[...socials,...whatsapp].map(r=>{
  const seen=db.prepare('SELECT seen_at FROM communication_seen WHERE user_id=? AND thread_key=?').get(user.id,r.key)?.seen_at||'';
  const last=r.kind==='social'?db.prepare('SELECT body,created_at FROM social_messages WHERE thread_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(r.id):db.prepare('SELECT m.body,m.created_at FROM messages m LEFT JOIN message_accounts a ON a.message_id=m.id WHERE m.conversation_id=? AND COALESCE(a.phone_id,?)=? ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1').get(r.id,base.phoneId||'',r.account_id);
  const unread=r.kind==='social'?db.prepare("SELECT COUNT(*) n FROM social_messages WHERE thread_id=? AND direction='in' AND created_at>?").get(r.id,seen).n:db.prepare("SELECT COUNT(*) n FROM messages m LEFT JOIN message_accounts a ON a.message_id=m.id WHERE m.conversation_id=? AND COALESCE(a.phone_id,?)=? AND m.direction='in' AND m.created_at>?").get(r.id,base.phoneId||'',r.account_id,seen).n;
  const students=findStudents(db,user,'',r.contact_id);
  const opportunities=db.prepare("SELECT COUNT(*) total,SUM(CASE WHEN stage NOT IN('won','lost') THEN 1 ELSE 0 END) active FROM leads WHERE contact_id=?"+(manager(user)?'':' AND owner_id=?')).get(r.contact_id,...(manager(user)?[]:[user.id]));
  return {opportunity_count:opportunities.total,open_opportunity_count:opportunities.active||0,key:r.key,thread_id:r.id,kind:r.kind,channel:r.channel,account_id:r.account_id,account_name:accountName(r.channel,r.account_id),contact_id:r.contact_id,name:r.name,phone:r.phone,student_names:students.map(s=>s.name).join(' '),file_references:students.map(s=>s.reference).join(' '),owner_id:r.owner_id,last_inbound:r.last_inbound,last_at:last?.created_at||r.created_at,preview:last?.body||'',unread,status:db.prepare('SELECT status FROM communication_thread_state WHERE thread_key=?').get(r.key)?.status||'open'};
 }).sort((a,b)=>b.last_at.localeCompare(a.last_at)).slice(0,500);
 return {accounts,limits:{...accountLimits,tiktok:10,youtube:10},threads,totals:{all:threads.length,unread:threads.filter(t=>t.unread).length,open:threads.filter(t=>t.status==='open').length},provider_limits:'حدود Meta وصلاحيات الحساب مستقلة عن حد المنصة',supported_channels:['facebook','instagram','whatsapp','tiktok','youtube']};
}
export async function handleCommunication(ctx){
 const {db,user,path,method,req,res,jsonBody,sendJson,secretKey,origin,config,transport}=ctx;
 const send=(status,value)=>{sendJson(res,status,value);return true;};
 if(path==='/api/communication'&&method==='GET')return send(200,communicationData(db,user,config,origin));
 if(path==='/api/communication/students/search'&&method==='POST'){const input=await jsonBody(req);return send(200,findStudents(db,user,String(input.query||'')));}
 const dossier=path.match(/^\/api\/communication\/students\/([^/]+)$/);
 if(dossier&&method==='GET')return send(200,studentDossier(db,user,dossier[1]));
 if(path==='/api/communication/student-conversations'&&method==='POST'){const input=await jsonBody(req);return send(201,openStudentWhatsApp(db,user,input.student_id,String(input.phone_id||''),accountSummary(db,config,origin)));}
 const doc=path.match(/^\/api\/communication\/documents\/([^/]+)$/);
 if(doc&&method==='PATCH'){const input=await jsonBody(req);return send(200,classifyDocument(db,user,doc[1],input.document_type));}
 const profile=path.match(/^\/api\/communication\/profiles(?:\/([^/]+))?$/);
 if(profile&&((method==='POST'&&!profile[1])||(method==='PATCH'&&profile[1])))return send(200,saveProfile(db,user,await jsonBody(req),accountSummary(db,config,origin),profile[1]));
 if(path==='/api/communication/accounts'&&method==='POST')return send(201,saveExtraAccount(db,user,await jsonBody(req),secretKey,config));
 const account=path.match(/^\/api\/communication\/accounts\/([^/]+)(?:\/(verify|subscribe|state))?$/);
 if(account){
  if(user.role!=='admin')fail(403,'إدارة الحسابات للمالك');
  if(method==='PATCH'&&!account[2])return send(200,saveExtraAccount(db,user,await jsonBody(req),secretKey,config,account[1]));
  if(method==='POST'&&['verify','subscribe'].includes(account[2]))return send(200,await verifyExtraAccount(db,user,account[1],secretKey,origin,account[2]==='subscribe',transport));
  if(method==='POST'&&account[2]==='state'){
   const input=await jsonBody(req),row=db.prepare('SELECT * FROM communication_accounts WHERE id=?').get(account[1]);if(!row)fail(404,'الحساب غير موجود');
   if(typeof input.active!=='boolean')fail(400,'حالة غير صحيحة');if(input.active&&(!row.verified_at||!row.subscribed))fail(409,'اختبر الحساب وأكمل الاشتراك أولًا');
   db.prepare('UPDATE communication_accounts SET active=? WHERE id=?').run(input.active?1:0,row.id);audit(db,user,'updated','communication_account',row.id,{active:input.active});return send(200,{ok:true});
  }
 }
 const thread=path.match(/^\/api\/communication\/threads\/([^/]+)\/(messages|state|students|documents)$/);
 if(thread){
  let key;try{key=decodeURIComponent(thread[1]);}catch{fail(400,'معرف غير صالح');}
  const row=communicationThread(db,user,key,config,secretKey);
  if(thread[2]==='documents'&&method==='POST')return send(201,attachStudentDocument(db,user,row,await jsonBody(req),config));
  if(thread[2]==='students'&&method==='GET')return send(200,threadStudents(db,user,row));
  if(thread[2]==='students'&&method==='POST'){const input=await jsonBody(req);return send(200,linkThreadStudent(db,user,row,input.student_id));}
  if(thread[2]==='messages'&&method==='GET')return send(200,communicationMessages(db,user,key,config,secretKey));
  if(thread[2]==='messages'&&method==='POST'){
   const input=await jsonBody(req);
   const context=threadStudents(db,user,row);if(context.requires_choice)fail(409,'هذا الرقم مرتبط بأكثر من طالب؛ اختر الملف قبل الرد');
   const student=context.selected;if(input.student_id&&input.student_id!==student?.id)fail(409,'تغير ملف الطالب المختار؛ حدّث المحادثة قبل الإرسال');
   if(input.include_reference&&!student)fail(409,'اختر ملف الطالب لإدراج رقمه');
   const reply=text(input.body,'الرسالة',4096);
   const body=input.include_reference?'بخصوص ملف '+student.reference+' — '+student.name+'\n'+reply:reply;
   const result=row.kind==='social'?queueSocialReply(db,user,row.id,body):queueMessage(db,user,row,{kind:'text',body},row.config);
   if(student)db.prepare('INSERT INTO message_student_links VALUES(?,?,?,?,?)').run(row.kind,result.id,student.id,student.reference,now());
   return send(201,result);
  }
  if(thread[2]==='state'&&method==='POST'){
   const input=await jsonBody(req);
   if(input.seen===true)db.prepare('INSERT INTO communication_seen VALUES(?,?,?) ON CONFLICT(user_id,thread_key) DO UPDATE SET seen_at=excluded.seen_at').run(user.id,key,now());
   if(input.status!==undefined){if(!['open','done'].includes(input.status))fail(400,'حالة غير صحيحة');db.prepare('INSERT INTO communication_thread_state VALUES(?,?,?) ON CONFLICT(thread_key) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at').run(key,input.status,now());audit(db,user,'updated','communication_thread',key,{status:input.status});}
   return send(200,{ok:true});
  }
 }
 return false;
}
