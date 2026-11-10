import { transaction } from './db.mjs';
import { audit,fail,manager,now,owner,text,uid } from './service.mjs';
import { reassignContactRecords } from './studio.mjs';

export function claimEnabled(db){
  return db.prepare("SELECT value FROM settings WHERE key='crm.claim_enabled'").get()?.value==='1';
}

export function intakeAssignment(db,fallback){
  if(!claimEnabled(db))return {id:fallback,waiting:false};
  const custodian=db.prepare("SELECT id FROM users WHERE role IN('admin','manager') AND active=1 ORDER BY role,created_at,id LIMIT 1").get();
  if(!custodian)fail(503,'صندوق خدمة العملاء يحتاج حساب إدارة نشط');
  return {id:custodian.id,waiting:true};
}

export function recordCrmIntake(db,{contactId,leadId,kind,eventId,source,waiting=false}){
  const at=now();
  db.prepare(`INSERT OR IGNORE INTO crm_activity(kind,event_id,contact_id,lead_id,source,created_at)
    VALUES(?,?,?,?,?,?)`).run(kind,eventId,contactId,leadId,source,at);
  if(!waiting)return;
  db.prepare('INSERT INTO crm_waiting VALUES(?,?,?,?)').run(leadId,contactId,source,at);
  const task=db.prepare("SELECT 1 FROM tasks WHERE lead_id=? AND status='open'").get(leadId);
  if(!task){
    const custodian=db.prepare('SELECT owner_id FROM leads WHERE id=?').get(leadId).owner_id;
    db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?)').run(uid(),contactId,leadId,'التواصل الأول',new Date(Date.now()+7200000).toISOString(),'open',custodian,at);
  }
}

function moveContactRecords(db,id,next){
  db.prepare('UPDATE contacts SET owner_id=?,updated_at=? WHERE id=?').run(next,now(),id);
  for(const table of ['leads','tasks','tickets'])db.prepare(`UPDATE ${table} SET owner_id=? WHERE contact_id=?`).run(next,id);
  reassignContactRecords(db,id,next);
}

// The CRM scopes conversations and documents by contact. A returning contact
// with no active opportunity goes back to the queue with its history intact.
export function prepareReturningIntake(db,contact){
  if(!claimEnabled(db)||db.prepare("SELECT 1 FROM leads WHERE contact_id=? AND stage NOT IN('won','lost') LIMIT 1").get(contact.id))return null;
  const routing=intakeAssignment(db,contact.owner_id);
  if(contact.owner_id!==routing.id){
    moveContactRecords(db,contact.id,routing.id);
    audit(db,null,'queued_for_claim','contact',contact.id,{previous_owner_id:contact.owner_id});
    contact.owner_id=routing.id;
  }
  return routing;
}

export function transferCrmContact(db,user,contact,next,reason){
  moveContactRecords(db,contact.id,next);
  db.prepare('DELETE FROM crm_waiting WHERE contact_id=?').run(contact.id);
  audit(db,user,'assigned','contact',contact.id,{previous_owner_id:contact.owner_id,owner_id:next,reason});
  recordCrmIntake(db,{contactId:contact.id,leadId:null,kind:'assignment',eventId:uid(),source:contact.source});
}

export function crmFeed(db,user){
  if(user.role==='accountant')fail(403,'هذه القائمة لفريق خدمة العملاء');
  const management=manager(user);
  const waiting=db.prepare(`SELECT q.lead_id,q.source,q.created_at,NULL AS owner_id,
    (SELECT MIN(due_at) FROM tasks t WHERE t.lead_id=q.lead_id AND t.status='open') AS due_at
    ${management?',l.title,c.name AS contact_name':''}
    FROM crm_waiting q JOIN leads l ON l.id=q.lead_id JOIN contacts c ON c.id=q.contact_id
    WHERE l.stage NOT IN('won','lost') ORDER BY q.created_at,q.lead_id LIMIT 100`).all();
  const visibility=management?'1=1':'c.owner_id=? OR q.contact_id IS NOT NULL';
  const scope=management?[]:[user.id];
  const activity=db.prepare(`SELECT a.seq,a.kind,a.source,a.created_at FROM crm_activity a JOIN contacts c ON c.id=a.contact_id
    LEFT JOIN crm_waiting q ON q.contact_id=c.id WHERE (${visibility}) ORDER BY a.seq DESC LIMIT 50`).all(...scope);
  const metrics=management?db.prepare(`SELECT u.id,u.name,
    (SELECT COUNT(*) FROM leads l WHERE l.owner_id=u.id AND l.stage NOT IN('won','lost') AND NOT EXISTS (SELECT 1 FROM crm_waiting w WHERE w.contact_id=l.contact_id)) AS open,
    (SELECT COUNT(*) FROM tasks t WHERE t.owner_id=u.id AND t.status='open' AND t.due_at<? AND NOT EXISTS (SELECT 1 FROM crm_waiting w WHERE w.contact_id=t.contact_id)) AS overdue,
    (SELECT COUNT(*) FROM tasks t WHERE t.owner_id=u.id AND t.status='done') AS completed
    FROM users u WHERE u.active=1 AND u.role IN('admin','manager','agent') ORDER BY u.name`).all(now()):[];
  const failures=management?db.prepare(`SELECT id,'whatsapp' AS source,created_at,'PROCESSING_FAILED' AS code FROM webhook_events WHERE status='error'
    UNION ALL SELECT id,channel AS source,created_at,error_code AS code FROM social_events WHERE status='error'
    ORDER BY created_at DESC LIMIT 25`).all():[];
  const waitingCount=db.prepare("SELECT COUNT(*) n FROM crm_waiting q JOIN leads l ON l.id=q.lead_id WHERE l.stage NOT IN('won','lost')").get().n;
  return {waiting,activity,metrics,failures,enabled:claimEnabled(db),waiting_count:waitingCount};
}

export async function handleCrmInbox({db,user,path,method,req,res,jsonBody,sendJson}){
  if(!path.startsWith('/api/crm-inbox'))return false;
  const respond=value=>{sendJson(res,200,value);return true;};
  if(user.role==='accountant')fail(403,'هذه القائمة لفريق خدمة العملاء');
  if(path==='/api/crm-inbox'&&method==='GET')return respond(crmFeed(db,user));
  if(path==='/api/crm-inbox/settings'&&method==='PATCH'){
    if(user.role!=='admin')fail(403,'التفعيل لمالك النظام فقط');
    const input=await jsonBody(req);
    if(typeof input.enabled!=='boolean')fail(400,'اختيار غير صالح');
    transaction(db,()=>{
      db.prepare("INSERT INTO settings VALUES('crm.claim_enabled',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(input.enabled?'1':'0');
      audit(db,user,'updated','settings','crm.claim_enabled',{enabled:input.enabled});
    });
    return respond({ok:true});
  }
  const registration=path.match(/^\/api\/crm-inbox\/registrations\/(ME-\d{4}-[A-F0-9]{10})$/);
  if(registration&&method==='GET'){
    if(!manager(user))fail(403,'فحص التسجيل للإدارة فقط');
    const row=db.prepare(`SELECT r.reference,r.contact_id,r.lead_id,r.created_at,r.source,
      r.delivery_status,c.owner_id,u.name AS owner_name,u.active AS owner_active,
      c.created_at AS contact_created_at,l.stage,q.lead_id IS NOT NULL AS waiting,
      EXISTS(SELECT 1 FROM crm_activity a WHERE a.kind='registration' AND a.event_id=r.id) AS notification_recorded
      FROM intake_registrations r LEFT JOIN contacts c ON c.id=r.contact_id LEFT JOIN leads l ON l.id=r.lead_id
      LEFT JOIN users u ON u.id=c.owner_id LEFT JOIN crm_waiting q ON q.contact_id=c.id WHERE r.reference=?`).get(registration[1]);
    if(!row)fail(404,'مرجع التسجيل غير موجود');
    return respond(row);
  }
  const retry=path.match(/^\/api\/crm-inbox\/retry\/(whatsapp|facebook|instagram)\/([a-f0-9-]{36})$/);
  if(retry&&method==='POST'){
    if(user.role!=='admin')fail(403,'إعادة معالجة الأحداث لمالك النظام فقط');
    const [,source,id]=retry;
    transaction(db,()=>{
      const count=db.prepare("SELECT COUNT(*) n FROM audit WHERE entity='crm_inbound' AND entity_id=? AND action='retried'").get(id).n;
      if(count>=3)fail(409,'تم الوصول إلى الحد الأقصى للمحاولات اليدوية');
      const result=source==='whatsapp'?db.prepare("UPDATE webhook_events SET status='new' WHERE id=? AND status='error'").run(id):
        db.prepare("UPDATE social_events SET status='new',error_code=NULL WHERE id=? AND channel=? AND status='error'").run(id,source);
      if(!result.changes)fail(409,'الحدث غير متاح لإعادة المحاولة');
      audit(db,user,'retried','crm_inbound',id,{channel:source});
    });
    return respond({ok:true});
  }
  const match=path.match(/^\/api\/crm-inbox\/([^/]+)\/(claim|assign)$/);
  if(match&&method==='POST'){
    const [,leadId,mode]=match;
    if(mode==='assign'&&!manager(user))fail(403,'إعادة التوزيع للإدارة فقط');
    const input=await jsonBody(req);
    const next=mode==='claim'?user.id:owner(db,user,text(input.owner_id,'الموظف',100));
    const reason=mode==='claim'?'استلام الفرصة من الصندوق':text(input.reason,'سبب الإسناد',500);
    const result=transaction(db,()=>{
      const current=db.prepare(`SELECT c.*,l.stage,w.lead_id AS waiting FROM leads l JOIN contacts c ON c.id=l.contact_id
        LEFT JOIN crm_waiting w ON w.lead_id=l.id WHERE l.id=?`).get(leadId);
      if(!current||mode==='claim'&&!current.waiting)fail(409,'الفرصة لم تعد متاحة للاستلام');
      if(mode==='claim'&&['won','lost'].includes(current.stage))fail(409,'الفرصة مغلقة');
      if(current.waiting||current.owner_id!==next)transferCrmContact(db,user,current,next,reason);
      return {contact_id:current.id,lead_id:leadId};
    });
    return respond(result);
  }
  return false;
}
