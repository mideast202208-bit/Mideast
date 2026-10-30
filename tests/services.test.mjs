import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../src/db.mjs';
import {uid,now} from '../src/service.mjs';
import {ensureOmniDefaults} from '../src/omni-config.mjs';
import {installEducationWorkspace} from '../src/education.mjs';
import {createRegistration,listRegistrations,receiptByToken,registrationFiles} from '../src/intake.mjs';
import {services,nonAcademicServices,requestedService} from '../public/services.js';

test('every published service persists its identity in the customer request, receipt and protected files',()=>{
 const db=openDatabase(':memory:'),key=Buffer.alloc(32,12),owner={id:uid(),role:'admin'};
 db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?)').run(owner.id,'Synthetic owner','owner@example.test','unused','admin',1,now());
 ensureOmniDefaults(db);installEducationWorkspace(db,owner);
 try{
  assert.equal(services.length,25);
  for(const service of services){
   const nonAcademic=nonAcademicServices.includes(service);
   const input={name:'طلب تجريبي',phone:'01000000099',requested_service:service,level:nonAcademic?'غير دراسي':service.includes('دراسات عليا')?'ماجستير':'بكالوريوس',...(nonAcademic?{}:{certificate:'أخرى',academic_year:'2026'}),consent:true,request_key:uid().replaceAll('-',''),files:[{name:'synthetic.pdf',mime:'application/pdf',content:Buffer.from('%PDF-1.4\nSynthetic').toString('base64')}]};
   const result=createRegistration(db,input,key,'https://crm.example.test');
   const row=listRegistrations(db,owner).find(r=>r.reference===result.reference);
   assert.equal(row.requested_service,service);
   assert.ok(db.prepare('SELECT title FROM leads WHERE id=?').get(row.lead_id).title.startsWith(service));
   const admission=db.prepare('SELECT data FROM app_records WHERE id=?').get(row.admission_id);
   assert.equal(JSON.parse(admission.data).requested_service,service);
   const receipt=receiptByToken(db,new URL(result.receipt_url).pathname.split('/').pop());
   assert.ok(Buffer.from(receipt.content).toString().includes(service));
   assert.equal(registrationFiles(db,owner,row.id).length,2);
   assert.equal(createRegistration(db,input,key,'https://crm.example.test').replayed,true);
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM contacts').get().n,1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM intake_registrations').get().n,25);
 }finally{db.close();}
});

test('existing education field options are extended without removing custom options',()=>{
 const db=openDatabase(':memory:'),owner={id:uid(),role:'admin'};
 db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?)').run(owner.id,'Synthetic','owner@example.test','unused','admin',1,now());
 try{
  installEducationWorkspace(db,owner);
  const field=db.prepare("SELECT f.* FROM app_fields f JOIN studio_apps a ON a.id=f.app_id WHERE a.app_key='me_admissions' AND f.field_key='level'").get();
  db.prepare('UPDATE app_fields SET options=? WHERE id=?').run(JSON.stringify(['بكالوريوس','ماجستير','دكتوراه','مخصص']),field.id);
  installEducationWorkspace(db,owner);
  const options=JSON.parse(db.prepare('SELECT options FROM app_fields WHERE id=?').get(field.id).options);
  assert.ok(options.includes('مخصص'));assert.ok(options.includes('غير دراسي'));
 }finally{db.close();}
});

test('legacy registration parameters retain the requested service while explicit interests take precedence',()=>{
 for(const [legacy,expected] of [['تصديق مستندات','تصديق المستندات'],['استقبال وسكن','استقبال من المطار وحجز فندقي'],['تعديل ترشيح','تعديل ترشيح - جامعي'],['بكالوريوس',services[0]],['دراسات عليا',services[9]],['تحويل من الخارج','تحويل من الخارج']]){
  const params=new URLSearchParams({service:legacy});assert.equal(requestedService(params),expected);
  params.set('interest','خدمة محددة');assert.equal(requestedService(params),'خدمة محددة');
 }
});
