import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {buildStudentFolders,createStudentRecords,filterServiceRequests} from '../public/student-records.js';
import {renderFixture,fixture} from './ui-fixture.mjs';

const row=(id,app_id,name,data)=>({id,app_id,name,data:JSON.stringify(data),owner_id:'qa-owner'});
function dataFixture(){
 const data=structuredClone(fixture);
 data.apps=[{id:'students',app_key:'me_students',name:'الطلاب'},{id:'documents',app_key:'me_documents',name:'سجل المستندات'},{id:'admissions',app_key:'me_admissions',name:'طلبات القبول'}];
 data.appRecords=[row('s1','students','أحمد علي',{guardian:'same-guardian'}),row('s2','students','أحمد علي',{guardian:'same-guardian'}),row('s3','students','سارة',{}),
  row('a1','admissions','طلب أحمد الأول',{student:'s1',reference:'ME-2026-AAAAAAAAAA',requested_service:'قبول جامعي',application_status:'جمع المستندات'}),row('a2','admissions','طلب أحمد الثاني',{student:'s2',reference:'ME-2026-BBBBBBBBBB',requested_service:'توثيق',application_status:'تم التقديم'}),row('a3','admissions','طلب سارة',{student:'s3'}),
  row('d1','documents','جواز أحمد الأول',{student:'s1',document_type:'جواز السفر',document_status:'صورة مستلمة'}),row('d2','documents','شهادة أحمد الثاني',{student:'s2',document_type:'الشهادة الدراسية',document_status:'قيد المراجعة'}),row('d3','documents','مستند بلا طالب',{student:'missing'})];
 data.appFields=[{app_id:'admissions',field_key:'student',label:'الطالب',type:'relation',relation_target:'students'},{app_id:'admissions',field_key:'requested_service',label:'الخدمة المطلوبة',type:'text'}];
 data.hub={registrations:[{id:'r1',student_id:'s1',student_name:'أحمد علي',name:'ولي أمر',reference:'ME-2026-AAAAAAAAAA',requested_service:'قبول جامعي'}]};
 return data;
}
function moduleFixture(role='admin'){
 const data=dataFixture();let user={id:'qa-owner',role},page='app:documents';const calls=[];
 const records=createStudentRecords({getData:()=>data,getUser:()=>user,getPage:()=>page,render(){},navigate:async p=>{page=p;await records.load();},api:async p=>{calls.push(p);const id=p.split('/').at(-1);return {id,name:'أحمد علي',reference:'ME-2026-AAAAAAAAAA',registrations:[],documents:[{id:id==='s1'?'d1':'d2',attachment_id:'synthetic-file'}]};}});
 return {data,records,calls,setUser:v=>user=v};
}
const dom=html=>new JSDOM(html).window.document;
test('folders separate identical names and shared guardians, include empty students, and isolate unlinked documents without mutating records',()=>{
 const data=dataFixture(),before=JSON.stringify(data),result=buildStudentFolders(data);
 assert.equal(result.folders.length,3);assert.deepEqual(result.folders.map(f=>f.documents.map(d=>d.id)),[['d1'],['d2'],[]]);assert.equal(result.unlinked[0].id,'d3');assert.notEqual(result.folders[0].reference,result.folders[1].reference);assert.equal(JSON.stringify(data),before);
 data.appRecords.push(row('s4','students','طالب جديد',{}));assert.equal(buildStudentFolders(data).folders.length,4);
});
test('service filters combine with Arabic name search and status, preserving unknown services as a distinct choice',()=>{
 const rows=dataFixture().appRecords.filter(r=>r.app_id==='admissions');
 assert.deepEqual(filterServiceRequests(rows,{service:'value:قبول جامعي'},'احمد').map(r=>r.id),['a1']);
 assert.deepEqual(filterServiceRequests(rows,{service:'unset'}).map(r=>r.id),['a3']);
 assert.equal(filterServiceRequests(rows,{service:'value:توثيق',status:'جمع المستندات'}).length,0);
 assert.equal(filterServiceRequests(rows,{service:'value:توثيق',status:'تم التقديم'}).length,1);
});
test('folder UI applies type/status/student filters, opens only one student, and resetting restores empty folders',async()=>{
 const {records,calls}=moduleFixture();let doc=dom(records.documents());assert.equal(doc.querySelectorAll('[data-action="student-folder"]').length,4);
 records.change('documents:type','جواز السفر');doc=dom(records.documents());assert.equal(doc.querySelectorAll('[data-action="student-folder"]').length,1);
 await records.action('student-folder','s1');let html=records.documents();assert.ok(html.includes('جواز أحمد الأول'));assert.ok(!html.includes('شهادة أحمد الثاني'));assert.ok(html.includes('/api/files/synthetic-file'));assert.equal(calls.length,1);
 records.change('documents:status','قيد المراجعة');assert.match(records.documents(),/لا توجد نتائج مطابقة/);
 await records.action('student-filter-reset','documents');assert.match(records.documents(),/جواز أحمد الأول/);
 await records.action('student-folder-back');assert.equal(dom(records.documents()).querySelectorAll('[data-action="student-folder"]').length,4);
 await assert.rejects(records.action('student-folder','unknown'),/غير متاح/);
});
test('staff folder contains no original file links and changing accounts clears the prior selected student',async()=>{
 const {records,setUser}=moduleFixture('agent');await records.action('student-folder','s1');assert.ok(!records.documents().includes('/api/files/'));assert.match(records.documents(),/الأصل متاح للإدارة/);
 setUser({id:'different-user',role:'agent'});assert.ok(!records.documents().includes('data-student-document='));
});
test('untrusted folder names and filter options remain text, and full app exposes filters and folder entry points',async()=>{
 const f=moduleFixture();f.data.appRecords[0].name='<img src=x onerror=alert(1)>';
 const parsed=dom(f.records.documents());assert.equal(parsed.querySelector('img,[onerror]'),null);assert.match(parsed.body.textContent,/<img/);
 const data=dataFixture(),ui=await renderFixture(data);assert.match(ui.page('app:documents'),/فلترة المستندات/);assert.match(ui.page('app:admissions'),/admissions:service/);assert.match(ui.page('app:students'),/data-action="student-folder"/);assert.match(ui.page('registrations'),/registrations:service/);assert.match(ui.page('registrations'),/فولدر الطالب/);
});
