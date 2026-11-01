import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../src/db.mjs';
import {uid,now} from '../src/service.mjs';
import {installEducationWorkspace} from '../src/education.mjs';
import {ensureOmniDefaults,saveChannel} from '../src/omni-config.mjs';
import {createRegistration,registrationFiles} from '../src/intake.mjs';
import {internationalPhone} from '../src/international.mjs';
import {countries} from '../public/countries.js';
import {documentTypes} from '../public/documents.js';
import {accountSummary,saveExtraAccount} from '../src/accounts.mjs';
import {profileUrl,saveProfile} from '../src/profiles.mjs';
import {findStudents,studentDossier,threadStudents,linkThreadStudent,openStudentWhatsApp,classifyDocument,attachStudentDocument} from '../src/student-files.mjs';
import {handleCommunication,communicationMessages} from '../src/communication.mjs';
import {createApp} from '../src/server.mjs';
function fixture(){
 const db=openDatabase(':memory:'),key=Buffer.alloc(32,4),admin={id:uid(),role:'admin'},agent={id:uid(),role:'agent'},accountant={id:uid(),role:'accountant'};
 for(const user of [admin,agent,accountant])db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?)').run(user.id,'Synthetic user',user.id+'@example.test','unused',user.role,1,now());
 ensureOmniDefaults(db);installEducationWorkspace(db,admin);
 return {db,key,admin,agent,accountant,base:{phoneId:'1000',accessToken:'synthetic-token',appSecret:'synthetic-secret',verifyToken:'synthetic',version:'v26.0',intakeUser:admin.id}};
}
const registration=(extra={})=>({name:'أحمد علي',phone:'01130343708',phone_country:'EG',nationality_code:'SD',certificate:'ثانوي سوداني',academic_year:'2026',consent:true,request_key:uid().replaceAll('-',''),...extra});
test('international numbers keep national leading zeros and nationality independent of phone country',()=>{
 assert.ok(countries.length>=250);assert.equal(new Set(countries.map(c=>c.code)).size,countries.length);
 for(const [country,local,expected] of [['EG','٠١١٣٠٣٤٣٧٠٨','+201130343708'],['SD','0912345678','+249912345678'],['SA','0501234567','+966501234567'],['IT','066982','+39066982'],['CI','0701234567','+2250701234567'],['GB','02079460000','+442079460000']])assert.equal(internationalPhone(local,country),expected);
 assert.equal(internationalPhone('00442079460000','EG'),'+442079460000');
 for(const raw of ['12','call me 01130343708','+201130343708 ext 12'])assert.throws(()=>internationalPhone(raw,'EG'),e=>e.status===400);
 assert.throws(()=>internationalPhone('01130343708','ZZ'),e=>e.status===400);
});
test('profile cards stay distinct from messaging accounts, enforce platform URLs, ownership, combined limit and merge',()=>{
 const {db,key,admin,agent,base}=fixture();try{
  saveChannel(db,admin,'facebook',{account_id:'100',version:'v26.0',intake_user:admin.id,accessToken:'synthetic',active:true},key);
  let accounts=()=>accountSummary(db,base,'https://crm.example.test');
  const merged=saveProfile(db,admin,{channel:'facebook',name:'Synthetic main page',url:'https://www.facebook.com/synthetic.qa',account_key:'primary-facebook'},accounts());
  assert.equal(accounts().filter(a=>a.channel==='facebook').length,1);assert.equal(accounts().find(a=>a.channel==='facebook').profile_id,merged.id);
  const tt=saveProfile(db,admin,{channel:'tiktok',name:'Synthetic TikTok',url:'https://www.tiktok.com/@synthetic.qa'},accounts());
  assert.equal(accounts().find(a=>a.id===tt.id).state,'profile_link');assert.equal(accounts().find(a=>a.id===tt.id).mode,'profile');
  assert.throws(()=>saveProfile(db,agent,{channel:'youtube'},accounts()),e=>e.status===403);
  for(const [ch,url] of [['youtube','https://evil.example/@qa'],['youtube','https://youtube.com/watch?v=abc'],['facebook','javascript:alert(1)'],['instagram','https://instagram.com/me?access_token=secret'],['tiktok','https://tiktok.com/@qa/video/1']])assert.throws(()=>profileUrl(ch,url),e=>e.status===400);
  for(let i=0;i<9;i++)saveProfile(db,admin,{channel:'facebook',name:'Synthetic '+i,url:'https://facebook.com/qa'+i},accounts());
  assert.throws(()=>saveProfile(db,admin,{channel:'facebook',name:'Unlink would exceed cap',url:'https://facebook.com/synthetic.qa'},accounts(),merged.id),e=>e.status===409);
  assert.throws(()=>saveProfile(db,admin,{channel:'facebook',name:'Over limit',url:'https://facebook.com/qa99'},accounts()),e=>e.status===409);
  assert.throws(()=>saveExtraAccount(db,admin,{channel:'facebook',account_id:'999',name:'Synthetic',intake_user:admin.id},key,base),e=>e.status===409);
 }finally{db.close();}
});
test('WhatsApp attachments can be indexed once on the selected student and never borrowed from another company number',()=>{
 const {db,key,admin,base}=fixture();try{
  createRegistration(db,registration(),key,'https://crm.example.test');const student=db.prepare('SELECT * FROM intake_registrations').get();
  const opened=openStudentWhatsApp(db,admin,student.student_id,'1000',accountSummary(db,base,'')),conversation=db.prepare('SELECT * FROM conversations').get(),row={...conversation,key:opened.key,kind:'whatsapp',account_id:'1000'};
  const message=uid(),attachment=uid();db.prepare("INSERT INTO messages(id,conversation_id,direction,kind,body,status,created_at) VALUES(?,?,'in','document','','received',?)").run(message,conversation.id,now());db.prepare('INSERT INTO message_accounts VALUES(?,?)').run(message,'2000');
  db.prepare('INSERT INTO attachments VALUES(?,?,?,?,?,?,?)').run(attachment,student.contact_id,message,'synthetic.pdf','application/pdf',Buffer.from('%PDF-1.7 synthetic'),now());
  const input={student_id:student.student_id,attachment_id:attachment,document_type:documentTypes.passport};
  assert.throws(()=>attachStudentDocument(db,admin,row,input,base),e=>e.status===404);
  db.prepare('UPDATE message_accounts SET phone_id=? WHERE message_id=?').run('1000',message);
  const saved=attachStudentDocument(db,admin,row,input,base);assert.equal(attachStudentDocument(db,admin,row,input,base).replayed,true);assert.equal(studentDossier(db,admin,student.student_id).documents.filter(d=>d.id===saved.id).length,1);
 }finally{db.close();}
});
test('public tour and international form load static assets without exposing private communication data',async()=>{
 const {db,key,admin,base}=fixture(),app=createApp({db,secretKey:key,env:{META_PHONE_NUMBER_ID:base.phoneId,META_INTAKE_USER_ID:admin.id}});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const root='http://127.0.0.1:'+app.server.address().port;
 try{
  for(const path of ['/tour','/tour.js','/countries.js','/documents.js','/student-records.js','/student-records.css','/phone-lib.js','/apply']){const r=await fetch(root+path);assert.equal(r.status,200,path);const body=await r.text();assert.ok(body.length>100);if(path==='/tour')assert.match(body,/بيانات افتراضية/);if(path==='/apply'){assert.match(body,/name="phone_country"/);assert.match(body,/upload-document-type/);}}
  for(const path of ['/api/communication','/api/communication/students/demo','/api/communication/threads/whatsapp%3Ademo%3A1000/students'])assert.equal((await fetch(root+path)).status,401);
 }finally{await new Promise(resolve=>app.server.close(resolve));db.close();}
});
test('categorized files persist, replay checks include classification and student search handles name, reference, Arabic phone and ACL',()=>{
 const {db,key,admin,agent,accountant}=fixture();try{
  const input=registration({files:[{name:'synthetic.pdf',mime:'application/pdf',content:Buffer.from('%PDF-1.7 synthetic').toString('base64'),document_type:documentTypes.passport}]});
  const result=createRegistration(db,input,key,'https://crm.example.test'),row=db.prepare('SELECT * FROM intake_registrations').get();
  assert.equal(createRegistration(db,input,key,'https://crm.example.test').replayed,true);
  assert.throws(()=>createRegistration(db,{...input,files:[{...input.files[0],document_type:documentTypes.birth}]},key,'https://crm.example.test'),e=>e.status===409);
  const files=registrationFiles(db,admin,row.id);assert.equal(files.find(f=>f.mime==='application/pdf').document_type,documentTypes.passport);
  const dossier=studentDossier(db,admin,row.student_id);assert.equal(dossier.nationality,'السودان');assert.equal(dossier.nationality_code,'SD');assert.equal(dossier.phone,'+201130343708');assert.equal(dossier.checklist.find(d=>d.key==='passport').count,1);
  for(const query of ['احمد',result.reference,'+٢٠١١٣٠٣٤٣٧٠٨'])assert.equal(findStudents(db,admin,query)[0].id,row.student_id);
  assert.equal(findStudents(db,agent,'احمد').length,0);assert.throws(()=>studentDossier(db,agent,row.student_id),e=>e.status===404);assert.throws(()=>findStudents(db,accountant,'احمد'),e=>e.status===403);
  const document=files.find(f=>f.mime==='application/pdf');assert.throws(()=>classifyDocument(db,agent,document.document_id,documentTypes.birth),e=>e.status===404);
  classifyDocument(db,admin,document.document_id,documentTypes.birth);assert.equal(studentDossier(db,admin,row.student_id).checklist.find(d=>d.key==='birth').count,1);
 }finally{db.close();}
});
test('shared guardian requires a student choice, rejects cross-customer and stale context, and records each reply on its student and number',async()=>{
 const f=fixture(),{db,key,admin,agent,base}=f;try{
  createRegistration(db,registration(),key,'https://crm.example.test');createRegistration(db,registration({name:'سارة علي'}),key,'https://crm.example.test');createRegistration(db,registration({name:'طالب آخر',phone:'01000000099'}),key,'https://crm.example.test');
  const all=db.prepare('SELECT * FROM intake_registrations ORDER BY rowid').all(),[first,second,other]=all;
  const opened=openStudentWhatsApp(db,admin,first.student_id,'1000',accountSummary(db,base,'')),row={key:opened.key,contact_id:first.contact_id},conversation=db.prepare('SELECT * FROM conversations').get();
  db.prepare('DELETE FROM thread_student_context').run();assert.equal(threadStudents(db,admin,row).requires_choice,true);
  assert.throws(()=>linkThreadStudent(db,admin,row,other.student_id),e=>e.status===409);assert.throws(()=>openStudentWhatsApp(db,agent,first.student_id,'1000',accountSummary(db,base,'')),e=>e.status===404);
  const request=async(body)=>{let result;await handleCommunication({db,user:admin,path:'/api/communication/threads/'+encodeURIComponent(opened.key)+'/messages',method:'POST',req:{},res:{},jsonBody:async()=>body,sendJson:(_,status,value)=>{result={status,value};},secretKey:key,origin:'https://crm.example.test',config:base});return result;};
  await assert.rejects(request({body:'Synthetic'}),e=>e.status===409);
  linkThreadStudent(db,admin,row,second.student_id);
  await assert.rejects(request({body:'Synthetic',student_id:first.student_id}),e=>e.status===409);
  await assert.rejects(request({body:'No open service window',student_id:second.student_id}),e=>e.status===409);
  db.prepare('UPDATE wa_thread_accounts SET last_inbound=? WHERE conversation_id=? AND phone_id=?').run(now(),conversation.id,'1000');
  const sent=await request({body:'Synthetic response',student_id:second.student_id,include_reference:true});assert.equal(sent.status,201);
  const mapping=db.prepare('SELECT * FROM message_student_links').get();assert.equal(mapping.student_id,second.student_id);assert.equal(mapping.reference,second.reference);
  const messages=communicationMessages(db,admin,opened.key,base,key);assert.match(messages[0].body,new RegExp(second.reference));assert.equal(messages[0].student_reference,second.reference);assert.equal(db.prepare('SELECT phone_id FROM message_accounts WHERE message_id=?').get(mapping.message_id).phone_id,'1000');
 }finally{db.close();}
});
