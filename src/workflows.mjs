import { transaction } from './db.mjs';
import { uid, now, fail, audit } from './service.mjs';

export function validateWorkflow(db,input){
  const conditions=input.conditions || [],actions=input.actions || [];
  if(!Array.isArray(conditions)||conditions.length>8)fail(400,'بحد أقصى 8 شروط');
  const allowed=['source','stage','name','title','priority','status'];
  for(const condition of conditions){
    if(!condition || !allowed.includes(condition.field)||!['eq','contains','neq'].includes(condition.op)||typeof condition.value!=='string'||condition.value.length>200)fail(400,'شرط الأتمتة غير صالح');
  }
  if(!Array.isArray(actions)||actions.length>5)fail(400,'بحد أقصى 5 إجراءات');
  for(const action of actions){
    if(!action||!['task','assign','stage'].includes(action.type))fail(400,'إجراء غير متاح');
    if(action.type==='task'&&(typeof action.title!=='string'||!action.title.trim()||action.title.length>200||!Number.isSafeInteger(action.due_hours??24)||(action.due_hours??24)<0||(action.due_hours??24)>8760))fail(400,'إعداد المهمة غير صالح');
    if(action.type==='assign'&&!db.prepare("SELECT id FROM users WHERE id=? AND active=1 AND role IN('admin','manager','agent')").get(action.user_id||''))fail(400,'موظف الإسناد غير صالح');
    if(action.type==='stage'){
      if(!input.trigger?.startsWith('lead.'))fail(400,'تغيير المرحلة يحتاج حدث فرصة بيع');
      if(!db.prepare('SELECT 1 FROM pipeline_stages WHERE stage_key=?').get(action.stage||''))fail(400,'مرحلة غير صالحة');
    }
  }
  const delay=input.delay_minutes ?? 0;if(!Number.isSafeInteger(delay)||delay<0||delay>525600)fail(400,'مدة التأخير غير صالحة');
  return {conditions:JSON.stringify(conditions),actions:JSON.stringify(actions),delay};
}
export function enqueueWorkflow(db,rule,trigger,record,eventId){
  for(const condition of JSON.parse(rule.conditions || '[]')){
    const value=String(record[condition.field]??'');
    if(condition.op==='eq'&&value!==condition.value)return;
    if(condition.op==='neq'&&value===condition.value)return;
    if(condition.op==='contains'&&!value.toLowerCase().includes(condition.value.toLowerCase()))return;
  }
  db.prepare('INSERT OR IGNORE INTO automation_jobs(id,rule_id,event_id,record,trigger,due_at,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(uid(),rule.id,eventId,JSON.stringify(record),trigger,new Date(Date.now()+rule.delay_minutes*60000).toISOString(),now());
}
export function processWorkflowJobs(db){
  const jobs=db.prepare("SELECT * FROM automation_jobs WHERE status='pending' AND due_at<=? ORDER BY due_at LIMIT 30").all(now());
  for(const job of jobs){
    try{transaction(db,()=>{
      const rule=db.prepare('SELECT * FROM automations WHERE id=?').get(job.rule_id);
      if(!rule?.active){db.prepare("UPDATE automation_jobs SET status='cancelled' WHERE id=?").run(job.id);return;}
      const snapshot=JSON.parse(job.record),contactId=snapshot.contact_id || snapshot.id;
      const contact=db.prepare('SELECT * FROM contacts WHERE id=?').get(contactId);if(!contact)throw new Error('Missing contact');
      const lead=job.trigger.startsWith('lead.')?db.prepare('SELECT * FROM leads WHERE id=?').get(snapshot.id):null;
      let assigned=contact.owner_id;
      for(const action of JSON.parse(rule.actions)){
        if(action.type==='assign'){
          if(!db.prepare('SELECT id FROM users WHERE id=? AND active=1').get(action.user_id))throw new Error('Inactive assignee');
          assigned=action.user_id;db.prepare('UPDATE contacts SET owner_id=?,updated_at=? WHERE id=?').run(assigned,now(),contactId);
          for(const table of ['leads','tasks','tickets'])db.prepare(`UPDATE ${table} SET owner_id=? WHERE contact_id=?`).run(assigned,contactId);
        }else if(action.type==='task'){
          db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?)').run(uid(),contactId,lead?.id||null,action.title,new Date(Date.now()+(action.due_hours??24)*3600000).toISOString(),'open',assigned,now());
        }else if(action.type==='stage'){
          if(!lead)throw new Error('Missing lead');
          db.prepare('UPDATE leads SET stage=?,updated_at=? WHERE id=?').run(action.stage,now(),lead.id);
        }
      }
      db.prepare("UPDATE automation_jobs SET status='done' WHERE id=?").run(job.id);audit(db,null,'executed','automation',rule.id,{job_id:job.id});
    });}catch{db.prepare("UPDATE automation_jobs SET status='error',error_code='ACTION_FAILED' WHERE id=?").run(job.id);}
  }
}
