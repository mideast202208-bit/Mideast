import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {fixture} from './ui-fixture.mjs';

let serial=0;
async function application(role='admin',width=1200){
 const data=structuredClone(fixture),user={id:'navigation-'+role,name:'Synthetic '+role,email:role+'@example.invalid',role,active:1};data.users=[user];
 data.contacts=[{id:'navigation-contact',name:'Synthetic student',phone:role==='admin'?'+201000000077':'',email:'',owner_id:user.id,source:'website',custom:'{}',created_at:'2026-11-01T00:00:00Z'}];
 const hub={settings:{},channels:[],registrations:[],replies:[],links:{},whatsapp:{approved_templates:[]}};
 const dom=new JSDOM(readFileSync(new URL('../public/index.html',import.meta.url),'utf8'),{url:'https://navigation.example.test/'});
 Object.defineProperty(dom.window,'innerWidth',{value:width,writable:true,configurable:true});dom.window.matchMedia=()=>({matches:dom.window.innerWidth<=800});
 const saved={window:global.window,document:global.document,FormData:global.FormData,fetch:global.fetch,setInterval:global.setInterval,clearInterval:global.clearInterval};
 global.window=dom.window;global.document=dom.window.document;global.FormData=dom.window.FormData;global.setInterval=()=>0;global.clearInterval=()=>{};
 global.fetch=async path=>({ok:true,status:200,json:async()=>String(path).endsWith('/setup/status')?{required:false}:String(path).endsWith('/me')?{user,csrf:'synthetic-only'}:String(path).endsWith('/data')?data:String(path).endsWith('/hub')?hub:{}});
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
  const search=doc.querySelector('#search');search.value='No matching fictional record';search.dispatchEvent(new app.dom.window.Event('input',{bubbles:true}));assert.ok(doc.querySelector('#content').textContent.includes('لا توجد نتائج مطابقة'));
  doc.querySelector('[data-id="contacts|table"]').click();await app.wait(()=>doc.querySelector('[data-record-mode="table"]'));assert.equal(doc.querySelector('#search').value,'No matching fictional record');assert.ok(doc.querySelector('#primary-navigation-sidebar #search'));assert.equal(doc.querySelectorAll('#search').length,1);
  const current=doc.querySelector('#search');current.value='';current.dispatchEvent(new app.dom.window.Event('input',{bubbles:true}));assert.equal(doc.querySelectorAll('[data-record-id]').length,1);assert.ok(doc.querySelector('[data-action="edit-contact"]'));
 }finally{app.close();}
});
