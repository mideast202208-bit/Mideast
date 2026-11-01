import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {openDatabase} from '../src/db.mjs';
import {createApp} from '../src/server.mjs';
import {uid,now} from '../src/service.mjs';
import {token,hash} from '../src/security.mjs';
import {saveChannel} from '../src/omni-config.mjs';
import {chatHistory} from '../public/chat-ui.js';
import {createRecordMessenger} from '../public/record-messenger.js';

async function fixture(){
 const db=openDatabase(':memory:'),key=Buffer.alloc(32,4),users={};
 for(const role of ['admin','agent','other']){const id=uid();users[role]={id,role:role==='other'?'agent':role,name:'Synthetic '+role};db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?)').run(id,users[role].name,role+'@example.invalid','unused',users[role].role,1,now());}
 const contact=uid(),conversation=uid();db.prepare('INSERT INTO contacts VALUES(?,?,?,?,?,?,?,?,?)').run(contact,'Synthetic file','+201000000077','student@example.invalid','manual',users.agent.id,'{}',now(),now());
 db.prepare('INSERT INTO conversations(id,contact_id,last_inbound,created_at) VALUES(?,?,?,?)').run(conversation,contact,now(),now());db.prepare('INSERT INTO wa_thread_accounts VALUES(?,?,?)').run(conversation,'300',now());
 const sessions={};for(const name of ['agent','other']){sessions[name]={value:token(),csrf:token()};db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(hash(sessions[name].value),users[name].id,sessions[name].csrf,new Date(Date.now()+600000).toISOString());}
 const origin='https://crm.example.test',app=createApp({db,secretKey:key,env:{PUBLIC_ORIGIN:origin,META_PHONE_NUMBER_ID:'300',META_ACCESS_TOKEN:'synthetic-only',META_GRAPH_VERSION:'v26.0',META_APP_SECRET:'synthetic-only',META_VERIFY_TOKEN:'synthetic-only',META_INTAKE_USER_ID:users.agent.id}});
 saveChannel(db,users.admin,'facebook',{account_id:'400',version:'v26.0',intake_user:users.agent.id,accessToken:'synthetic-only',appSecret:'synthetic-only',verifyToken:'synthetic-only',active:true},key);
 const social=uid();db.prepare('INSERT INTO social_threads VALUES(?,?,?,?,?,?,?)').run(social,'facebook','400','500',contact,now(),now());
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
 async function request(path,method='GET',body,actor='agent'){const session=sessions[actor],r=await fetch(base+'/api'+path,{method,headers:{Origin:origin,Cookie:'me_session='+session.value,'Content-Type':'application/json','X-CSRF-Token':session.csrf},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()};}
 return {db,contact,conversation,social,request,close:async()=>{await new Promise(r=>app.server.close(r));db.close();}};
}

test('record reply metadata is account-scoped; expired text is blocked and recipients stay server-resolved',async()=>{
 const f=await fixture();try{
  let w=await f.request('/contacts/'+f.contact+'/workspace');assert.equal(w.data.channels.find(c=>c.channel==='whatsapp').reply_window_open,true);assert.ok(!JSON.stringify(w.data).includes('+201000000077'));
  const path='/communication/threads/'+encodeURIComponent('whatsapp:'+f.conversation+':300')+'/messages';
  assert.equal((await f.request(path,'POST',{body:'Synthetic allowed text'})).status,201);
  assert.equal((await f.request(path,'POST',{body:'Do not redirect',phone:'+201000000088'})).status,400);
  assert.equal((await f.request(path,'POST',{body:'Other agent'},'other')).status,404);
  f.db.prepare('UPDATE wa_thread_accounts SET last_inbound=? WHERE conversation_id=? AND phone_id=?').run(new Date(Date.now()-25*3600000).toISOString(),f.conversation,'300');
  w=await f.request('/contacts/'+f.contact+'/workspace');assert.equal(w.data.channels.find(c=>c.channel==='whatsapp').reply_window_open,false);assert.equal(w.data.channels.find(c=>c.channel==='facebook').reply_window_open,true);
  assert.equal((await f.request(path,'POST',{body:'Expired'})).status,409);
  f.db.prepare('UPDATE wa_thread_accounts SET last_inbound=NULL WHERE conversation_id=?').run(f.conversation);
  w=await f.request('/contacts/'+f.contact+'/workspace');assert.equal(w.data.channels.find(c=>c.channel==='whatsapp').reply_window_open,false);
  const inbox=await f.request('/communication');assert.equal(inbox.data.threads.find(t=>t.channel==='whatsapp').reply_window_open,false);
  assert.equal((await f.request('/communication/threads/'+encodeURIComponent('social:'+f.social)+'/messages','POST',{body:'Synthetic Facebook reply'})).status,201);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM messages').get().n,1);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM social_messages').get().n,1);
 }finally{await f.close();}
});

test('inline WhatsApp templates require saved opt-in, cached approval and exact supported parameters',async()=>{
 const f=await fixture();try{
  const path='/communication/threads/'+encodeURIComponent('whatsapp:'+f.conversation+':300')+'/messages',input={kind:'template',template_name:'synthetic_followup',language:'ar',components:[{type:'body',parameters:[{type:'text',text:'Synthetic student'}]}]};
  f.db.prepare('UPDATE wa_thread_accounts SET last_inbound=NULL').run();
  f.db.prepare('INSERT INTO wa_templates VALUES(?,?,?,?,?,?,?)').run(uid(),input.template_name,'ar','UTILITY','APPROVED',JSON.stringify([{type:'BODY',text:'أهلًا {{1}}، نتابع طلبك.'}]),now());
  assert.equal((await f.request(path,'POST',input)).status,409);
  f.db.prepare('INSERT INTO contact_preferences VALUES(?,1,?)').run(f.contact,now());
  for(const components of [[],[{type:'body',parameters:{length:1}}],[{type:'body',parameters:[null]}],[{type:'header',parameters:[{type:'text',text:'wrong'}]}]])assert.equal((await f.request(path,'POST',{...input,components})).status,400);
  assert.equal((await f.request(path,'POST',{...input,template_name:'unapproved'})).status,409);
  assert.equal((await f.request(path,'POST',input)).status,201);const message=f.db.prepare('SELECT * FROM messages').get();assert.equal(message.status,'queued');assert.equal(message.kind,'template');assert.equal(JSON.parse(message.payload).template.components[0].parameters[0].text,'Synthetic student');
  f.db.prepare("UPDATE wa_templates SET status='REJECTED'").run();assert.equal((await f.request(path,'POST',input)).status,409);
 }finally{await f.close();}
});

test('shared conversation renderer escapes messages and keeps unknown delivery distinct from delivered',()=>{
 const html=chatHistory([{id:'safe',direction:'out',body:'<img src=x onerror=alert(1)>',status:'unknown',created_at:now(),attachment_id:'original',error_code:'<script>'}]);
 assert.ok(!html.includes('<img'));assert.ok(!html.includes('<script>'));assert.ok(html.includes('&lt;img'));assert.ok(html.includes('نتيجة غير مؤكدة'));assert.ok(!html.includes('تم التسليم'));assert.ok(!html.includes('/api/files/'));
 assert.ok(chatHistory([{id:'safe',body:'Document',created_at:now(),attachment_id:'original'}],{originals:true}).includes('/api/files/original'));
});

test('inline drafts are isolated by account and cleared on logout; closed windows disable free text',async()=>{
 const dom=new JSDOM('<section class="customer-workspace"><div id="chat"></div></section>'),root=dom.window.document.querySelector('#chat'),contact={id:'synthetic-contact',name:'Synthetic student'},channels=[{channel:'whatsapp',account_id:'300',available:true,label:'Synthetic WhatsApp',reply_window_open:true},{channel:'facebook',account_id:'400',available:true,label:'Synthetic Facebook',reply_window_open:null}],workspace={contact,channels};
 const api=async(path,method,input)=>path.endsWith('/open-channel')?{key:input.channel==='whatsapp'?'whatsapp:synthetic:300':'social:synthetic'}:path.endsWith('/messages')?[]:path.endsWith('/students')?{students:[],selected:null,requires_choice:false}:workspace;
 const messenger=createRecordMessenger({api,getUser:()=>({role:'agent'}),toast:()=>{}});messenger.mount(root,workspace);await messenger.open(channels[0]);root.querySelector('[data-message-body]').value='Draft for WhatsApp';root.querySelector('[data-message-body]').dispatchEvent(new dom.window.Event('input',{bubbles:true}));
 await messenger.open(channels[1]);assert.equal(root.querySelector('[data-message-body]').value,'');assert.equal(root.querySelector('[data-message-control="send"]').disabled,true);
 await messenger.open(channels[0]);assert.equal(root.querySelector('[data-message-body]').value,'Draft for WhatsApp');messenger.reset();messenger.mount(root,workspace);await messenger.open(channels[0]);assert.equal(root.querySelector('[data-message-body]').value,'');messenger.reset();dom.window.close();
});
