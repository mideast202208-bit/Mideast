import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../src/db.mjs';
import {uid,now} from '../src/service.mjs';
import {installEducationWorkspace} from '../src/education.mjs';
import {ensureOmniDefaults} from '../src/omni-config.mjs';
import {createRegistration,listRegistrations,registrationFiles} from '../src/intake.mjs';
import {uploadStudentDocument,studentDossier} from '../src/student-files.mjs';
import {handleCommunication} from '../src/communication.mjs';

function fixture(){
 const db=openDatabase(':memory:'),admin={id:uid(),role:'admin'},agent={id:uid(),role:'agent'},key=Buffer.alloc(32,3);
 for(const u of [admin,agent])db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?)').run(u.id,'Synthetic',u.id+'@example.test','unused',u.role,1,now());
 ensureOmniDefaults(db);installEducationWorkspace(db,admin);
 for(const name of ['طالب أول','طالب ثان'])createRegistration(db,{name,phone:'01000000010',certificate:'ثانوي سوداني',academic_year:'2026',consent:true,request_key:uid().replaceAll('-','')},key,'https://example.test');
 const students=db.prepare('SELECT * FROM intake_registrations ORDER BY rowid').all();
 const file={name:'synthetic.pdf',mime:'application/pdf',content:Buffer.from('%PDF-1.7 synthetic fixture').toString('base64'),document_type:'جواز السفر'};
 return {db,admin,agent,students,file};
}
test('upload saves bytes and index in the selected student only, with explicit optional request association',()=>{
 const {db,admin,students:[a,b],file}=fixture();try{
  const counts=()=>db.prepare('SELECT COUNT(*) n FROM attachments').get().n,before=counts();
  const result=uploadStudentDocument(db,admin,a.student_id,{...file,application:a.admission_id});
  assert.equal(counts(),before+1);assert.equal(result.student_id,a.student_id);assert.ok(studentDossier(db,admin,a.student_id).documents.some(d=>d.id===result.id));assert.ok(!studentDossier(db,admin,b.student_id).documents.some(d=>d.id===result.id));
  assert.ok(registrationFiles(db,admin,a.id).some(d=>d.id===result.attachment_id));assert.ok(!registrationFiles(db,admin,b.id).some(d=>d.id===result.attachment_id));
  const justFolder=uploadStudentDocument(db,admin,b.student_id,file);assert.ok(studentDossier(db,admin,b.student_id).documents.some(d=>d.id===justFolder.id));assert.ok(!registrationFiles(db,admin,b.id).some(d=>d.id===justFolder.attachment_id));
  const blob=db.prepare('SELECT content FROM attachments WHERE id=?').get(result.attachment_id);assert.equal(Buffer.from(blob.content).toString(),'%PDF-1.7 synthetic fixture');
  assert.equal(listRegistrations(db,admin).find(r=>r.id===b.id).student_name,'طالب ثان');
 }finally{db.close();}
});
test('cross-student requests, staff without assignment, accountants, invalid types and spoofed files leave no partial uploads',()=>{
 const {db,admin,agent,students:[a,b],file}=fixture();try{
  const before=db.prepare('SELECT COUNT(*) n FROM attachments').get().n;
  for(const [user,id,input,status] of [[admin,a.student_id,{...file,application:b.admission_id},409],[agent,a.student_id,file,404],[{id:uid(),role:'accountant'},a.student_id,file,403],[admin,a.student_id,{...file,content:Buffer.from('not a PDF').toString('base64')},400],[admin,a.student_id,{...file,document_type:'invalid'},400],[admin,a.student_id,{...file,content:'###='},400]])assert.throws(()=>uploadStudentDocument(db,user,id,input),e=>e.status===status);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM attachments').get().n,before);
 }finally{db.close();}
});
test('upload route accepts a bounded body and returns only saved identifiers',async()=>{
 const {db,admin,students:[a],file}=fixture();try{
  let result,limit;await handleCommunication({db,user:admin,path:'/api/communication/students/'+a.student_id+'/documents',method:'POST',req:{},res:{},jsonBody:async(_,max)=>{limit=max;return file;},sendJson:(_,status,value)=>{result={status,value};}});
  assert.equal(limit,14*1024*1024);assert.equal(result.status,201);assert.equal(result.value.student_id,a.student_id);assert.deepEqual(Object.keys(result.value).sort(),['attachment_id','id','student_id']);
 }finally{db.close();}
});
test('a failed document index insert rolls back the stored file bytes too',()=>{
 const {db,admin,students:[a],file}=fixture();try{
  const count=()=>db.prepare('SELECT COUNT(*) n FROM attachments').get().n,before=count();
  db.exec("CREATE TEMP TRIGGER reject_document BEFORE INSERT ON app_records BEGIN SELECT RAISE(ABORT,'synthetic index failure'); END");
  assert.throws(()=>uploadStudentDocument(db,admin,a.student_id,file),/synthetic index failure/);
  assert.equal(count(),before);
 }finally{db.close();}
});
