import {uid,now,fail,manager,getContact,audit} from './service.mjs';
import {documentTypes} from '../public/documents.js';
import {normalizeSearch} from './international.mjs';
import {validateAppData} from './studio.mjs';
const select=`SELECT s.id,s.name,s.data,s.owner_id,c.id contact_id,c.name contact_name,c.phone,c.owner_id contact_owner,
 (SELECT r.reference FROM intake_registrations r WHERE r.student_id=s.id ORDER BY r.created_at DESC LIMIT 1) reference
 FROM app_records s JOIN studio_apps app ON app.id=s.app_id AND app.app_key='me_students'
 JOIN contacts c ON c.id=json_extract(s.data,'$.guardian')`;
function scope(user){if(user.role==='accountant')fail(403,'ملفات الطلاب لفريق العملاء');return manager(user)?{sql:'',args:[]}:{sql:' AND s.owner_id=? AND c.owner_id=?',args:[user.id,user.id]};}
function summary(db,user,row){const data=JSON.parse(row.data),opportunities=db.prepare("SELECT COUNT(DISTINCT l.id) n FROM intake_registrations r JOIN leads l ON l.id=r.lead_id AND l.contact_id=r.contact_id WHERE r.student_id=? AND r.contact_id=?"+(manager(user)?'':' AND l.owner_id=?')).get(row.id,row.contact_id,...(manager(user)?[]:[user.id])).n;return {id:row.id,name:row.name,contact_id:row.contact_id,contact_name:row.contact_name,phone:row.phone,reference:row.reference||'ST-'+row.id.replaceAll('-','').slice(0,12).toUpperCase(),nationality:data.nationality||'',nationality_code:data.nationality_code||'',certificate:data.certificate||'',owner_id:row.owner_id,owner_name:db.prepare('SELECT name FROM users WHERE id=?').get(row.owner_id)?.name||'موظف مختص',opportunity_count:opportunities};}
export function studentFile(db,user,id){const s=scope(user),row=db.prepare(select+' WHERE s.id=?'+s.sql).get(id,...s.args);if(!row)fail(404,'ملف الطالب غير متاح');return summary(db,user,row);}
export function findStudents(db,user,query='',contactId=null){
 const s=scope(user),q=normalizeSearch(query).slice(0,160);if(!q&&!contactId)return [];
 // Never let phone-prefix queries become a staff oracle after response masking.
 if(!manager(user)&&q&&/^[+\d\s().-]+$/.test(q))return [];
 const phoneSearch=manager(user);
 const rows=db.prepare(select+' WHERE 1=1'+s.sql+(contactId?' AND c.id=?':'')+(q?` AND (instr(me_search_normalize(s.name),?)>0${phoneSearch?' OR instr(me_search_normalize(c.phone),?)>0':''} OR EXISTS(SELECT 1 FROM intake_registrations r WHERE r.student_id=s.id AND instr(me_search_normalize(r.reference),?)>0) OR instr(me_search_normalize('ST-'||substr(replace(s.id,'-',''),1,12)),?)>0)`:'')+' ORDER BY s.updated_at DESC LIMIT 30').all(...s.args,...(contactId?[contactId]:[]),...(q?(phoneSearch?[q,q,q,q]:[q,q,q]):[]));
 return rows.map(row=>summary(db,user,row));
}
export function studentDossier(db,user,id){
 const student=studentFile(db,user,id);
 const documents=db.prepare(`SELECT d.id,d.name,json_extract(d.data,'$.document_type') document_type,json_extract(d.data,'$.document_status') document_status,a.id attachment_id,a.mime,length(a.content) size FROM app_records d JOIN studio_apps app ON app.id=d.app_id AND app.app_key='me_documents' LEFT JOIN attachments a ON a.id=json_extract(d.data,'$.file_reference') AND a.contact_id=? WHERE json_extract(d.data,'$.student')=? ORDER BY d.created_at,d.name`).all(student.contact_id,id);
 const registrations=db.prepare(`SELECT r.id,r.reference,r.created_at,r.lead_id,r.admission_id,json_extract(a.data,'$.application_status') registration_status
 FROM intake_registrations r JOIN app_records a ON a.id=r.admission_id WHERE r.student_id=? AND r.contact_id=?`+(manager(user)?'':' AND a.owner_id=?')+' ORDER BY r.created_at DESC,r.rowid DESC').all(id,student.contact_id,...(manager(user)?[]:[user.id]));
 const opportunities=db.prepare(`SELECT DISTINCT l.id,l.title,l.stage,l.owner_id,u.name owner_name,l.created_at,l.updated_at FROM leads l JOIN users u ON u.id=l.owner_id JOIN intake_registrations r ON r.lead_id=l.id AND r.contact_id=l.contact_id WHERE r.student_id=? AND r.contact_id=?`+(manager(user)?'':' AND l.owner_id=?')+' ORDER BY l.updated_at DESC').all(id,student.contact_id,...(manager(user)?[]:[user.id])).map(lead=>({...lead,registrations:registrations.filter(r=>r.lead_id===lead.id)}));
 return {...student,documents:documents.map(d=>({...d,download_url:d.attachment_id?'/api/files/'+d.attachment_id:null})),registrations,opportunities,opportunity_count:opportunities.length,latest_registration:registrations[0]||null,checklist:Object.entries(documentTypes).filter(([k])=>k!=='other').map(([key,label])=>({key,label,count:documents.filter(d=>d.document_type===label&&d.attachment_id).length}))};
}
export function threadStudents(db,user,row){
 const students=findStudents(db,user,'',row.contact_id),saved=db.prepare('SELECT student_id FROM thread_student_context WHERE thread_key=?').get(row.key);
 let selected=saved?students.find(s=>s.id===saved.student_id):students.length===1?students[0]:null;
 return {students,selected:selected?studentDossier(db,user,selected.id):null,requires_choice:students.length>1&&!selected};
}
export function linkThreadStudent(db,user,row,id){
 const student=studentFile(db,user,id);if(student.contact_id!==row.contact_id)fail(409,'رقم المحادثة لا يطابق جهة اتصال الطالب؛ افتح محادثة رقم الطالب المسجل من البحث');
 db.prepare('INSERT INTO thread_student_context VALUES(?,?,?,?) ON CONFLICT(thread_key) DO UPDATE SET student_id=excluded.student_id,linked_by=excluded.linked_by,updated_at=excluded.updated_at').run(row.key,id,user.id,now());
 audit(db,user,'linked','student_conversation',row.key,{student_id:id});return threadStudents(db,user,row);
}
export function openStudentWhatsApp(db,user,id,phoneId,accounts){
 const student=studentFile(db,user,id);getContact(db,user,student.contact_id);
 if(!student.phone)fail(409,'أضف رقم الطالب أو ولي الأمر إلى ملف العميل أولًا');
 if(!accounts.some(a=>a.channel==='whatsapp'&&a.account_id===phoneId&&a.active))fail(409,'اختر رقم واتساب شركة فعالًا');
 let conv=db.prepare('SELECT * FROM conversations WHERE contact_id=?').get(student.contact_id);
 if(!conv){conv={id:uid()};db.prepare('INSERT INTO conversations(id,contact_id,created_at) VALUES(?,?,?)').run(conv.id,student.contact_id,now());}
 db.prepare('INSERT OR IGNORE INTO wa_thread_accounts VALUES(?,?,NULL)').run(conv.id,phoneId);
 const key='whatsapp:'+conv.id+':'+phoneId;linkThreadStudent(db,user,{key,contact_id:student.contact_id},id);return {key};
}
export function classifyDocument(db,user,id,type){
 if(!Object.values(documentTypes).includes(type))fail(400,'اختر نوع المستند');
 const row=db.prepare("SELECT d.* FROM app_records d JOIN studio_apps a ON a.id=d.app_id AND a.app_key='me_documents' WHERE d.id=?").get(id);if(!row)fail(404,'المستند غير متاح');
 const data=JSON.parse(row.data);studentFile(db,user,data.student);
 if(!manager(user)&&row.owner_id!==user.id)fail(404,'المستند غير متاح');
 data.document_type=type;db.prepare('UPDATE app_records SET data=?,updated_at=? WHERE id=?').run(JSON.stringify(data),now(),id);audit(db,user,'classified','student_document',id,{document_type:type});return {ok:true};
}
export function attachStudentDocument(db,user,row,input,base){
 const context=threadStudents(db,user,row),student=context.selected;
 if(!student||input.student_id!==student.id)fail(409,'اختر ملف الطالب الحالي قبل حفظ المستند');
 if(row.kind!=='whatsapp')fail(400,'المستندات متاحة لمرفقات واتساب');
 if(!Object.values(documentTypes).includes(input.document_type))fail(400,'اختر نوع المستند');
 const attachment=db.prepare(`SELECT a.* FROM attachments a JOIN messages m ON m.id=a.message_id LEFT JOIN message_accounts ma ON ma.message_id=m.id WHERE a.id=? AND a.contact_id=? AND m.conversation_id=? AND COALESCE(ma.phone_id,?)=?`).get(input.attachment_id,student.contact_id,row.id,base.phoneId||'',row.account_id);
 if(!attachment)fail(404,'المرفق غير متاح في هذه المحادثة');
 if(!['application/pdf','image/jpeg','image/png'].includes(attachment.mime))fail(400,'اختر صورة أو ملف PDF للمستند');
 const existing=db.prepare("SELECT d.id FROM app_records d JOIN studio_apps a ON a.id=d.app_id AND a.app_key='me_documents' WHERE json_extract(d.data,'$.student')=? AND json_extract(d.data,'$.file_reference')=?").get(student.id,attachment.id);if(existing)return {id:existing.id,replayed:true};
 const app=db.prepare("SELECT id FROM studio_apps WHERE app_key='me_documents'").get();if(!app)fail(409,'جهّز تطبيق المستندات أولًا');
 const admission=db.prepare('SELECT admission_id FROM intake_registrations WHERE student_id=? ORDER BY created_at DESC LIMIT 1').get(student.id);
 const data=validateAppData(db,user,app.id,{student:student.id,...(admission?{application:admission.admission_id}:{}),document_type:input.document_type,document_status:'صورة مستلمة',received_date:now().slice(0,10),file_reference:attachment.id});
 const id=uid(),owner=db.prepare('SELECT owner_id FROM app_records WHERE id=?').get(student.id).owner_id;db.prepare('INSERT INTO app_records VALUES(?,?,?,?,?,?,?)').run(id,app.id,attachment.name,owner,data,now(),now());audit(db,user,'linked','student_document',id,{student_id:student.id,attachment_id:attachment.id});return {id};
}
