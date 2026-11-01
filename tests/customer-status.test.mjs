import test from 'node:test';
import assert from 'node:assert/strict';
import {inboundFixture,syntheticPhone} from './inbound-fixture.mjs';
import {createRegistration} from '../src/intake.mjs';
import {setIntakeSettings,intakeSettings} from '../src/omni-config.mjs';
import {studentDossier,findStudents,threadStudents} from '../src/student-files.mjs';
import {whatsappStatusReply,whatsappLookupReply,whatsappLookupPrompt} from '../src/customer-status.mjs';
import {communicationData} from '../src/communication.mjs';
import {createWorkspace} from '../public/workspace.js';
const settings=f=>setIntakeSettings(f.db,f.users.owner,{whatsapp_status_lookup:true});
const registration=(f,extra={})=>{createRegistration(f.db,f.registration(extra),f.key,f.origin);return f.db.prepare('SELECT * FROM intake_registrations ORDER BY rowid DESC LIMIT 1').get();};
const outgoing=f=>f.db.prepare("SELECT * FROM messages WHERE direction='out' ORDER BY rowid").all();
const contact=f=>f.db.prepare('SELECT * FROM contacts WHERE phone=?').get(syntheticPhone);
const ask=async(f,id,body,sender)=>{const p=f.payload('whatsapp',id,body,sender);await f.post('whatsapp',p);f.drain();return p;};

test('status lookup defaults OFF; only the owner may explicitly configure a boolean without changing reply/channel flags',async()=>{
 const f=await inboundFixture();try{
  const before=intakeSettings(f.db);assert.equal(before.whatsapp_status_lookup,false);
  assert.throws(()=>setIntakeSettings(f.db,f.users.intake,{whatsapp_status_lookup:true}),e=>e.status===403);
  assert.throws(()=>setIntakeSettings(f.db,f.users.owner,{whatsapp_status_lookup:'true'}),e=>e.status===400);
  settings(f);const after=intakeSettings(f.db);assert.equal(after.whatsapp_status_lookup,true);assert.equal(after.whatsapp_auto_reply,before.whatsapp_auto_reply);assert.equal(after.social_auto_reply,before.social_auto_reply);
 }finally{await f.close();}
});
test('signed own-number requests by file/name/phone return saved minimal status once per provider id, without private filenames or document URLs',async()=>{
 const f=await inboundFixture({followup:false});try{
  f.seedContact('whatsapp');const r=registration(f,{files:[{name:'PRIVATE-PASSPORT-ID-123.pdf',mime:'application/pdf',document_type:'جواز السفر',content:Buffer.from('%PDF-1.4 Synthetic only').toString('base64')}]});settings(f);
  const packet=await ask(f,'synthetic-status-ref',r.reference);await f.post('whatsapp',packet);f.drain();assert.equal(outgoing(f).length,1);
  let answer=outgoing(f)[0].body;assert.match(answer,/Synthetic student/);assert.ok(answer.includes(r.reference));assert.match(answer,/استكمال البيانات/);assert.match(answer,/تصنيفات مستندات مستلمة: جواز السفر/);assert.ok(!answer.split('تصنيفات بدون ملفات مرفوعة: ')[1].split('\n')[0].includes('جواز السفر'));assert.ok(!answer.includes('نواقص'));assert.ok(!answer.includes('PRIVATE-PASSPORT'));assert.ok(!answer.includes('/api/files'));assert.ok(!/https?:\/\//.test(answer));
  const a=f.db.prepare('SELECT data FROM app_records WHERE id=?').get(r.admission_id);f.db.prepare('UPDATE app_records SET data=? WHERE id=?').run(JSON.stringify({...JSON.parse(a.data),application_status:'تم التقديم'}),r.admission_id);
  await ask(f,'synthetic-status-name','Synthetic student');await ask(f,'synthetic-status-phone',syntheticPhone);assert.equal(outgoing(f).length,3);assert.match(outgoing(f).at(-1).body,/تم التقديم/);
  for(const m of outgoing(f))assert.equal(f.db.prepare('SELECT phone_id FROM message_accounts WHERE message_id=?').get(m.id).phone_id,'300');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM contacts').get().n,1);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM intake_registrations').get().n,1);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM attachments').get().n,2);assert.equal(f.externalCalls,0);
 }finally{await f.close();}
});
test('disabled lookup keeps the welcome behavior; disabling automatic replies also prevents status replies',async()=>{
 const f=await inboundFixture({followup:false});try{f.seedContact('whatsapp');const r=registration(f);await ask(f,'synthetic-off',r.reference);assert.equal(outgoing(f).length,1);assert.ok(!outgoing(f)[0].body.includes(r.reference));assert.match(outgoing(f)[0].body,/رد آلي/);
  settings(f);setIntakeSettings(f.db,f.users.owner,{whatsapp_auto_reply:false});await ask(f,'synthetic-autoreply-off','حالة ملفي '+r.reference);assert.equal(outgoing(f).length,1);
 }finally{await f.close();}
});
test('another sender cannot use a name/reference to access a registered dossier, and a mismatched trusted phone fails closed',async()=>{
 const f=await inboundFixture({followup:false});try{f.seedContact('whatsapp');const r=registration(f);settings(f);assert.equal(whatsappStatusReply(f.db,contact(f),'+201000000088',r.reference),null);
  await ask(f,'synthetic-foreign-status','اسمي Synthetic student وحالة ملفي '+r.reference,'201000000088');const reply=outgoing(f).at(-1).body;assert.ok(!reply.includes(r.reference));assert.ok(!reply.includes('Synthetic student'));assert.match(reply,/لا يوجد ملف/);assert.equal(f.externalCalls,0);
 }finally{await f.close();}
});
test('multiple students require one explicitly owned reference; names and mixed/foreign references never select another dossier',async()=>{
 const f=await inboundFixture({followup:false});try{f.seedContact('whatsapp');const a=registration(f,{name:'Synthetic first'}),b=registration(f,{name:'Synthetic second'});settings(f);
  await ask(f,'synthetic-multi-name','Synthetic first');assert.match(outgoing(f).at(-1).body,/أكثر من ملف/);assert.ok(!outgoing(f).at(-1).body.includes(a.reference));
  await ask(f,'synthetic-selected',b.reference);assert.match(outgoing(f).at(-1).body,/Synthetic second/);assert.ok(!outgoing(f).at(-1).body.includes(a.reference));
  await ask(f,'synthetic-contradictory-owned-name',a.reference+' الاسم: Synthetic second');assert.match(outgoing(f).at(-1).body,/غير مرتبط/);assert.ok(!outgoing(f).at(-1).body.includes(a.reference));assert.ok(!outgoing(f).at(-1).body.includes(b.reference));
  await ask(f,'synthetic-matching-owned-name',a.reference+' الاسم: Synthetic first');assert.ok(outgoing(f).at(-1).body.includes(a.reference));assert.ok(!outgoing(f).at(-1).body.includes(b.reference));
  await ask(f,'synthetic-multi-ref',a.reference+' '+b.reference);assert.match(outgoing(f).at(-1).body,/ملف واحد/);
  const foreign=registration(f,{name:'Synthetic foreign student',phone:'+201000000088'});await ask(f,'synthetic-real-foreign',foreign.reference);assert.match(outgoing(f).at(-1).body,/غير مرتبط/);assert.ok(!outgoing(f).at(-1).body.includes('Synthetic foreign student'));
  await ask(f,'synthetic-wrong-ref','ME-2026-ABCDEF012345');assert.match(outgoing(f).at(-1).body,/غير مرتبط/);assert.ok(!outgoing(f).at(-1).body.includes('Synthetic first'));
 }finally{await f.close();}
});
test('old inbound messages cannot trigger a status reply outside the permitted reply window',async()=>{
 const f=await inboundFixture({followup:false});try{f.seedContact('whatsapp');const r=registration(f);settings(f);const p=f.payload('whatsapp','synthetic-old-status',r.reference);p.entry[0].changes[0].value.messages[0].timestamp=String(Math.floor((Date.now()-25*3600000)/1000));await f.post('whatsapp',p);f.drain();assert.equal(outgoing(f).length,0);
 }finally{await f.close();}
});
for(const channel of ['facebook','instagram'])test(channel+': a phone entered through registration does not enable private status disclosure over Meta',async()=>{
 const f=await inboundFixture({followup:false});try{f.seedContact(channel);const r=registration(f);settings(f);await f.post(channel,f.payload(channel,'synthetic-meta-status','حالة ملفي '+r.reference));f.drain();assert.equal(f.db.prepare("SELECT COUNT(*) n FROM social_messages WHERE direction='out'").get().n,0);assert.equal(f.externalCalls,0);
 }finally{await f.close();}
});
test('the staff dossier groups only this student’s registrations/opportunities/documents and preserves closed stages and ACL',async()=>{
 const f=await inboundFixture({followup:false});try{f.seedContact('whatsapp');const a=registration(f,{name:'Synthetic first'}),b=registration(f,{name:'Synthetic second'});f.db.prepare("UPDATE leads SET stage='won' WHERE id=?").run(a.lead_id);
  const dossier=studentDossier(f.db,f.users.assigned,a.student_id);assert.equal(dossier.opportunity_count,1);assert.equal(dossier.opportunities[0].id,a.lead_id);assert.equal(dossier.opportunities[0].stage,'won');assert.equal(dossier.opportunities[0].owner_id,f.users.assigned.id);assert.equal(dossier.latest_registration.reference,a.reference);assert.equal(dossier.latest_registration.registration_status,'استكمال البيانات');assert.ok(!JSON.stringify(dossier).includes(b.reference));assert.ok(dossier.documents.every(d=>d.download_url?.startsWith('/api/files/')));
  assert.equal(findStudents(f.db,f.users.assigned,a.reference)[0].opportunity_count,1);assert.throws(()=>studentDossier(f.db,f.users.intake,a.student_id),e=>e.status===404);assert.equal(findStudents(f.db,f.users.intake,a.reference).length,0);
 }finally{await f.close();}
});
test('the existing communication UI renders the real linked opportunity/status/owner and escapes customer-controlled titles',async()=>{
 const f=await inboundFixture({followup:false}),oldDocument=global.document,oldInterval=global.setInterval;try{f.seedContact('whatsapp');const r=registration(f);f.db.prepare('UPDATE leads SET title=? WHERE id=?').run('<img src=x onerror=alert(1)>',r.lead_id);await ask(f,'synthetic-open-ui','مرحبا');
  const comm=communicationData(f.db,f.users.assigned,f.app.config,f.origin);assert.equal(comm.threads[0].opportunity_count,1);assert.equal(comm.threads[0].open_opportunity_count,1);assert.equal(communicationData(f.db,f.users.intake,f.app.config,f.origin).threads.length,0);const row=f.db.prepare('SELECT * FROM conversations').get(),thread={id:row.id,key:'whatsapp:'+row.id+':300',kind:'whatsapp',account_id:'300',contact_id:r.contact_id};global.document={addEventListener(){}};global.setInterval=()=>0;
  const e=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const w=createWorkspace({api:async path=>path==='/communication'?comm:path.endsWith('/students')?threadStudents(f.db,f.users.assigned,thread):path.endsWith('/messages')?[]:{ok:true},escape:e,modal(){},bindForm(){},toast(){},render(){},getUser:()=>f.users.assigned,getData:()=>({templates:[]}),getPage:()=> 'communications',getSearch:()=>'',navigate(){}});await w.load('communications');await w.action('workspace-thread',thread.key);const output=w.view('communications');assert.match(output,/الفرص والتسجيل/);assert.match(output,/استكمال البيانات/);assert.match(output,/Synthetic assigned/);assert.ok(output.includes(r.reference));assert.match(output,/&lt;img/);assert.ok(!output.includes('<img src=x'));
 }finally{global.document=oldDocument;global.setInterval=oldInterval;await f.close();}
});

test('an inactive historical owner cannot disclose a student status and does not silently reassign the contact',async()=>{
 const f=await inboundFixture({followup:false});try{f.seedContact('whatsapp');const r=registration(f);settings(f);f.db.prepare('UPDATE users SET active=0 WHERE id=?').run(f.users.assigned.id);assert.equal(whatsappStatusReply(f.db,contact(f),syntheticPhone,r.reference),null);await ask(f,'synthetic-inactive-owner',r.reference);assert.equal(outgoing(f).length,0);assert.equal(contact(f).owner_id,f.users.assigned.id);
 }finally{await f.close();}
});

test('a different phone written in the message never becomes the outbound recipient or a dossier search key',async()=>{
 const f=await inboundFixture({followup:false});try{f.seedContact('whatsapp');const a=registration(f),b=registration(f,{name:'Synthetic unrelated student',phone:'+201000000088'});settings(f);await ask(f,'synthetic-typed-other-phone','+201000000088');const reply=outgoing(f).at(-1);assert.ok(!reply.body.includes(b.reference));assert.ok(!reply.body.includes('Synthetic unrelated student'));assert.ok(!reply.body.includes(a.reference));const v=f.db.prepare('SELECT c.phone,c.id FROM conversations v JOIN contacts c ON c.id=v.contact_id WHERE v.id=?').get(reply.conversation_id);assert.equal(v.phone,syntheticPhone);assert.equal(v.id,a.contact_id);
 }finally{await f.close();}
});

test('first greeting prompts for an identifier, then the owned name returns saved form values without internal fields',async()=>{
 const f=await inboundFixture({followup:false});try{
  f.seedContact('whatsapp');const r=registration(f,{name:'طالب تجريبي',requested_service:'التقديم الدراسي',level:'بكالوريوس',academic_year:'2027',notes:'PRIVATE INTERNAL NOTE'});settings(f);
  const student=f.db.prepare('SELECT data FROM app_records WHERE id=?').get(r.student_id);f.db.prepare('UPDATE app_records SET data=? WHERE id=?').run(JSON.stringify({...JSON.parse(student.data),grade:'PRIVATE GRADE',nationality:'PRIVATE NATIONALITY',notes:'PRIVATE NOTE'}),r.student_id);
  const packet=await ask(f,'identity-greeting','السلام عليكم');assert.equal(outgoing(f).length,1);const prompt=outgoing(f)[0];assert.equal(prompt.body,whatsappLookupPrompt);assert.ok(!prompt.body.includes(r.reference));assert.ok(!prompt.body.includes('طالب تجريبي'));assert.ok(!prompt.body.includes('Synthetic University'));
  await f.post('whatsapp',packet);f.drain();assert.equal(outgoing(f).length,1);
  await ask(f,'identity-repeat-greeting','مرحبا');assert.equal(outgoing(f).length,1);
  await ask(f,'identity-name','اسمي طالب تجريبي');const answer=outgoing(f).at(-1).body;
  for(const expected of [r.reference,'طالب تجريبي','الجامعة المطلوبة: Synthetic University','الكلية أو التخصص المطلوب: Synthetic Faculty','المرحلة الدراسية: بكالوريوس','سنة التقديم: 2027','الخدمة المطلوبة: التقديم الدراسي'])assert.ok(answer.includes(expected),expected);
  assert.ok(!answer.includes('PRIVATE'));assert.ok(!answer.includes('/api/files'));assert.equal(f.db.prepare('SELECT COUNT(*) n FROM contacts').get().n,1);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM intake_registrations').get().n,1);assert.equal(f.externalCalls,0);
 }finally{await f.close();}
});

test('an established conversation can restart lookup; pending prompts survive process logic and are account-scoped',async()=>{
 const f=await inboundFixture({followup:false});try{
  f.seedContact('whatsapp');const r=registration(f);await ask(f,'identity-old-welcome','مرحبا');settings(f);await ask(f,'identity-existing-help','حالة ملفي');let rows=outgoing(f);assert.equal(rows.length,2);assert.equal(rows.at(-1).body,whatsappLookupPrompt);
  const conversation=f.db.prepare('SELECT id FROM conversations').get(),c=contact(f);
  assert.equal(whatsappLookupReply(f.db,c,syntheticPhone,'مرحبا',{conversationId:conversation.id,phoneId:'300'}),null);
  assert.equal(whatsappLookupReply(f.db,c,syntheticPhone,'مرحبا',{conversationId:conversation.id,phoneId:'400'}).body,whatsappLookupPrompt);
  await ask(f,'identity-wrong-name','اسم تجريبي غير مطابق');assert.ok(!outgoing(f).at(-1).body.includes(r.reference));assert.match(outgoing(f).at(-1).body,/لم أجد تطابقًا/);
  const before=outgoing(f).length;await ask(f,'identity-thanks','شكراً لك');assert.equal(outgoing(f).length,before);
  f.db.prepare("UPDATE messages SET created_at=? WHERE direction='out'").run(new Date(Date.now()-3*60000).toISOString());
  await ask(f,'identity-cooldown','مرحبا');assert.equal(outgoing(f).length,before+1);assert.equal(outgoing(f).at(-1).body,whatsappLookupPrompt);
  const latest=outgoing(f).at(-1);f.db.prepare("UPDATE messages SET status='failed' WHERE id=?").run(latest.id);
  assert.equal(whatsappLookupReply(f.db,c,syntheticPhone,'ordinary unrelated chat',{conversationId:conversation.id,phoneId:'300'}),null);
  assert.equal(f.externalCalls,0);
 }finally{await f.close();}
});

test('foreign or contradictory identifiers never fall back to even the sender-owned dossier',async()=>{
 const f=await inboundFixture({followup:false});try{
  f.seedContact('whatsapp');const own=registration(f,{name:'Owned Student'}),foreign=registration(f,{name:'Other Student',phone:'+201000000088'});settings(f);
  for(const [i,query]of ['اسمي Other Student','اسم الطالب: Other Student','+201000000088','رقم الهاتف: +201000000088',own.reference+' +201000000088',own.reference+' 01000000088',own.reference+' رقم الهاتف: 01000000088',own.reference+' الاسم: Other Student',own.reference+' Other Student',own.reference+' ME-2026-X',own.reference+' ST-ZZ',own.reference+' '+foreign.reference,'ME-2026-INVALID'].entries()){
   await ask(f,'identity-foreign-'+i,query);const answer=outgoing(f).at(-1).body;assert.ok(!answer.includes(own.reference));assert.ok(!answer.includes(foreign.reference));assert.ok(!answer.includes('Owned Student'));assert.ok(!answer.includes('Other Student'));
  }
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM intake_registrations').get().n,2);assert.equal(f.externalCalls,0);
 }finally{await f.close();}
});

test('local, international, Arabic and Persian phone forms resolve only the registered sender',async()=>{
 for(const [sender,country,forms]of [['+201001234567','EG',['01001234567','٠١٠٠١٢٣٤٥٦٧','۰۱۰۰۱۲۳۴۵۶۷','00201001234567']],['+442079460018','GB',['020 7946 0018','٠٢٠ ٧٩٤٦ ٠٠١٨','۰۰۴۴۲۰۷۹۴۶۰۰۱۸','+44 20 7946 0018']]]){
  const f=await inboundFixture({followup:false});try{
   f.seedContact('whatsapp');f.db.prepare('UPDATE contacts SET phone=?').run(sender);const r=registration(f,{phone:sender,phone_country:country});settings(f);
   for(const [i,value]of forms.entries()){await ask(f,'identity-phone-'+country+'-'+i,value,sender.slice(1));assert.ok(outgoing(f).at(-1).body.includes(r.reference),value);}
   assert.equal(outgoing(f).length,forms.length);assert.equal(f.externalCalls,0);
  }finally{await f.close();}
 }
});

test('new senders receive a scoped registration path and cannot obtain another student’s existence or data',async()=>{
 const f=await inboundFixture({followup:false});try{
  f.seedContact('whatsapp');const r=registration(f);settings(f);await ask(f,'identity-new-greeting','مرحبا','201000000088');const greeting=outgoing(f).at(-1).body;assert.match(greeting,/اكتب اسم الطالب أو رقم الهاتف المسجل أو رقم الملف/);assert.ok(greeting.includes(f.origin+'/apply'));assert.ok(!greeting.includes(r.reference));
  await ask(f,'identity-new-name','Synthetic student','201000000088');const answer=outgoing(f).at(-1).body;assert.match(answer,/لا يوجد ملف/);assert.ok(!answer.includes(r.reference));assert.ok(!answer.includes('Synthetic University'));assert.equal(f.db.prepare('SELECT COUNT(*) n FROM intake_registrations').get().n,1);assert.equal(f.externalCalls,0);
 }finally{await f.close();}
});

test('lookup flags and reply windows cover prompts as well as data, and media does not start an identity loop',async()=>{
 const f=await inboundFixture({followup:false});try{
  f.seedContact('whatsapp');registration(f);settings(f);
  const old=f.payload('whatsapp','identity-expired-greeting','مرحبا');old.entry[0].changes[0].value.messages[0].timestamp=String(Math.floor((Date.now()-25*3600000)/1000));await f.post('whatsapp',old);f.drain();assert.equal(outgoing(f).length,0);
  const media=f.payload('whatsapp','identity-image');const msg=media.entry[0].changes[0].value.messages[0];msg.type='image';msg.image={id:'123',caption:'مستند'};delete msg.text;await f.post('whatsapp',media);f.drain();assert.equal(outgoing(f).length,0);
  setIntakeSettings(f.db,f.users.owner,{whatsapp_auto_reply:false});await ask(f,'identity-prompt-off','مرحبا');assert.equal(outgoing(f).length,0);
 }finally{await f.close();}
});

test('lookup mismatch feedback does not trap normal chat or staff handoff in a repeated prompt loop',async()=>{
 const f=await inboundFixture({followup:false});try{
  f.seedContact('whatsapp');registration(f);settings(f);await ask(f,'identity-loop-start','مرحبا');assert.equal(outgoing(f).length,1);
  await ask(f,'identity-loop-nonmatch','اسم آخر غير مطابق');assert.equal(outgoing(f).length,2);assert.match(outgoing(f).at(-1).body,/لم أجد تطابقًا/);
  await ask(f,'identity-loop-second-nonmatch','رسالة عادية لا تتعلق بالهوية');await ask(f,'identity-loop-help-cooldown','محتاج مساعدة');assert.equal(outgoing(f).length,2);
  f.db.prepare("UPDATE messages SET created_at=? WHERE direction='out'").run(new Date(Date.now()-3*60000).toISOString());
  await ask(f,'identity-human-prompt','مرحبا');assert.equal(outgoing(f).length,3);
  await ask(f,'identity-human','عايز أكلم موظف');assert.equal(outgoing(f).length,3);
  await ask(f,'identity-after-human','رسالة عادية للفريق');assert.equal(outgoing(f).length,3);
  const c0=f.db.prepare('SELECT id FROM conversations').get();assert.equal(whatsappLookupReply(f.db,contact(f),syntheticPhone,'محتاج مساعدة',{conversationId:c0.id,phoneId:'300'}),null);
  const c=f.db.prepare('SELECT id FROM conversations').get(),m='synthetic-staff-handoff';f.db.prepare('INSERT INTO messages(id,conversation_id,direction,kind,body,payload,status,created_at) VALUES(?,?,?,?,?,?,?,?)').run(m,c.id,'out','text','الموظف يتابع المحادثة','{}','accepted',new Date(Date.now()+1).toISOString());f.db.prepare('INSERT INTO message_accounts VALUES(?,?)').run(m,'300');
  await ask(f,'identity-after-staff','رسالة عادية للفريق');assert.equal(outgoing(f).length,4);assert.equal(f.externalCalls,0);
 }finally{await f.close();}
});
