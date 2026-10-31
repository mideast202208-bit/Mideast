import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
import {openDatabase} from '../src/db.mjs';
import {createApp} from '../src/server.mjs';
import {uid,now} from '../src/service.mjs';
import {token,hash} from '../src/security.mjs';
import {encryptSecret} from '../src/integration-settings.mjs';
import {customerChannelButtons,customerTimeline,customerMailHistory} from '../public/customer-panel.js';

test('customer panel escapes stored notes, subjects, actors and channel labels, and has no external recipient links',()=>{
 const w={contact:{id:uid(),name:'Synthetic'},channels:[{channel:'email',available:false,label:'<img src=x>',reason:'<script>unsafe</script>'}],timeline:[{label:'<img src=x>',author:'<svg/onload=alert(1)>',created_at:now(),body:'<script>unsafe</script>'}],email_history:[{subject:'<img src=x>',status:'unknown',updated_at:now()}]};w.last_activity=w.timeline[0];
 const html=customerChannelButtons(w)+customerTimeline(w)+customerMailHistory(w);assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<img src=x>'));assert.ok(html.includes('&lt;script&gt;'));assert.ok(html.includes('disabled'));assert.ok(!/mailto:|wa\.me|api\.whatsapp/.test(html));assert.ok(html.includes('نتيجة غير مؤكدة'));
});

test('real application DOM and HTTP routes: staff notes/contact buttons work without addresses; manager retains visibility',async()=>{
 const db=openDatabase(':memory:'),key=Buffer.alloc(32,7),users={},sessions={};
 for(const role of ['agent','manager']){const id=uid();users[role]={id,name:'Synthetic '+role};db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?)').run(id,users[role].name,role+'@example.invalid','synthetic-only-password',role,1,now());const value=token(),csrf=token();sessions[role]={value,csrf};db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(hash(value),id,csrf,new Date(Date.now()+600000).toISOString());}
 const contact={id:uid(),name:'Synthetic student',phone:'+201000000077',email:'student@example.invalid'};db.prepare('INSERT INTO contacts VALUES(?,?,?,?,?,?,?,?,?)').run(contact.id,contact.name,contact.phone,contact.email,'manual',users.agent.id,'{}',now(),now());
 const app=createApp({db,secretKey:key,env:{PUBLIC_ORIGIN:'https://crm.example.test',META_PHONE_NUMBER_ID:'300',META_ACCESS_TOKEN:'synthetic-token',META_APP_SECRET:'synthetic-secret',META_VERIFY_TOKEN:'synthetic-verify',META_GRAPH_VERSION:'v26.0',META_INTAKE_USER_ID:users.agent.id}});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
 const saved={document:global.document,window:global.window,FormData:global.FormData,fetch:global.fetch,setInterval:global.setInterval,clearInterval:global.clearInterval,setTimeout:global.setTimeout,clearTimeout:global.clearTimeout},realFetch=global.fetch,realTimeout=global.setTimeout;const timers=[];
 const wait=async predicate=>{for(let i=0;i<150;i++){if(predicate())return;await new Promise(r=>realTimeout(r,10));}assert.fail('Application DOM did not reach expected state');};
 try{
  const asset=await realFetch(base+'/customer-panel.js');assert.equal(asset.status,200);
  for(const role of ['agent','manager']){
   const dom=new JSDOM(readFileSync(new URL('../public/index.html',import.meta.url),'utf8'),{url:base});global.window=dom.window;global.document=dom.window.document;global.FormData=dom.window.FormData;dom.window.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};dom.window.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
   global.setInterval=()=>0;global.clearInterval=()=>{};global.setTimeout=(fn,ms,...args)=>{const id=realTimeout(fn,Math.min(ms,20),...args);timers.push(id);return id;};
   global.fetch=(url,init={})=>realFetch(new URL(url,base),{...init,headers:{...init.headers,Origin:'https://crm.example.test',Cookie:'me_session='+sessions[role].value}});
   await import('../public/app.js?customer-panel-role='+role);assert.ok(document.querySelector('[data-page="contacts"]'));
   document.querySelector('[data-page="contacts"]').click();await wait(()=>document.querySelector('[data-action="edit-contact"]'));
   if(role==='agent'){assert.ok(!document.querySelector('#app').innerHTML.includes(contact.phone));assert.ok(!document.querySelector('#app').innerHTML.includes(contact.email));}
   document.querySelector('[data-action="edit-contact"]').click();await wait(()=>document.querySelectorAll('.customer-channel').length===4);
   if(role==='agent'){
    assert.equal(document.querySelector('#editor [name="phone"]'),null);assert.equal(document.querySelector('#editor [name="email"]'),null);assert.ok(!document.querySelector('#modal').innerHTML.includes(contact.phone));assert.ok(!document.querySelector('#modal').innerHTML.includes(contact.email));
    document.querySelector('#note-body').value='Synthetic employee completed document review';document.querySelector('[data-action="add-note"]').click();await wait(()=>document.querySelector('.customer-timeline')?.textContent.includes('Synthetic employee completed document review'));
    assert.equal(db.prepare('SELECT body FROM customer_notes WHERE contact_id=?').get(contact.id).body,'Synthetic employee completed document review');
    const mailButton=[...document.querySelectorAll('.customer-channel')].find(b=>b.classList.contains('email'));assert.ok(mailButton.disabled);
    const wa=[...document.querySelectorAll('.customer-channel')].find(b=>b.classList.contains('whatsapp'));assert.equal(wa.disabled,false);wa.click();await wait(()=>document.querySelector('.unified-chat-head'));
    assert.ok(document.querySelector('.unified-chat-head').textContent.includes(contact.name));assert.ok(!document.querySelector('#app').innerHTML.includes(contact.phone));assert.ok(!document.querySelector('#app').innerHTML.includes(contact.email));
    // Configure only the in-memory fixture. No worker or external SMTP call runs.
    db.prepare("INSERT INTO settings VALUES('email.smtp',?)").run(encryptSecret(JSON.stringify({host:'smtp.gmail.com',port:465,user:'company@example.invalid',from:'company@example.invalid',pass:'synthetic-only',verified_at:now()}),key));
    document.querySelector('.unified-chat-head [data-action="edit-contact"]').click();await wait(()=>document.querySelector('.customer-channel.email')&&!document.querySelector('.customer-channel.email').disabled);document.querySelector('.customer-channel.email').click();await wait(()=>document.querySelector('#editor [name="subject"]'));
    assert.equal(document.querySelector('#editor [name="to"]'),null);assert.ok(!document.querySelector('#modal').innerHTML.includes(contact.email));document.querySelector('#editor [name="subject"]').value='Synthetic email from CRM';document.querySelector('#editor [name="body"]').value='Synthetic followup only.';document.querySelector('#editor').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));await wait(()=>db.prepare('SELECT COUNT(*) n FROM customer_email_jobs').get().n===1);await wait(()=>!document.querySelector('#modal').hasAttribute('open'));
    assert.equal(db.prepare('SELECT created_by FROM customer_email_jobs').get().created_by,users.agent.id);assert.equal(db.prepare('SELECT status FROM customer_email_jobs').get().status,'queued');
   }else{assert.equal(document.querySelector('#editor [name="phone"]').value,contact.phone);assert.equal(document.querySelector('#editor [name="email"]').value,contact.email);assert.ok(document.querySelector('.customer-timeline').textContent.includes('Synthetic employee completed document review'));}
   for(const id of timers.splice(0))saved.clearTimeout(id);dom.window.close();
  }
 }finally{for(const [key,value]of Object.entries(saved))global[key]=value;for(const id of timers)saved.clearTimeout(id);await new Promise(r=>app.server.close(r));db.close();}
});
