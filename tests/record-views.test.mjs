import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createRecordViews} from '../public/record-views.js';

function fixture(role='agent',storage){
 const user={id:role,role},stages={new:'جديدة',contacted:'تم التواصل',won:'مكتملة'},data={contacts:[],leads:[],tasks:[]};
 for(let i=0;i<4;i++){const id='contact-'+i;data.contacts.push({id,name:['أحمد','باسم','جمال','داليا'][i],phone:'+20100000007'+i,email:'private'+i+'@example.invalid',owner_id:role,source:i%2?'facebook':'website',created_at:'2026-10-'+(20+i)+'T12:00:00Z'});data.leads.push({id:'lead-'+i,contact_id:id,title:'طلب دراسة '+i,owner_id:role,value_minor:i*10000,stage:i%2?'contacted':'new',created_at:'2026-10-'+(20+i)+'T12:00:00Z'});}
 const make=()=>createRecordViews({getUser:()=>user,getData:()=>data,getStages:()=>stages,formatMoney:n=>n/100+' EGP',formatDate:v=>String(v).slice(0,10),sourceName:s=>s,personName:id=>'Synthetic '+id,storage});
 return {data,user,view:make(),make};
}
function inspect(html){return new JSDOM(html).window.document;}

test('all three customer and four opportunity views retain each record and its file action once',()=>{
 const f=fixture();
 for(const [entity,modes]of Object.entries({contacts:['cards','list','table'],leads:['cards','list','table','board']}))for(const mode of modes){
  assert.equal(f.view.action('record-view',entity+'|'+mode),true);const doc=inspect(f.view.view(entity,f.data[entity]));
  assert.equal(doc.querySelector('[data-record-mode]').dataset.recordMode,mode);assert.equal(doc.querySelectorAll('[data-record-id]').length,4);assert.equal(new Set([...doc.querySelectorAll('[data-record-id]')].map(e=>e.dataset.recordId)).size,4);
  assert.equal(doc.querySelectorAll('[data-action="'+(entity==='contacts'?'edit-contact':'edit-lead')+'"]').length,4);assert.equal(doc.querySelectorAll('.record-view-button[aria-pressed="true"]').length,1);
  if(entity==='leads')assert.equal(doc.querySelectorAll('[data-stage]').length,4);
 }
});

test('phone and email stay hidden in every staff presentation; manager retains contact data',()=>{
 for(const role of ['agent','manager']){const f=fixture(role);for(const mode of ['cards','list','table']){f.view.action('record-view','contacts|'+mode);const html=f.view.view('contacts',f.data.contacts);for(const c of f.data.contacts){assert.equal(html.includes(c.phone),role==='manager');assert.equal(html.includes(c.email),role==='manager');}}}
});

test('view and sort preferences survive reconstruction, are separate per account and entity, and contain no customer data',()=>{
 const saved=new Map(),storage={getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v)},f=fixture('agent',storage);
 f.view.action('record-view','contacts|table');f.view.order('contacts','name');f.view.action('record-view','leads|board');
 const again=f.make();assert.equal(inspect(again.view('contacts',f.data.contacts)).querySelector('[data-record-mode]').dataset.recordMode,'table');assert.equal(inspect(again.view('leads',f.data.leads)).querySelector('[data-record-mode]').dataset.recordMode,'board');
 f.user.id='another-account';assert.equal(inspect(again.view('contacts',f.data.contacts)).querySelector('[data-record-mode]').dataset.recordMode,'cards');
 for(const value of saved.values()){assert.deepEqual(Object.keys(JSON.parse(value)).sort(),['mode','order']);assert.ok(!value.includes('contact-'));assert.ok(!value.includes('private'));}
 const broken=fixture('agent',{getItem:()=>'{bad',setItem:()=>{throw Error('Storage unavailable');}});assert.doesNotThrow(()=>broken.view.view('contacts',broken.data.contacts));assert.doesNotThrow(()=>broken.view.action('record-view','contacts|list'));
});

test('filtered rows and ordering remain correct after mode changes, and empty results are explicit',()=>{
 const f=fixture();f.view.order('leads','value');for(const mode of ['cards','list','table','board']){f.view.action('record-view','leads|'+mode);const doc=inspect(f.view.view('leads',f.data.leads.slice(1)));assert.equal(doc.querySelectorAll('[data-record-id]').length,3);assert.ok(doc.querySelector('.record-total').textContent.includes('3 من 4'));if(mode!=='board')assert.equal(doc.querySelector('[data-record-id]').dataset.recordId,'lead-3');}
 assert.match(f.view.view('contacts',[]),/لا توجد نتائج مطابقة/);assert.ok(!f.view.view('contacts',[]).includes('data-action="edit-contact"'));
});

test('stored names, IDs, titles and source labels cannot inject HTML into any presentation',()=>{
 const f=fixture('manager');f.data.contacts[0].name='<img src=x onerror=alert(1)>';f.data.leads[0].title='<svg onload=alert(1)>';f.data.contacts[0].source='\" onclick=alert(1) x=\"';f.data.contacts[0].id='\"><script>unsafe</script>';
 for(const [entity,modes]of Object.entries({contacts:['cards','list','table'],leads:['cards','list','table','board']}))for(const mode of modes){f.view.action('record-view',entity+'|'+mode);const doc=inspect(f.view.view(entity,f.data[entity]));assert.equal(doc.querySelector('script,img,[onclick],[onload]'),null);assert.ok(doc.body.textContent.includes(entity==='contacts'?'<img src=x':'<svg onload'));}
});
