import test from 'node:test';
import assert from 'node:assert/strict';
import {inboundFixture,syntheticPhone} from './inbound-fixture.mjs';
import {createRegistration} from '../src/intake.mjs';
import {registrationLink,resolveRegistrationLink} from '../src/intake-links.mjs';
import {downloadMessageMedia} from '../src/media.mjs';
import {createHash} from 'node:crypto';
import {findStudents,studentDossier,threadStudents,attachStudentDocument} from '../src/student-files.mjs';
const count=(db,table)=>db.prepare('SELECT COUNT(*) n FROM '+table).get().n;
const openLeads=(db,id)=>db.prepare("SELECT * FROM leads WHERE contact_id=? AND stage NOT IN('won','lost')").all(id);

for(const channel of ['whatsapp','facebook','instagram']){
 test(channel+': signed inbound creates one customer/opportunity/assigned followup; replays and a second message do not duplicate',async()=>{
  const f=await inboundFixture();try{
   const packet=f.payload(channel,'synthetic-first');assert.equal((await f.post(channel,packet,false)).status,403);assert.equal(count(f.db,'contacts'),0);
   assert.equal((await f.post(channel,packet)).status,200);assert.equal((await f.post(channel,packet)).status,200);f.drain();
   const c=f.db.prepare('SELECT * FROM contacts').get();assert.equal(count(f.db,'contacts'),1);assert.equal(c.source,channel);assert.equal(c.owner_id,f.users.intake.id);
   const lead=openLeads(f.db,c.id)[0];assert.ok(lead);assert.equal(lead.owner_id,c.owner_id);assert.equal(lead.stage,'new');
   const task=f.db.prepare('SELECT * FROM tasks').get();assert.equal(task.contact_id,c.id);assert.equal(task.lead_id,lead.id);assert.equal(task.owner_id,c.owner_id);
   await f.post(channel,{...packet,synthetic_wrapper:'changed wrapper, same provider id'});f.drain();await f.post(channel,f.payload(channel,'synthetic-second'));f.drain();
   assert.equal(count(f.db,'contacts'),1);assert.equal(count(f.db,'leads'),1);assert.equal(count(f.db,'tasks'),1);
   const table=channel==='whatsapp'?'messages':'social_messages';assert.equal(f.db.prepare("SELECT COUNT(*) n FROM "+table+" WHERE direction='in'").get().n,2);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM "+table+" WHERE direction='out'").get().n,1);
   assert.equal(count(f.db,'app_records'),0);assert.equal(count(f.db,'attachments'),0);assert.equal(f.externalCalls,0);
  }finally{await f.close();}
 });
 test(channel+': an existing owned contact with no opportunity gets one without reassignment',async()=>{
  const f=await inboundFixture();try{const c=f.seedContact(channel);await f.post(channel,f.payload(channel,'synthetic-manual'));f.drain();
   assert.equal(count(f.db,'contacts'),1);assert.equal(openLeads(f.db,c.id).length,1);assert.equal(openLeads(f.db,c.id)[0].owner_id,c.owner_id);assert.equal(f.db.prepare('SELECT owner_id,source FROM contacts WHERE id=?').get(c.id).source,'manual');assert.equal(f.db.prepare('SELECT owner_id FROM contacts WHERE id=?').get(c.id).owner_id,f.users.assigned.id);assert.equal(count(f.db,'tasks'),1);
  }finally{await f.close();}
 });
 for(const stage of ['won','lost'])test(channel+': a fresh message after '+stage+' creates one new opportunity and preserves closed history',async()=>{
  const f=await inboundFixture();try{const c=f.seedContact(channel,{stage});const old=f.db.prepare('SELECT * FROM leads').get(),packet=f.payload(channel,'synthetic-return-'+stage);await f.post(channel,packet);f.drain();await f.post(channel,packet);f.drain();await f.post(channel,f.payload(channel,'synthetic-return-second-'+stage));f.drain();
   assert.equal(count(f.db,'contacts'),1);assert.equal(count(f.db,'leads'),2);assert.equal(f.db.prepare('SELECT stage FROM leads WHERE id=?').get(old.id).stage,stage);assert.equal(openLeads(f.db,c.id).length,1);assert.equal(openLeads(f.db,c.id)[0].owner_id,c.owner_id);assert.equal(count(f.db,'tasks'),1);assert.equal(f.externalCalls,0);
  }finally{await f.close();}
 });
 test(channel+': a pre-existing active opportunity is reused without resetting its stage or generating another followup',async()=>{
  const f=await inboundFixture();try{const c=f.seedContact(channel,{stage:'qualified'}),old=f.db.prepare('SELECT * FROM leads').get();await f.post(channel,f.payload(channel,'synthetic-active'));f.drain();assert.equal(count(f.db,'leads'),1);assert.equal(openLeads(f.db,c.id)[0].id,old.id);assert.equal(openLeads(f.db,c.id)[0].stage,'qualified');assert.equal(count(f.db,'tasks'),0);
  }finally{await f.close();}
 });
}

test('website registration links customer/opportunity/owner/student/admission/task and categorized BLOB files atomically, and replays do not duplicate',async()=>{
 const f=await inboundFixture({followup:false});try{
  const form=f.registration({files:[{name:'synthetic-passport.pdf',mime:'application/pdf',document_type:'جواز السفر',content:Buffer.from('%PDF-1.4\nSynthetic fixture only\n%%EOF').toString('base64')}]});
  const response=await fetch(f.base+'/public/registrations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(form)});assert.equal(response.status,201);const result=await response.json();
  const r=f.db.prepare('SELECT * FROM intake_registrations').get(),c=f.db.prepare('SELECT * FROM contacts').get(),lead=f.db.prepare('SELECT * FROM leads').get(),task=f.db.prepare('SELECT * FROM tasks').get();
  assert.equal(c.source,'website');assert.equal(c.owner_id,f.users.intake.id);assert.equal(lead.contact_id,c.id);assert.equal(r.lead_id,lead.id);assert.equal(task.lead_id,lead.id);assert.equal(task.owner_id,c.owner_id);assert.equal(r.source,'website');assert.equal(count(f.db,'attachments'),2);
  const student=f.db.prepare('SELECT * FROM app_records WHERE id=?').get(r.student_id),admission=f.db.prepare('SELECT * FROM app_records WHERE id=?').get(r.admission_id);assert.equal(JSON.parse(student.data).guardian,c.id);assert.equal(JSON.parse(admission.data).student,student.id);assert.equal(JSON.parse(admission.data).application_status,'استكمال البيانات');
  assert.equal(createRegistration(f.db,form,f.key,f.origin).reference,result.reference);assert.equal(count(f.db,'contacts'),1);assert.equal(count(f.db,'leads'),1);assert.equal(count(f.db,'tasks'),1);assert.equal(count(f.db,'attachments'),2);
  assert.equal((await fetch(f.base+'/api/files/'+r.file_id)).status,401);assert.equal(f.externalCalls,0);
 }finally{await f.close();}
});
test('website form from a signed social contact link reuses its active enquiry and preserves the assigned owner and source',async()=>{
 const f=await inboundFixture();try{
  await f.post('facebook',f.payload('facebook','synthetic-before-registration'));f.drain();const c=f.db.prepare('SELECT * FROM contacts').get(),lead=f.db.prepare('SELECT * FROM leads').get();
  const link=new URL(registrationLink(c.id,'facebook',f.key,f.origin)),form=f.registration({source:'facebook',link_token:link.searchParams.get('client')});createRegistration(f.db,form,f.key,f.origin);
  assert.equal(count(f.db,'contacts'),1);assert.equal(count(f.db,'leads'),1);const r=f.db.prepare('SELECT * FROM intake_registrations').get();assert.equal(r.contact_id,c.id);assert.equal(r.lead_id,lead.id);assert.equal(r.source,'facebook');assert.equal(f.db.prepare('SELECT phone FROM contacts WHERE id=?').get(c.id).phone,syntheticPhone);
 }finally{await f.close();}
});
for(const channel of ['whatsapp','facebook','instagram'])test(channel+': student name/phone/file lookup remains staff-scoped; an external message naming another student never reveals their dossier',async()=>{
 const f=await inboundFixture({followup:false});try{
  const c=f.seedContact('whatsapp');createRegistration(f.db,f.registration(),f.key,f.origin);const r=f.db.prepare('SELECT * FROM intake_registrations').get();
  for(const q of ['Synthetic student',r.reference])assert.equal(findStudents(f.db,f.users.assigned,q).length,1);
  assert.equal(findStudents(f.db,f.users.assigned,syntheticPhone).length,0);assert.equal(findStudents(f.db,f.users.owner,syntheticPhone).length,1);
  assert.equal(findStudents(f.db,f.users.intake,r.reference).length,0);assert.throws(()=>studentDossier(f.db,f.users.intake,r.student_id),e=>e.status===404);
  assert.equal((await fetch(f.base+'/api/communication/students/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:r.reference})})).status,401);
  await f.post(channel,f.payload(channel,'synthetic-other-sender','اسمي Synthetic student ورقم ملفي '+r.reference,channel==='whatsapp'?'201000000088':'901'));f.drain();
  const other=channel==='whatsapp'?f.db.prepare('SELECT * FROM contacts WHERE phone=?').get('+201000000088'):f.db.prepare('SELECT c.* FROM contacts c JOIN social_threads t ON t.contact_id=c.id WHERE t.channel=? AND t.sender_id=?').get(channel,'901');assert.notEqual(other.id,c.id);assert.equal(count(f.db,'intake_registrations'),1);
  const reply=(channel==='whatsapp'?f.db.prepare("SELECT m.body FROM messages m JOIN conversations v ON v.id=m.conversation_id WHERE v.contact_id=? AND m.direction='out'").get(other.id):f.db.prepare("SELECT m.body FROM social_messages m JOIN social_threads t ON t.id=m.thread_id WHERE t.contact_id=? AND m.direction='out'").get(other.id)).body;assert.ok(!reply.includes(r.reference));assert.ok(!reply.includes(r.receipt_cipher));const ownLink=new URL(reply.match(/https:\/\/crm\.example\.test\/apply\?[^\s،]+/)[0]);assert.equal(resolveRegistrationLink(ownLink.searchParams.get('client'),f.key),other.id);assert.equal(f.externalCalls,0);
 }finally{await f.close();}
});
test('incoming messages without configured followup rules do not pretend to create tasks or student files',async()=>{
 const f=await inboundFixture({followup:false});try{await f.post('whatsapp',f.payload('whatsapp','synthetic-no-rule'));f.drain();assert.equal(count(f.db,'leads'),1);assert.equal(count(f.db,'tasks'),0);assert.equal(count(f.db,'attachments'),0);assert.equal(count(f.db,'app_records'),0);}finally{await f.close();}
});

for(const stage of [null,'won','lost'])test('website: existing assigned contact '+(stage||'without opportunity')+' gets a separate valid registration without contact duplication',async()=>{
 const f=await inboundFixture({followup:false});try{const c=f.seedContact('whatsapp',{stage});createRegistration(f.db,f.registration(),f.key,f.origin);assert.equal(count(f.db,'contacts'),1);assert.equal(count(f.db,'leads'),stage?2:1);const r=f.db.prepare('SELECT * FROM intake_registrations').get(),lead=f.db.prepare('SELECT * FROM leads WHERE id=?').get(r.lead_id);assert.equal(lead.owner_id,c.owner_id);assert.equal(lead.stage,'new');assert.equal(count(f.db,'tasks'),1);assert.equal(count(f.db,'attachments'),1);if(stage)assert.equal(f.db.prepare('SELECT COUNT(*) n FROM leads WHERE stage=?').get(stage).n,1);
 }finally{await f.close();}
});
for(const channel of ['facebook','instagram'])test(channel+': text containing a manual contact phone or name is not trusted as an identity link',async()=>{
 const f=await inboundFixture();try{const manual=f.seedContact(channel,{linked:false});await f.post(channel,f.payload(channel,'synthetic-unlinked','Synthetic existing student '+syntheticPhone));f.drain();assert.equal(count(f.db,'contacts'),2);const thread=f.db.prepare('SELECT * FROM social_threads').get();assert.notEqual(thread.contact_id,manual.id);assert.equal(openLeads(f.db,manual.id).length,0);assert.equal(f.externalCalls,0);
 }finally{await f.close();}
});

test('signed WhatsApp document stays on its customer/company number and is indexed once on the selected existing student',async()=>{
 const f=await inboundFixture({followup:false});try{
  const c=f.seedContact('whatsapp');createRegistration(f.db,f.registration(),f.key,f.origin);const r=f.db.prepare('SELECT * FROM intake_registrations').get(),packet=f.payload('whatsapp','synthetic-document');const item=packet.entry[0].changes[0].value.messages[0];delete item.text;item.type='document';item.document={id:'444',filename:'synthetic-certificate.pdf'};
  await f.post('whatsapp',packet);f.drain();const message=f.db.prepare("SELECT * FROM messages WHERE provider_id='synthetic-document'").get();assert.ok(message);assert.equal(count(f.db,'leads'),1);
  const bytes=Buffer.from('%PDF-1.4\nSynthetic document fixture only\n%%EOF');let mockCalls=0;const transport=async url=>{mockCalls++;if(url.startsWith('https://graph.facebook.com/'))return {ok:true,json:async()=>({url:'https://lookaside.fbsbx.com/synthetic-document',mime_type:'application/pdf',file_size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')})};return new Response(bytes,{status:200,headers:{'Content-Type':'application/pdf'}});};
  const file=await downloadMessageMedia(f.db,f.app.config,message.id,transport,f.key);assert.equal((await downloadMessageMedia(f.db,f.app.config,message.id,transport,f.key)).id,file.id);assert.equal(mockCalls,2);
  const stored=f.db.prepare('SELECT * FROM attachments WHERE id=?').get(file.id);assert.equal(stored.contact_id,c.id);assert.deepEqual(Buffer.from(stored.content),bytes);
  const row={id:message.conversation_id,key:'whatsapp:'+message.conversation_id+':300',kind:'whatsapp',account_id:'300',contact_id:c.id};assert.equal(threadStudents(f.db,f.users.assigned,row).selected.id,r.student_id);
  const input={student_id:r.student_id,attachment_id:file.id,document_type:'الشهادة الدراسية'},linked=attachStudentDocument(f.db,f.users.assigned,row,input,f.app.config);assert.equal(attachStudentDocument(f.db,f.users.assigned,row,input,f.app.config).replayed,true);
  const index=JSON.parse(f.db.prepare('SELECT data FROM app_records WHERE id=?').get(linked.id).data);assert.equal(index.student,r.student_id);assert.equal(index.application,r.admission_id);assert.equal(index.file_reference,file.id);assert.equal(studentDossier(f.db,f.users.assigned,r.student_id).documents.filter(d=>d.attachment_id===file.id).length,1);
  assert.throws(()=>attachStudentDocument(f.db,f.users.intake,row,input,f.app.config),e=>[403,404,409].includes(e.status));assert.throws(()=>attachStudentDocument(f.db,f.users.assigned,{...row,account_id:'999'},input,f.app.config),e=>e.status===404);assert.equal(f.externalCalls,0);
 }finally{await f.close();}
});
