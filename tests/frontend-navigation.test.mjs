import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {fixture} from './ui-fixture.mjs';

let serial=0;
async function application(role='admin',width=1200,seed){
 const data=structuredClone(fixture),user={id:'navigation-'+role,name:'Synthetic '+role,email:role+'@example.invalid',role,active:1};data.users=[user];
 data.contacts=[{id:'navigation-contact',name:'Synthetic student',phone:role==='admin'?'+201000000077':'',email:'',owner_id:user.id,source:'website',custom:'{}',created_at:'2026-11-01T00:00:00Z'}];
 const getInbox=seed?.(data,user);
 const hub={settings:{},channels:[],registrations:[],replies:[],links:{},whatsapp:{approved_templates:[]}};
 const dom=new JSDOM(readFileSync(new URL('../public/index.html',import.meta.url),'utf8'),{url:'https://navigation.example.test/'});
 Object.defineProperty(dom.window,'innerWidth',{value:width,writable:true,configurable:true});dom.window.matchMedia=()=>({matches:dom.window.innerWidth<=800});
 const saved={window:global.window,document:global.document,FormData:global.FormData,fetch:global.fetch,setInterval:global.setInterval,clearInterval:global.clearInterval};
 global.window=dom.window;global.document=dom.window.document;global.FormData=dom.window.FormData;global.setInterval=()=>0;global.clearInterval=()=>{};
 global.fetch=async path=>({ok:true,status:200,json:async()=>String(path).startsWith('/api/finance/expenses')?{month:'2026-11',totals:[],expenses:[]}:String(path).endsWith('/setup/status')?{required:false}:String(path).endsWith('/me')?{user,csrf:'synthetic-only'}:String(path).endsWith('/data')?data:String(path).endsWith('/hub')?hub:String(path).startsWith('/api/crm-inbox')?getInbox?.(new URL(path,'https://navigation.example.test').searchParams.get('date'))||{}:{}});
 await import('../public/app.js?navigation='+role+'-'+(++serial));
 const wait=async predicate=>{for(let i=0;i<120;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}assert.fail('Navigation did not reach expected state');};
 await wait(()=>dom.window.document.querySelector('.primary-navigation'));
 return {dom,document:dom.window.document,data,wait,close(){dom.window.close();for(const [k,v]of Object.entries(saved))global[k]=v;}};
}

test('primary pages and page search live in the vertical sidebar while role restrictions remain intact',async()=>{
 for(const role of ['admin','agent','accountant']){const app=await application(role);try{
  const doc=app.document,sidebar=doc.querySelector('#primary-navigation-sidebar'),topbar=doc.querySelector('.topbar');
  assert.ok(sidebar.querySelector('.primary-navigation'));assert.ok(sidebar.querySelector('#search'));assert.equal(topbar.querySelector('#search,[data-page],.avatar,.badge'),null);assert.equal(doc.querySelectorAll('#search').length,1);
  assert.equal(sidebar.getAttribute('aria-hidden'),'false');assert.equal(sidebar.inert,false);assert.equal(doc.querySelector('#workspace-main').inert,false);
  const pages=[...sidebar.querySelectorAll('[data-page]')].map(e=>e.dataset.page);
  if(role==='admin'){assert.ok(pages.includes('templates'));assert.ok(pages.includes('users'));assert.equal(sidebar.querySelector('[data-page="templates"]').closest('details'),null);}
  else{assert.ok(!pages.includes('templates'));assert.ok(!pages.includes('users'));}
  if(role==='accountant'){assert.ok(!pages.includes('contacts'));assert.ok(!pages.includes('leads'));assert.ok(pages.includes('finance'));}
  assert.equal(sidebar.querySelectorAll('[aria-current="page"]').length,1);
 }finally{app.close();}}
});

test('mobile drawer opens accessibly, traps focus, closes with overlay/Escape, and preserves native record dialogs',async()=>{
 const app=await application('admin',390);try{
  const doc=app.document,toggle=doc.querySelector('[data-navigation-toggle]'),sidebar=doc.querySelector('#primary-navigation-sidebar');
  assert.equal(toggle.getAttribute('aria-expanded'),'false');assert.equal(sidebar.inert,true);assert.equal(sidebar.getAttribute('aria-hidden'),'true');
  toggle.click();assert.equal(toggle.getAttribute('aria-expanded'),'true');assert.equal(sidebar.inert,false);assert.equal(sidebar.getAttribute('role'),'dialog');assert.equal(sidebar.getAttribute('aria-modal'),'true');assert.equal(doc.querySelector('#workspace-main').inert,true);assert.equal(doc.querySelector('[data-navigation-overlay]').hidden,false);assert.equal(doc.activeElement,doc.querySelector('[data-navigation-close]'));
  for(const el of sidebar.querySelectorAll('button,input,select,textarea,a,summary,[tabindex]'))el.getClientRects=()=>[{}];
  const last=sidebar.querySelector('[data-action="logout"]');last.focus();doc.dispatchEvent(new app.dom.window.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));assert.equal(doc.activeElement,doc.querySelector('[data-navigation-close]'));
  doc.dispatchEvent(new app.dom.window.KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}));assert.equal(doc.activeElement,last);
  doc.querySelector('#modal').setAttribute('open','');doc.dispatchEvent(new app.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));assert.equal(toggle.getAttribute('aria-expanded'),'true');doc.querySelector('#modal').removeAttribute('open');
  doc.dispatchEvent(new app.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));assert.equal(toggle.getAttribute('aria-expanded'),'false');assert.equal(doc.activeElement,toggle);assert.equal(doc.querySelector('#workspace-main').inert,false);
  toggle.click();doc.querySelector('[data-navigation-overlay]').click();assert.equal(toggle.getAttribute('aria-expanded'),'false');assert.equal(sidebar.inert,true);
  toggle.click();app.dom.window.innerWidth=1200;app.dom.window.dispatchEvent(new app.dom.window.Event('resize'));assert.equal(toggle.getAttribute('aria-expanded'),'false');assert.equal(sidebar.inert,false);assert.equal(sidebar.getAttribute('role'),'complementary');
 }finally{app.close();}
});

test('navigation closes after changing page; sidebar search and existing record display controls keep working',async()=>{
 const app=await application('admin',390);try{
  const doc=app.document;doc.querySelector('[data-navigation-toggle]').click();doc.querySelector('.primary-navigation [data-page="contacts"]').click();
  await app.wait(()=>doc.querySelector('#content h1')?.textContent==='العملاء');
  assert.equal(doc.querySelector('[data-navigation-toggle]').getAttribute('aria-expanded'),'false');assert.equal(doc.querySelector('#workspace-main').inert,false);assert.equal(doc.activeElement,doc.querySelector('#content h1'));
  assert.equal(doc.querySelector('[data-id="today"]').getAttribute('aria-pressed'),'true');
  assert.equal(doc.querySelectorAll('[data-record-id]').length,0);
  const day=doc.querySelector('[data-record-date]');day.value='2026-11-01';
  day.dispatchEvent(new app.dom.window.Event('change',{bubbles:true}));
  assert.equal(doc.querySelectorAll('[data-record-id]').length,1);
  doc.querySelector('[data-action="record-date"][data-id=""]').click();
  assert.equal(doc.querySelectorAll('[data-record-id]').length,1);
  const search=doc.querySelector('#search');search.value='No matching fictional record';search.dispatchEvent(new app.dom.window.Event('input',{bubbles:true}));assert.ok(doc.querySelector('#content').textContent.includes('لا توجد نتائج مطابقة'));
  doc.querySelector('[data-id="contacts|table"]').click();await app.wait(()=>doc.querySelector('[data-record-mode="table"]'));assert.equal(doc.querySelector('#search').value,'No matching fictional record');assert.ok(doc.querySelector('#primary-navigation-sidebar #search'));assert.equal(doc.querySelectorAll('#search').length,1);
  const current=doc.querySelector('#search');current.value='';current.dispatchEvent(new app.dom.window.Event('input',{bubbles:true}));assert.equal(doc.querySelectorAll('[data-record-id]').length,1);assert.ok(doc.querySelector('[data-action="edit-contact"]'));
 }finally{app.close();}
});

test('CRM date filters work across leads, service tabs, and contacts independently',async()=>{
 const first='2026-11-01T22:30:00.000Z',second='2026-11-02T07:00:00.000Z',previous='2026-11-01T21:30:00.000Z';
 const requests=[];
 const app=await application('admin',1200,(data,user)=>{
  data.contacts.push({...data.contacts[0],id:'current-contact',name:'عميل اليوم المختار',created_at:first});
  data.leads=[['old-lead','فرصة اليوم السابق',previous],['early-lead','فرصة الصباح الأولى',first],['late-lead','فرصة الصباح الثانية',second]]
    .map(([id,title,created_at])=>({id,title,created_at,contact_id:'current-contact',owner_id:user.id,stage:'new',value_minor:0}));
  data.tickets=[['old-ticket','تذكرة سابقة',previous],['selected-ticket','تذكرة اليوم المختار',second]]
    .map(([id,title,created_at])=>({id,title,created_at,contact_id:'current-contact',owner_id:user.id,status:'open',priority:'normal'}));
  const waiting=[{lead_id:'old-waiting',created_at:previous,title:'واردة قديمة',source:'whatsapp'},{lead_id:'new-waiting',created_at:first,title:'واردة في التاريخ المختار',source:'website'}];
  return day=>{
    requests.push(day);
    const rows=day==='2026-11-02'?waiting.slice(1):day?[]:waiting;
    return {waiting:rows,waiting_count:rows.length,activity:day?[{seq:1,kind:'enquiry',source:'website',contact_id:'current-contact',created_at:first}]:[],metrics:[],failures:[],enabled:true};
  };
 });
 try{
  const doc=app.document,query=s=>doc.querySelector(s);
  const go=async(entity,title)=>{query('.primary-navigation [data-page="'+entity+'"]').click();await app.wait(()=>query('#content h1')?.textContent===title);};
  const choose=value=>{const control=query('[data-record-date]');control.value=value;control.dispatchEvent(new app.dom.window.Event('change',{bubbles:true}));};
  const ids=selector=>[...doc.querySelectorAll(selector)].map(el=>el.dataset.recordId);
  await go('leads','فرص البيع');
  choose('2026-11-02');
  assert.deepEqual(ids('[data-record-id]'),['late-lead','early-lead']);
  await go('tickets','خدمة العملاء');
  assert.equal(query('[data-record-date]').value,'');
  choose('2026-11-02');
  await app.wait(()=>query('[data-action="crm-claim"][data-id="new-waiting"]'));
  assert.ok(requests.includes('2026-11-02'));
  assert.equal(query('[data-action="crm-claim"][data-id="old-waiting"]'),null);
  assert.match(query('#content').textContent,/عميل اليوم المختار/);
  query('[data-action="service-tab"][data-id="mine"]').click();
  assert.deepEqual([...doc.querySelectorAll('[data-action="edit-lead"]')].map(el=>el.dataset.id),['late-lead','early-lead']);
  const order=query('[data-service-order]');order.value='oldest';order.dispatchEvent(new app.dom.window.Event('change',{bubbles:true}));
  assert.deepEqual([...doc.querySelectorAll('[data-action="edit-lead"]')].map(el=>el.dataset.id),['early-lead','late-lead']);
  query('[data-action="service-tab"][data-id="tickets"]').click();
  assert.equal(query('[data-ticket="old-ticket"]'),null);
  assert.ok(query('[data-ticket="selected-ticket"]'));
  await go('contacts','العملاء');
  choose('2026-11-02');
  assert.deepEqual(ids('[data-record-id]'),['current-contact']);
  await go('leads','فرص البيع');
  assert.equal(query('[data-record-date]').value,'2026-11-02');
  query('[data-action="record-date"][data-id=""]').click();
  assert.equal(ids('[data-record-id]').length,3);
 }finally{app.close();}
});
