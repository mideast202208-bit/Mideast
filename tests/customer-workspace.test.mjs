import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../src/db.mjs';
import {createApp} from '../src/server.mjs';
import {uid,now} from '../src/service.mjs';
import {token,hash} from '../src/security.mjs';
import {processCustomerEmail,recoverCustomerEmailJobs} from '../src/customer-workspace.mjs';
import {installEducationWorkspace} from '../src/education.mjs';
import {createRegistration} from '../src/intake.mjs';

async function fixture(){
 const db=openDatabase(':memory:'),key=Buffer.alloc(32,4),users={},credentials={};
 for(const [id,role] of [['owner','admin'],['manager','manager'],['agent','agent'],['other','agent'],['finance','accountant']]){
  users[id]={id:uid(),name:'Synthetic '+id,role};db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?)').run(users[id].id,users[id].name,id+'@example.invalid','unused-synthetic-password',role,1,now());
  const value=token(),csrf=token();db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(hash(value),users[id].id,csrf,new Date(Date.now()+600000).toISOString());credentials[id]={value,csrf};
 }
 const c={id:uid(),name:'Synthetic student',phone:'+201000000077',email:'student@example.invalid',owner_id:users.agent.id};db.prepare('INSERT INTO contacts VALUES(?,?,?,?,?,?,?,?,?)').run(c.id,c.name,c.phone,c.email,'manual',c.owner_id,'{}',now(),now());
 const calls=[],mailOptions=[];let behavior='accept';const factory=options=>{mailOptions.push(options);return {verify:async()=>{if(behavior==='verify-fail')throw Error('synthetic only');return true;},sendMail:async mail=>{calls.push(mail);if(behavior==='timeout')throw Object.assign(Error('no recipient should leak'),{code:'ETIMEDOUT'});if(behavior==='reject')throw Object.assign(Error('private address'),{code:'EENVELOPE',responseCode:550});return {accepted:[mail.to],messageId:mail.messageId};},close(){}};};
 const origin='https://crm.example.test',app=createApp({db,secretKey:key,env:{PUBLIC_ORIGIN:origin},smtpTransportFactory:factory});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
 async function request(actor,path,method='GET',body){const cred=credentials[actor];const r=await fetch(base+'/api'+path,{method,headers:{Origin:origin,'Content-Type':'application/json',Cookie:'me_session='+cred.value,'X-CSRF-Token':cred.csrf},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,data:await r.json()};}
 async function configure(){assert.equal((await request('owner','/customer-mail/settings','PATCH',{host:'smtp.gmail.com',port:465,user:'company@example.invalid',from:'company@example.invalid',password:'synthetic-application-password'})).status,200);assert.equal((await request('owner','/customer-mail/verify','POST',{})).status,200);}
 return {db,key,c,users,request,configure,calls,mailOptions,factory,setBehavior:s=>{behavior=s;},close:async()=>{await new Promise(r=>app.server.close(r));db.close();}};
}
const message={subject:'Synthetic followup',body:'Your recorded application status is ready for review.',request_key:'synthetic-request-0001'};

test('workspace permissions and channel availability are honest without an email account or social identity',async()=>{
 const f=await fixture();try{
  const own=await f.request('agent','/contacts/'+f.c.id+'/workspace');assert.equal(own.status,200);assert.equal(own.data.contact.has_phone,true);assert.equal(own.data.contact.has_email,true);assert.ok(!JSON.stringify(own.data).includes(f.c.phone));assert.ok(!JSON.stringify(own.data).includes(f.c.email));
  for(const channel of ['whatsapp','facebook','instagram','email'])assert.ok(own.data.channels.some(c=>c.channel===channel));assert.equal(own.data.channels.find(c=>c.channel==='email').available,false);
  assert.equal((await f.request('other','/contacts/'+f.c.id+'/workspace')).status,404);assert.equal((await f.request('finance','/contacts/'+f.c.id+'/workspace')).status,404);
  assert.equal((await f.request('agent','/contacts/'+f.c.id+'/send-email','POST',message)).status,409);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM customer_email_jobs').get().n,0);
 }finally{await f.close();}
});
test('only owner saves SMTP credentials encrypted; verification and TLS are required; no password is returned',async()=>{
 const f=await fixture();try{
  for(const who of ['agent','manager'])assert.equal((await f.request(who,'/customer-mail/settings','PATCH',{})).status,403);
  assert.equal((await f.request('owner','/customer-mail/settings','PATCH',{host:'127.0.0.1',port:25,user:'x',from:'x@example.invalid',password:'secret'})).status,400);
  const save=await f.request('owner','/customer-mail/settings','PATCH',{host:'smtp.gmail.com',port:587,user:'company@example.invalid',from:'company@example.invalid',password:'synthetic-application-password'});assert.equal(save.status,200);assert.equal(save.data.configured,false);assert.ok(!JSON.stringify(save.data).includes('synthetic-application-password'));assert.ok(!f.db.prepare("SELECT value FROM settings WHERE key='email.smtp'").get().value.includes('synthetic-application-password'));
  assert.equal((await f.request('agent','/customer-mail/settings')).status,403);assert.equal((await f.request('owner','/customer-mail/verify','POST',{})).status,200);
  assert.equal(f.mailOptions[0].requireTLS,true);assert.equal(f.mailOptions[0].tls.rejectUnauthorized,true);assert.equal(f.mailOptions[0].disableFileAccess,true);assert.equal(f.mailOptions[0].disableUrlAccess,true);assert.equal(f.mailOptions[0].logger,false);
 }finally{await f.close();}
});
test('email resolves its recipient from CRM, records author and accepted status, and is idempotent on double submit',async()=>{
 const f=await fixture();try{await f.configure();
  const url='/contacts/'+f.c.id+'/send-email';const a=await f.request('agent',url,'POST',message);assert.equal(a.status,201);assert.equal(a.data.status,'queued');const b=await f.request('agent',url,'POST',message);assert.equal(a.data.id,b.data.id);assert.equal(b.data.replayed,true);assert.ok(!JSON.stringify(a.data).includes(f.c.email));
  const stored=f.db.prepare('SELECT * FROM customer_email_jobs').get();assert.ok(!stored.recipient_cipher.includes(f.c.email));assert.equal(stored.created_by,f.users.agent.id);
  await processCustomerEmail(f.db,f.key,f.factory);await processCustomerEmail(f.db,f.key,f.factory);assert.equal(f.calls.length,1);assert.equal(f.calls[0].to,f.c.email);assert.equal(f.calls[0].subject,message.subject);assert.equal(f.db.prepare('SELECT status FROM customer_email_jobs').get().status,'accepted');
  const view=await f.request('agent','/contacts/'+f.c.id+'/workspace');assert.equal(view.data.email_history[0].status,'accepted');assert.ok(view.data.timeline.some(x=>x.action==='queued'&&x.author==='Synthetic agent'));assert.equal(view.data.last_staff_activity.author,'Synthetic agent');assert.equal(view.data.last_staff_activity.action,'queued');assert.ok(!JSON.stringify(view.data).includes(f.c.email));
  assert.equal((await f.request('agent',url,'POST',{...message,body:'Different'})).status,409);
 }finally{await f.close();}
});
test('client cannot choose a recipient or inject SMTP headers; an unassigned employee cannot send',async()=>{
 const f=await fixture();try{await f.configure();const url='/contacts/'+f.c.id+'/send-email';
  for(const field of ['to','phone','email','recipient','recipient_id','contact_id','thread_key'])assert.equal((await f.request('agent',url,'POST',{...message,[field]:'attacker@example.invalid'})).status,400);
  assert.equal((await f.request('agent',url,'POST',{...message,subject:'Hello\r\nBcc: attacker@example.invalid'})).status,400);assert.equal((await f.request('other',url,'POST',message)).status,404);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM customer_email_jobs').get().n,0);
 }finally{await f.close();}
});
test('queued email is stopped when assignment, address or sender authorization changes',async()=>{
 for(const change of ['owner','email','inactive']){const f=await fixture();try{await f.configure();await f.request('agent','/contacts/'+f.c.id+'/send-email','POST',message);
  if(change==='owner')f.db.prepare('UPDATE contacts SET owner_id=? WHERE id=?').run(f.users.other.id,f.c.id);if(change==='email')f.db.prepare('UPDATE contacts SET email=? WHERE id=?').run('changed@example.invalid',f.c.id);if(change==='inactive')f.db.prepare('UPDATE users SET active=0 WHERE id=?').run(f.users.agent.id);
  await processCustomerEmail(f.db,f.key,f.factory);assert.equal(f.calls.length,0);assert.equal(f.db.prepare('SELECT error_code FROM customer_email_jobs').get().error_code,'CONTACT_OR_PERMISSION_CHANGED');
 }finally{await f.close();}}
});
test('ambiguous SMTP failures and interrupted sends are never automatically retried or labeled delivered',async()=>{
 const f=await fixture();try{await f.configure();f.setBehavior('timeout');await f.request('agent','/contacts/'+f.c.id+'/send-email','POST',message);await processCustomerEmail(f.db,f.key,f.factory);await processCustomerEmail(f.db,f.key,f.factory);assert.equal(f.calls.length,1);assert.equal(f.db.prepare('SELECT status FROM customer_email_jobs').get().status,'unknown');
  f.db.prepare("UPDATE customer_email_jobs SET status='sending'").run();recoverCustomerEmailJobs(f.db);assert.equal(f.db.prepare('SELECT status FROM customer_email_jobs').get().status,'unknown');assert.equal(f.db.prepare('SELECT error_code FROM customer_email_jobs').get().error_code,'RESTART_DURING_SEND');
 }finally{await f.close();}
});
test('notes, record updates, sends and viewing have a scoped author/time timeline without cross-customer events',async()=>{
 const f=await fixture();try{
  const post=await f.request('agent','/contacts/'+f.c.id+'/notes','POST',{body:'Synthetic employee reviewed documents'});assert.equal(post.status,201);
  for(let i=0;i<2;i++)assert.equal((await f.request('agent','/contacts/'+f.c.id+'/viewed','POST',{})).status,200);
  const view=await f.request('agent','/contacts/'+f.c.id+'/workspace');assert.equal(view.data.notes[0].author,'Synthetic agent');assert.equal(view.data.last_activity.action,'noted');assert.ok(view.data.last_activity.created_at);assert.equal(view.data.timeline.filter(e=>e.action==='viewed').length,1);assert.ok(view.data.timeline.every(e=>e.author==='Synthetic agent'));
 }finally{await f.close();}
});
test('migration 9 is additive and does not rewrite existing customer contact values',async()=>{
 const f=await fixture();try{assert.equal(f.db.prepare('SELECT MAX(version) n FROM schema_versions').get().n,9);assert.equal(f.db.prepare('SELECT phone FROM contacts WHERE id=?').get(f.c.id).phone,f.c.phone);assert.equal(f.db.prepare('PRAGMA quick_check').get().quick_check,'ok');assert.equal(f.db.prepare('PRAGMA foreign_key_check').all().length,0);}finally{await f.close();}
});
test('company email identity can be saved as a disabled draft; credentials never carry to a different mailbox',async()=>{
 const f=await fixture();try{
  const draft=await f.request('owner','/customer-mail/settings','PATCH',{host:'smtp.gmail.com',port:465,user:'Company.Sender@example.invalid',from:'Company.Sender@example.invalid'});
  assert.equal(draft.status,200);assert.equal(draft.data.user,'Company.Sender@example.invalid');assert.equal(draft.data.from,'company.sender@example.invalid');assert.equal(draft.data.configured,false);assert.equal(draft.data.password_set,false);
  assert.equal((await f.request('owner','/customer-mail/verify','POST',{})).status,409);assert.equal(f.mailOptions.length,0);
  assert.equal((await f.request('agent','/contacts/'+f.c.id+'/send-email','POST',message)).status,409);
  await f.configure();assert.equal((await f.request('owner','/customer-mail/settings')).data.password_set,true);
  const changed=await f.request('owner','/customer-mail/settings','PATCH',{user:'other@example.invalid',from:'other@example.invalid'});assert.equal(changed.status,200);assert.equal(changed.data.password_set,false);assert.equal(changed.data.configured,false);
  assert.equal((await f.request('owner','/customer-mail/verify','POST',{})).status,409);
 }finally{await f.close();}
});
test('registration audit appears in the customer timeline and disabled social accounts remain visible as unavailable',async()=>{
 const f=await fixture();try{
  installEducationWorkspace(f.db,f.users.owner);createRegistration(f.db,{name:'Synthetic registered student',phone:f.c.phone,certificate:'ثانوي سوداني',academic_year:'2026',university:'Synthetic University',faculty:'Synthetic Faculty',source:'website',consent:true,whatsapp_opt_in:false,request_key:'synthetic-registration-123456'},f.key,'https://crm.example.test');
  f.db.prepare('INSERT INTO social_threads VALUES(?,?,?,?,?,?,?)').run(uid(),'facebook','100','synthetic-sender',f.c.id,null,now());
  const view=await f.request('agent','/contacts/'+f.c.id+'/workspace');assert.equal(view.status,200);assert.ok(view.data.timeline.some(e=>e.action==='registered'));assert.ok(view.data.channels.some(c=>c.channel==='facebook'&&c.available===false));
  await f.configure();f.db.prepare('UPDATE contacts SET email=? WHERE id=?').run('invalid-address',f.c.id);const invalid=await f.request('agent','/contacts/'+f.c.id+'/workspace');assert.equal(invalid.data.channels.find(c=>c.channel==='email').available,false);
 }finally{await f.close();}
});
