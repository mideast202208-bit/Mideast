import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {filterRecordsBySearch,sectionSearch,updateSectionSearch,createStudentRecords} from '../public/student-records.js';
import {renderFixture,fixture} from './ui-fixture.mjs';
const inspect=html=>new JSDOM(html).window.document;
function sample(){
 const data=structuredClone(fixture);
 data.contacts=[{id:'c1',name:'أحمد علي',phone:'+201000000010',owner_id:'qa-owner'},{id:'c2',name:'سارة',phone:'+201000000020',owner_id:'qa-owner'}];
 data.leads=[{id:'l1',title:'خدمة تقديم',contact_id:'c1',owner_id:'qa-owner',stage:'new',value_minor:0},{id:'l2',title:'خدمة توثيق',contact_id:'c2',owner_id:'qa-owner',stage:'new',value_minor:0}];
 data.apps=[{id:'s',app_key:'me_students',name:'الطلاب'},{id:'d',app_key:'me_documents',name:'المستندات'},{id:'a',app_key:'me_admissions',name:'الطلبات'}];
 const record=(id,app_id,name,values)=>({id,app_id,name,owner_id:'qa-owner',data:JSON.stringify(values)});
 data.appRecords=[record('student-1','s','أحمد علي',{guardian:'c1'}),record('student-2','s','سارة',{guardian:'c2'}),record('request-1','a','طلب',{student:'student-1',reference:'ME-2026-ABCDEF1234'}),record('document-1','d','جواز السفر.pdf',{student:'student-1',document_type:'جواز السفر',document_status:'صورة مستلمة'}),record('document-2','d','الشهادة.pdf',{student:'student-2',document_type:'الشهادة الدراسية',document_status:'صورة مستلمة'})];
 return data;
}
test('each requested page has a visible search field, clear control and results region in the actual app',async()=>{
 const ui=await renderFixture(sample());
 for(const page of ['contacts','leads','app:s','app:d']){
  const doc=inspect(ui.page(page)),input=doc.querySelector('main [data-page-search]');assert.ok(input,page);assert.equal(input.type,'search');assert.ok(doc.querySelector('label[for="'+input.id+'"]'));assert.ok(doc.querySelector('main [data-search-results]'));assert.equal(doc.querySelector('main [data-action="clear-page-search"]').disabled,true);
 }
});
test('Arabic search finds customers, opportunities by related customer, students by file reference, and document folders by filename',async()=>{
 const ui=await renderFixture(sample());
 assert.deepEqual([...inspect(ui.searchPage('contacts','احمد')).querySelectorAll('[data-record-id]')].map(el=>el.dataset.recordId),['c1']);
 assert.deepEqual([...inspect(ui.searchPage('leads','احمد')).querySelectorAll('[data-record-id]')].map(el=>el.dataset.recordId),['l1']);
 let doc=inspect(ui.searchPage('app:s','ME-2026-ABCDEF1234'));assert.equal(doc.querySelectorAll('[data-action="edit-record"]').length,1);assert.match(doc.querySelector('[data-search-results]').textContent,/أحمد علي/);
 doc=inspect(ui.searchPage('app:s','ST-STUDENT2'));assert.equal(doc.querySelectorAll('[data-action="edit-record"]').length,1);assert.match(doc.querySelector('[data-search-results]').textContent,/سارة/);
 doc=inspect(ui.searchPage('app:d','جواز'));assert.equal(doc.querySelectorAll('[data-action="student-folder"]').length,1);assert.equal(doc.querySelector('[data-action="student-folder"]').dataset.id,'student-1');
 assert.equal(filterRecordsBySearch(sample().contacts,'+٢٠١٠٠٠٠٠٠٠١٠')[0].id,'c1');
 assert.match(inspect(ui.searchPage('leads','لا يوجد')).querySelector('[data-search-results]').textContent,/لا توجد نتائج مطابقة/);
});
test('live updates preserve focus, caret and input node, synchronize sidebar, and enable clearing without replacing filters',()=>{
 let query='';const view=()=>sectionSearch('العملاء','اسم العميل',query,query?'نتيجة واحدة':'كل النتائج');
 const document=inspect('<input id="search">'+view()),input=document.querySelector('[data-page-search]');
 input.focus();input.value='احمد';input.setSelectionRange(2,2);query=input.value;updateSectionSearch(document,query,view,input);
 assert.equal(document.activeElement,input);assert.equal(document.querySelector('[data-page-search]'),input);assert.equal(input.selectionStart,2);assert.equal(document.querySelector('#search').value,query);assert.equal(document.querySelector('[data-search-results]').textContent,'نتيجة واحدة');assert.equal(document.querySelector('[data-action="clear-page-search"]').disabled,false);
 query='';updateSectionSearch(document,query,view,null);assert.equal(input.value,'');assert.equal(document.querySelector('#search').value,'');assert.equal(document.querySelector('[data-search-results]').textContent,'كل النتائج');assert.equal(document.querySelector('[data-action="clear-page-search"]').disabled,true);
});
test('document text search intersects the current type filter and escaped queries cannot introduce markup',()=>{
 const data=sample(),records=createStudentRecords({getData:()=>data,getUser:()=>data.users[0],getPage:()=> 'app:d',render(){}});
 records.change('documents:type','الشهادة الدراسية');assert.match(records.documents('جواز'),/لا توجد نتائج مطابقة/);assert.equal(inspect(records.documents('الشهادة')).querySelector('[data-action="student-folder"]').dataset.id,'student-2');
 const doc=inspect(sectionSearch('المستندات','بحث','"><img src=x onerror=alert(1)>',''));assert.equal(doc.querySelector('img,[onerror]'),null);assert.match(doc.querySelector('input').value,/<img/);
});
