import { intakeAssignment,recordCrmIntake } from './crm-inbox.mjs';
import { transaction } from './db.mjs';
import { internationalPhone } from './international.mjs';
import { hash, token } from './security.mjs';
import { audit, fail, manager, now, runAutomations, text, uid } from './service.mjs';
import { intakeOwner, intakeSettings } from './omni-config.mjs';
import { services } from '../public/services.js';

const sources = new Set(['website','facebook','instagram','whatsapp','google_sites','google_forms','google_business']);

export function createEnquiry(db,input){
  if(input.company_url)fail(400,'تعذر إرسال الاستفسار');
  if(input.consent!==true)fail(400,'الموافقة على معالجة الاستفسار مطلوبة');
  if(typeof input.request_key!=='string'||!/^[A-Za-z0-9_-]{24,128}$/.test(input.request_key))fail(400,'مفتاح الطلب غير صالح');
  if(input.files!==undefined)fail(400,'الاستفسار السريع لا يقبل مستندات');

  const name=text(input.name,'الاسم',160);
  const phone=internationalPhone(text(input.phone,'الهاتف',40),input.phone_country);
  const service=input.service||'استشارة وتواصل مع الفريق';
  if(!services.includes(service))fail(400,'اختر خدمة من القائمة');
  const source=sources.has(input.source)?input.source:'website';
  const campaign=text(input.campaign??'','الحملة',150,false);
  const notes=text(input.notes??'','الاستفسار',1000,false);
  const requestHash=hash(input.request_key);
  const fingerprint=hash(JSON.stringify([name,phone,service,source,campaign,notes]));

  return transaction(db,()=>{
    const prior=db.prepare('SELECT reference,fingerprint FROM quick_enquiries WHERE request_hash=?').get(requestHash);
    if(prior){
      if(prior.fingerprint!==fingerprint)fail(409,'مفتاح الاستفسار استُخدم لبيانات مختلفة');
      return {reference:prior.reference,replayed:true};
    }
    const intake=intakeOwner(db);
    if(!intakeSettings(db).enabled||!intake)fail(503,'استقبال الاستفسارات متوقف مؤقتًا');
    const createdAt=now();
    let contact=db.prepare('SELECT * FROM contacts WHERE phone=?').get(phone);
    const routing=!contact?intakeAssignment(db,intake.id):null;
    if(!contact){
      contact={id:uid(),name,phone,source,owner_id:routing.id};
      db.prepare('INSERT INTO contacts VALUES(?,?,?,?,?,?,?,?,?)').run(contact.id,name,phone,'',source,routing.id,'{}',createdAt,createdAt);
      runAutomations(db,'contact.created',contact,contact.id);
    }
    const assigned=db.prepare("SELECT id FROM users WHERE id=? AND active=1 AND role IN('admin','manager','agent')").get(contact.owner_id);
    const reviewer=assigned??db.prepare("SELECT id FROM users WHERE active=1 AND role IN('admin','manager') ORDER BY role,created_at LIMIT 1").get();
    if(!reviewer)fail(503,'لا يوجد مسؤول لمراجعة إسناد جهة الاتصال');
    const lead={id:uid(),contact_id:contact.id,title:'استفسار سريع · '+service,stage:'new',owner_id:reviewer.id,source};
    db.prepare('INSERT INTO leads VALUES(?,?,?,?,?,?,?,?,?)').run(lead.id,contact.id,lead.title,lead.stage,0,lead.owner_id,'{}',createdAt,createdAt);
    runAutomations(db,'lead.created',lead,lead.id);
    const reference='ENQ-'+token().slice(0,12).toUpperCase();
    const task=db.prepare("SELECT id FROM tasks WHERE lead_id=? AND owner_id=? AND status='open' AND due_at IS NOT NULL ORDER BY due_at LIMIT 1").get(lead.id,lead.owner_id);
    const taskId=task?.id??uid();
    if(!task)db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?)').run(taskId,contact.id,lead.id,'الرد على الاستفسار '+reference,new Date(Date.now()+2*3600000).toISOString(),'open',lead.owner_id,createdAt);
    db.prepare('INSERT INTO quick_enquiries VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(requestHash,fingerprint,reference,lead.id,taskId,name,service,source,campaign,notes,createdAt);
    recordCrmIntake(db,{contactId:contact.id,leadId:lead.id,kind:'enquiry',eventId:requestHash,source,waiting:Boolean(routing?.waiting)});
    audit(db,null,'enquiry_received','lead',lead.id,{source,owner_review:!assigned});
    return {reference,replayed:false};
  });
}

export function listEnquiries(db,user){
  return db.prepare(`SELECT q.reference,q.name,q.service,q.source,q.campaign,q.notes,q.created_at,
    l.id AS lead_id,l.contact_id,l.owner_id,l.stage,t.due_at,t.status AS task_status,
    EXISTS (SELECT 1 FROM intake_registrations r WHERE r.lead_id=l.id) AS registered
    FROM quick_enquiries q JOIN leads l ON l.id=q.lead_id JOIN tasks t ON t.id=q.task_id
    ${manager(user)?'':'WHERE l.owner_id=?'} ORDER BY q.created_at DESC LIMIT 500`).all(...(manager(user)?[]:[user.id]));
}
