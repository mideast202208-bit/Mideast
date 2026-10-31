import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../src/db.mjs';
import {createApp} from '../src/server.mjs';
import {uid,now,createContact} from '../src/service.mjs';
import {hash} from '../src/security.mjs';
import {ensureOmniDefaults,setIntakeSettings,saveChannel} from '../src/omni-config.mjs';
import {installEducationWorkspace} from '../src/education.mjs';
import {createRegistration} from '../src/intake.mjs';
import {queueMessage,sendNext} from '../src/whatsapp.mjs';
import {queueSocialReply,sendSocialNext} from '../src/social.mjs';
import {projectCustomerResponse} from '../src/privacy.mjs';

const phone='+201000000077',email='private.student@example.test';
async function fixture(){
 const db=openDatabase(':memory:'),key=Buffer.alloc(32,7),users={},auth={};
 for(const [i,role] of ['admin','manager','agent','accountant','other'].entries()){
  const actor={id:uid(),role:role==='other'?'agent':role,name:'Synthetic '+role};users[role]=actor;
  db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?)').run(actor.id,actor.name,role+'@example.test','unused',actor.role,1,now());
  const token=String(i+1).repeat(64),csrf=String(i+6).repeat(64);
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(hash(token),actor.id,csrf,new Date(Date.now()+3600000).toISOString());auth[role]={cookie:'me_session='+token,csrf};
 }
 ensureOmniDefaults(db);installEducationWorkspace(db,users.admin);setIntakeSettings(db,users.admin,{enabled:true,intake_user:users.agent.id,whatsapp_auto_reply:false,social_auto_reply:false});
 const receipt=createRegistration(db,{name:'طالب اختبار الخصوصية',phone,email,certificate:'ثانوي سوداني',academic_year:'2026',source:'website',consent:true,request_key:uid().replaceAll('-',''),notes:'اتصال '+phone+' '+email,files:[{name:'passport-'+phone+'-'+email+'.pdf',mime:'application/pdf',content:Buffer.from('%PDF-1.7 Synthetic '+phone+' '+email).toString('base64')}]},key,'https://crm.example.test');
 const row=db.prepare('SELECT * FROM intake_registrations').get(),contact=db.prepare('SELECT * FROM contacts WHERE id=?').get(row.contact_id);
 db.prepare('UPDATE contacts SET custom=?,name=? WHERE id=?').run(JSON.stringify({nested:{phone,email,id:phone},free:'ملاحظة '+phone+' '+email}),'اسم '+phone,contact.id);
 const other=createContact(db,users.admin,{name:'Foreign '+phone,phone:'+201000000088',email:'foreign.customer@example.test',owner_id:users.other.id});
 const conversation={id:uid(),contact_id:contact.id,last_inbound:now()};
 db.prepare('INSERT INTO conversations(id,contact_id,last_inbound,created_at) VALUES(?,?,?,?)').run(conversation.id,contact.id,conversation.last_inbound,now());
 db.prepare('INSERT INTO wa_thread_accounts VALUES(?,?,?)').run(conversation.id,'300',now());
 const message=uid();db.prepare("INSERT INTO messages(id,conversation_id,direction,kind,body,status,created_at) VALUES(?,?,'in','text',?,'received',?)").run(message,conversation.id,'اتصال '+phone+' '+email+' '+receipt.receipt_url+' / '+other.phone+' '+other.email+' / +44 20 7946 0000',now());
 db.prepare('INSERT INTO message_accounts VALUES(?,?)').run(message,'300');
 db.prepare('INSERT INTO customer_notes VALUES(?,?,?,?,?)').run(uid(),contact.id,'ملاحظة '+email+' '+phone,users.agent.id,now());
 saveChannel(db,users.admin,'facebook',{account_id:'100',intake_user:users.agent.id,accessToken:'synthetic-only',appSecret:'synthetic-secret',verifyToken:'synthetic-verify',version:'v26.0',active:true},key);
 db.prepare("UPDATE channel_accounts SET verified_at=? WHERE channel='facebook'").run(now());
 const social=uid();db.prepare('INSERT INTO social_threads VALUES(?,?,?,?,?,?,?)').run(social,'facebook','100','987654321',contact.id,now(),now());
 db.prepare('INSERT INTO social_messages VALUES(?,?,?,?,?,?,?,?)').run(uid(),social,'synthetic-in','in',email+' '+phone+' '+receipt.receipt_url,'received',null,now());
 let calls=[];const transport=async(url,init)=>{calls.push({url,body:JSON.parse(init.body)});return {ok:true,json:async()=>url.endsWith('/300/messages')?{messages:[{id:'synthetic-out'}]}:{message_id:'synthetic-social-out'}};};
 const app=createApp({db,secretKey:key,env:{PUBLIC_ORIGIN:'https://crm.example.test',META_PHONE_NUMBER_ID:'300',META_ACCESS_TOKEN:'synthetic-only',META_GRAPH_VERSION:'v26.0',META_INTAKE_USER_ID:users.agent.id},transport});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
 async function request(path,role='agent',method='GET',body){const a=auth[role],r=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(a?{Cookie:a.cookie,'X-CSRF-Token':a.csrf}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});const raw=await r.text();return {status:r.status,raw,body:r.headers.get('content-type')?.includes('application/json')?JSON.parse(raw):raw};}
 return {db,key,users,auth,app,request,row,contact,other,receipt,conversation,social,calls,transport,close:async()=>{await new Promise(r=>app.server.close(r));db.close();}};
}
function noContactData(result){
 for(const value of [phone,phone.slice(1),phone.slice(-8),email,'+201000000088','foreign.customer@example.test','7946 0000','/receipt/'])assert.ok(!result.raw.includes(value),'staff response exposed synthetic private marker: '+value);
}

test('staff projections cover bulk, threads, dossiers, notes, nested studio JSON and file names; managers retain details',async t=>{
 const f=await fixture();try{
  const app=f.db.prepare("SELECT id FROM studio_apps WHERE app_key='me_students'").get().id;
  const paths=['/api/data','/api/communication','/api/hub','/api/communication/students/'+f.row.student_id,'/api/communication/threads/'+encodeURIComponent('whatsapp:'+f.conversation.id+':300')+'/students','/api/communication/threads/'+encodeURIComponent('whatsapp:'+f.conversation.id+':300')+'/messages','/api/communication/threads/'+encodeURIComponent('social:'+f.social)+'/messages','/api/conversations/'+f.conversation.id+'/messages','/api/social/threads/'+f.social+'/messages','/api/contacts/'+f.contact.id+'/notes','/api/contacts/'+f.contact.id+'/files','/api/intake/'+f.row.id+'/files','/api/apps/'+app+'/records','/api/apps/'+app+'/records/'+f.row.student_id];
  for(const path of paths)await t.test(path,async()=>{const result=await f.request(path);assert.equal(result.status,200);noContactData(result);});
  const data=(await f.request('/api/data')).body;assert.equal(data.contacts[0].phone,null);assert.equal(data.contacts[0].email,null);assert.equal(data.contacts[0].has_phone,true);assert.equal(data.contacts[0].has_email,true);assert.equal(data.contacts[0].contact_details_hidden,true);
  const nested=JSON.parse(data.contacts[0].custom);assert.equal(nested.nested.phone,null);assert.equal(nested.nested.email,null);assert.ok(!nested.nested.id.includes(phone));
  for(const role of ['admin','manager']){const result=await f.request('/api/data',role);assert.equal(result.body.contacts.find(c=>c.id===f.contact.id).phone,phone);assert.equal(result.body.contacts.find(c=>c.id===f.contact.id).email,email);assert.ok((await f.request('/api/conversations/'+f.conversation.id+'/messages',role)).raw.includes(f.receipt.receipt_url));}
  const accounting=await f.request('/api/data','accountant');noContactData(accounting);assert.equal((await f.request('/api/communication','accountant')).status,403);
 }finally{await f.close();}
});

test('staff cannot read originals or printable HTML through alternate routes; manager download remains available',async()=>{
 const f=await fixture();try{
  const file=f.db.prepare('SELECT id FROM attachments WHERE mime=?').get('application/pdf').id,receiptPath=new URL(f.receipt.receipt_url).pathname;
  for(const role of ['agent','accountant','other'])for(const path of ['/api/files/'+file,'/api/files/'+f.row.file_id,'/api/print/quote/unknown','/api/print/invoice/unknown',receiptPath]){const result=await f.request(path,role);assert.equal(result.status,403);noContactData(result);}
  assert.equal((await f.request('/api/files/'+file,'manager')).status,200);assert.equal((await f.request(receiptPath,'manager')).status,200);
  // Public bearer receipts remain usable as redacted pages after logout.
  assert.equal((await f.request(receiptPath,'anonymous')).status,200);
  const dossier=(await f.request('/api/communication/students/'+f.row.student_id)).body;assert.ok(dossier.documents.every(d=>d.download_url===null&&d.original_file_restricted));
 }finally{await f.close();}
});

test('historical public receipt links disclose no contact details even without a session and never rewrite the original attachment',async()=>{
 const f=await fixture();try{
  const file=f.db.prepare('SELECT content FROM attachments WHERE id=?').get(f.row.file_id),before=Buffer.from(file.content),path=new URL(f.receipt.receipt_url).pathname;
  assert.ok(before.toString('utf8').includes(phone));assert.ok(before.toString('utf8').includes(email));
  for(const role of ['anonymous','admin','manager']){
   const result=await f.request(path,role);assert.equal(result.status,200);assert.ok(result.raw.startsWith('<!doctype html>'));assert.ok(result.raw.includes(f.row.reference));assert.ok(result.raw.includes('طالب اختبار الخصوصية'));assert.ok(result.raw.includes('[بيانات اتصال محجوبة]'));noContactData(result);assert.ok(!result.raw.includes('<script'));
  }
  assert.deepEqual(Buffer.from(f.db.prepare('SELECT content FROM attachments WHERE id=?').get(f.row.file_id).content),before);
  for(const role of ['admin','manager']){const original=await f.request('/api/files/'+f.row.file_id,role);assert.equal(original.status,200);assert.equal(original.raw,before.toString('utf8'));}
 }finally{await f.close();}
});

test('staff contact writes cannot replace a destination or use create deduplication as a phone oracle',async()=>{
 const f=await fixture();try{
  for(const role of ['agent','accountant'])for(const input of [{phone:'+201000000088'},{email:'replace@example.test'},{phone:null},{email:''}]){
   assert.equal((await f.request('/api/contacts/'+f.contact.id,role,'PATCH',input)).status,403);
   assert.equal((await f.request('/api/contacts',role,'POST',{name:'Synthetic',...input})).status,403);
  }
  const created=await f.request('/api/contacts','agent','POST',{name:'New name only'});assert.equal(created.status,201);assert.equal(created.body.has_phone,false);assert.equal(created.body.has_email,false);noContactData(created);
  assert.equal((await f.request('/api/contacts/'+f.contact.id,'agent','PATCH',{name:'Safe rename',custom:{}})).status,200);
  const stored=f.db.prepare('SELECT phone,email FROM contacts WHERE id=?').get(f.contact.id);assert.equal(stored.phone,phone);assert.equal(stored.email,email);
  assert.equal((await f.request('/api/contacts/'+f.contact.id,'manager','PATCH',{email:'manager-update@example.test'})).status,200);
 }finally{await f.close();}
});

test('staff phone prefix/full/Arabic queries return no phone matches; names/references still work and assignment remains scoped',async()=>{
 const f=await fixture();try{
  for(const query of ['0','77','+20',phone,'٠١٠٠٠٠٠٠٠٧٧']){const result=await f.request('/api/communication/students/search','agent','POST',{query});assert.equal(result.status,200);assert.deepEqual(result.body,[]);}
  for(const query of ['طالب اختبار',f.row.reference]){const result=await f.request('/api/communication/students/search','agent','POST',{query});assert.equal(result.status,200);assert.equal(result.body[0].id,f.row.student_id);noContactData(result);}
  assert.equal((await f.request('/api/communication/students/search','manager','POST',{query:phone})).body[0].id,f.row.student_id);
  assert.equal((await f.request('/api/communication/students/'+f.row.student_id,'other')).status,404);
  assert.deepEqual((await f.request('/api/communication/students/search','other','POST',{query:'طالب اختبار'})).body,[]);
 }finally{await f.close();}
});

test('opaque identifiers, CSRF, exact file references, own login email and unrelated dates survive projection without mutating raw values',async()=>{
 const f=await fixture();try{
  const actor=f.users.agent,csrf='1234567890abcdef'.repeat(4),reference='ME-2026-2010000077',id=uid();
  const original={id,csrf,phone_id:'201000000077',numeric_id:201000000077,reference,body:'ملف '+reference+' بتاريخ 2026-10-31 وسنة ٢٠٢٦',phone,email,user:{...actor,email:'agent@example.test'},custom:JSON.stringify({email,phone,nested:[{value:email,phone_last4:'0077',numeric:201000000077}],relation:id,user:{...actor,email}})};
  const projected=projectCustomerResponse(f.db,actor,original);
  assert.equal(projected.id,id);assert.equal(projected.csrf,csrf);assert.equal(projected.phone_id,'201000000077');assert.equal(projected.numeric_id,201000000077);assert.equal(projected.reference,reference);assert.equal(projected.body,original.body);assert.equal(projected.user.email,'agent@example.test');assert.equal(original.phone,phone);assert.equal(original.custom.includes(email),true);assert.equal(JSON.parse(projected.custom).nested[0].phone_last4,null);assert.equal(JSON.parse(projected.custom).nested[0].numeric,null);assert.equal(JSON.parse(projected.custom).relation,id);
  const me=await f.request('/api/me');assert.equal(me.body.csrf,f.auth.agent.csrf);assert.equal(me.body.user.email,'agent@example.test');
  assert.equal(JSON.parse(projected.custom).user.email,null);
  assert.equal((await f.request('/customer-panel.js')).status,200);
 }finally{await f.close();}
});

test('saving projected text or null contact fields cannot overwrite original notes/custom/student data',async()=>{
 const f=await fixture();try{
  const beforeContact=f.db.prepare('SELECT * FROM contacts WHERE id=?').get(f.contact.id),beforeStudent=f.db.prepare('SELECT * FROM app_records WHERE id=?').get(f.row.student_id),beforeNotes=f.db.prepare('SELECT COUNT(*) n FROM customer_notes').get().n;
  const app=f.db.prepare("SELECT id FROM studio_apps WHERE app_key='me_students'").get().id;
  for(const marker of ['[بيانات اتصال محجوبة]','[رابط تسجيل خاص محجوب]']){
   assert.equal((await f.request('/api/contacts/'+f.contact.id,'agent','PATCH',{custom:{notes:marker}})).status,400);
   assert.equal((await f.request('/api/contacts/'+f.contact.id+'/notes','agent','POST',{body:marker})).status,400);
   assert.equal((await f.request('/api/apps/'+app+'/records/'+f.row.student_id,'agent','PATCH',{name:beforeStudent.name,data:JSON.stringify({notes:{nested:marker}})})).status,400);
   assert.equal((await f.request('/api/conversations/'+f.conversation.id+'/messages','agent','POST',{body:marker})).status,400);
  }
  assert.equal((await f.request('/api/contacts/'+f.contact.id,'agent','PATCH',{custom:{phone:null,email:null}})).status,403);
  assert.deepEqual(f.db.prepare('SELECT * FROM contacts WHERE id=?').get(f.contact.id),beforeContact);assert.deepEqual(f.db.prepare('SELECT * FROM app_records WHERE id=?').get(f.row.student_id),beforeStudent);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM customer_notes').get().n,beforeNotes);
  assert.equal((await f.request('/api/contacts/'+f.contact.id+'/notes','agent','POST',{body:'Safe new followup'})).status,201);
 }finally{await f.close();}
});

test('WhatsApp and Messenger sends resolve real destinations inside server and do not expose them in staff success/error responses',async()=>{
 const f=await fixture();try{
  const path='/api/communication/threads/'+encodeURIComponent('whatsapp:'+f.conversation.id+':300')+'/messages';
  const queued=await f.request(path,'agent','POST',{body:'Synthetic safe response',student_id:f.row.student_id});assert.equal(queued.status,201);noContactData(queued);
  await sendNext(f.db,f.app.config,f.transport,f.key);assert.equal(f.calls[0].body.to,phone.slice(1));assert.equal(f.db.prepare('SELECT phone FROM contacts WHERE id=?').get(f.contact.id).phone,phone);
  const socialQueued=await f.request('/api/social/threads/'+f.social+'/messages','agent','POST',{body:'Synthetic social response'});assert.equal(socialQueued.status,201);noContactData(socialQueued);
  await sendSocialNext(f.db,f.key,f.transport);assert.equal(f.calls[1].body.recipient.id,'987654321');
  assert.equal((await f.request(path,'other','POST',{body:'Forbidden'})).status,404);
  assert.equal((await f.request('/api/export')).status,403);assert.equal((await f.request('/api/audit')).status,403);assert.equal((await f.request('/api/assistant')).status,403);assert.equal((await f.request('/api/automation-jobs')).status,403);
 }finally{await f.close();}
});
