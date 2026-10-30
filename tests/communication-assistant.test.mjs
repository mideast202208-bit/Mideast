import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {openDatabase} from '../src/db.mjs';
import {uid,now,createContact} from '../src/service.mjs';
import {ensureOmniDefaults,saveChannel} from '../src/omni-config.mjs';
import {saveExtraAccount,verifyExtraAccount,accountSummary,extraAccountConfig} from '../src/accounts.mjs';
import {acceptSocialWebhook,processSocialEvents,sendSocialNext} from '../src/social.mjs';
import {acceptWebhook,processWebhookQueue,queueMessage,sendNext} from '../src/whatsapp.mjs';
import {communicationData,communicationMessages} from '../src/communication.mjs';
import {managementReport,askAssistant,saveAssistantSettings,assistantSettings} from '../src/assistant.mjs';
import {createApp} from '../src/server.mjs';
import {hashPassword} from '../src/security.mjs';

const secret='Synthetic-secret-never-live',token='Synthetic-access-token-never-live';
function fixture(){
 const db=openDatabase(':memory:'),key=Buffer.alloc(32,7),users={};
 for(const role of ['admin','agent','accountant']){const id=uid();users[role]={id,role};db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?)').run(id,'Synthetic '+role,role+'@example.test','unused',role,1,now());}
 ensureOmniDefaults(db);
 const base={phoneId:'1000',accessToken:token,appSecret:secret,verifyToken:'Synthetic-verify',version:'v26.0',intakeUser:users.admin.id};
 return {db,key,users,base};
}
const accountInput=(f,channel,id,extra={})=>({channel,account_id:id,name:'Synthetic '+channel+' '+id,intake_user:f.users.admin.id,version:'v26.0',accessToken:token+'-extra',appSecret:secret,verifyToken:'Synthetic-verify-extra',appId:'123456',wabaId:'777',...extra});
const mockAccount=id=>async(url,options={})=>({ok:true,json:async()=>url.includes('/phone_numbers')?{data:[{id}]}:options.method==='POST'?{success:true}:{id,name:'Synthetic account'}});
const signed=raw=>'sha256='+createHmac('sha256',secret).update(raw).digest('hex');

test('additional accounts are encrypted, inactive until connected, unique and bounded per channel',async()=>{
 const f=fixture(),{db,key,users,base}=f;
 try{
  const primary=saveChannel(db,users.admin,'facebook',{account_id:'100',version:'v26.0',intake_user:users.admin.id,accessToken:token,appSecret:secret,verifyToken:'Synthetic-primary-verify',active:true},key);
  const first=saveExtraAccount(db,users.admin,accountInput(f,'facebook','200'),key,base);
  assert.equal(db.prepare('SELECT active FROM communication_accounts WHERE id=?').get(first.id).active,0);
  assert.ok(!db.prepare('SELECT configuration_cipher FROM communication_accounts WHERE id=?').get(first.id).configuration_cipher.includes(token));
  assert.throws(()=>saveExtraAccount(db,users.agent,accountInput(f,'facebook','201'),key,base),e=>e.status===403);
  assert.throws(()=>saveExtraAccount(db,users.admin,accountInput(f,'facebook','100'),key,base),e=>e.status===409);
  assert.throws(()=>saveExtraAccount(db,users.admin,accountInput(f,'facebook','200'),key,base),e=>e.status===409);
  await verifyExtraAccount(db,users.admin,first.id,key,'https://crm.example.test',true,mockAccount('200'));
  const summary=accountSummary(db,base,'https://crm.example.test');assert.equal(summary.find(a=>a.id===first.id).state,'verified');
  assert.ok(!JSON.stringify(summary).includes(token));assert.ok(!JSON.stringify(summary).includes(secret));
  for(let i=201;i<209;i++)saveExtraAccount(db,users.admin,accountInput(f,'facebook',String(i)),key,base);
  assert.throws(()=>saveExtraAccount(db,users.admin,accountInput(f,'facebook','209'),key,base),e=>e.status===409);
  saveExtraAccount(db,users.admin,{name:'Updated',accessToken:token+'-rotated'},key,base,first.id);
  assert.equal(db.prepare('SELECT active FROM communication_accounts WHERE id=?').get(first.id).active,0);
  assert.equal(db.prepare('SELECT subscribed FROM communication_accounts WHERE id=?').get(first.id).subscribed,0);
 }finally{db.close();}
});

test('same sender on two Facebook pages stays on the correct page with access controls and reply credentials',async()=>{
 const f=fixture(),{db,key,users,base}=f;
 try{
  saveChannel(db,users.admin,'facebook',{account_id:'100',version:'v26.0',intake_user:users.admin.id,accessToken:token,appSecret:secret,verifyToken:'Synthetic-verify',active:true},key);
  db.prepare("UPDATE channel_accounts SET verified_at=? WHERE channel='facebook'").run(now());
  const extra=saveExtraAccount(db,users.admin,accountInput(f,'facebook','200'),key,base);await verifyExtraAccount(db,users.admin,extra.id,key,'https://crm.example.test',true,mockAccount('200'));
  const raw=Buffer.from(JSON.stringify({object:'page',entry:['100','200'].map(id=>({id,messaging:[{sender:{id:'900'},recipient:{id},timestamp:Date.now(),message:{mid:'mid-'+id,text:'Synthetic incoming'}}]}))}));
  acceptSocialWebhook(db,'facebook',raw,signed(raw),key);processSocialEvents(db,key,'https://crm.example.test');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM contacts').get().n,2);
  const inbox=communicationData(db,users.admin,base,'https://crm.example.test');assert.equal(inbox.threads.length,2);assert.equal(inbox.totals.unread,2);
  assert.equal(communicationData(db,users.agent,base,'https://crm.example.test').threads.length,0);
  assert.throws(()=>communicationMessages(db,users.agent,inbox.threads[0].key,base,key),e=>e.status===404);
  assert.throws(()=>communicationData(db,users.accountant,base,'https://crm.example.test'),e=>e.status===403);
  const sent=[];const transport=async(url,options)=>{sent.push({url,auth:options.headers.Authorization});return {ok:true,json:async()=>({message_id:'out-'+sent.length})};};
  await sendSocialNext(db,key,transport);await sendSocialNext(db,key,transport);
  assert.ok(sent.some(r=>r.url.includes('/100/messages')&&r.auth==='Bearer '+token));assert.ok(sent.some(r=>r.url.includes('/200/messages')&&r.auth==='Bearer '+token+'-extra'));
  assert.throws(()=>acceptSocialWebhook(db,'facebook',raw,'sha256=bad',key),e=>e.status===403);
 }finally{db.close();}
});

test('two WhatsApp numbers share the customer but isolate inbound windows and send from the matching number',async()=>{
 const f=fixture(),{db,key,users,base}=f;
 try{
  const extra=saveExtraAccount(db,users.admin,accountInput(f,'whatsapp','2000'),key,base);await verifyExtraAccount(db,users.admin,extra.id,key,'https://crm.example.test',true,mockAccount('2000'));
  for(const phoneId of ['1000','2000']){
   const raw=Buffer.from(JSON.stringify({object:'whatsapp_business_account',entry:[{changes:[{value:{metadata:{phone_number_id:phoneId},contacts:[{wa_id:'201000000099',profile:{name:'Synthetic customer'}}],messages:[{from:'201000000099',id:'wa-'+phoneId,timestamp:String(Math.floor(Date.now()/1000)),type:'text',text:{body:'Synthetic'}}]}}]}]}));
   acceptWebhook(db,raw);processWebhookQueue(db,base,'https://crm.example.test',key);
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM contacts').get().n,1);
  const conversation=db.prepare('SELECT * FROM conversations').get();
  db.prepare('UPDATE wa_thread_accounts SET last_inbound=? WHERE phone_id=?').run(new Date(Date.now()-25*3600000).toISOString(),'1000');
  assert.throws(()=>queueMessage(db,users.admin,conversation,{body:'Expired'},base),e=>e.status===409);
  const config=extraAccountConfig(db,'whatsapp','2000',key);queueMessage(db,users.admin,conversation,{body:'Synthetic reply'},config);
  const calls=[];await sendNext(db,base,async(url,options)=>{calls.push({url,auth:options.headers.Authorization});return {ok:true,json:async()=>({messages:[{id:'sent-2000'}]})};},key);
  assert.equal(calls.length,1);assert.ok(calls[0].url.includes('/2000/messages'));assert.equal(calls[0].auth,'Bearer '+token+'-extra');
  const inbox=communicationData(db,users.admin,base,'https://crm.example.test');assert.equal(inbox.threads.length,2);
  const primary=inbox.threads.find(t=>t.account_id==='1000'),secondary=inbox.threads.find(t=>t.account_id==='2000');
  assert.equal(communicationMessages(db,users.admin,primary.key,base,key).length,1);assert.equal(communicationMessages(db,users.admin,secondary.key,base,key).length,2);
 }finally{db.close();}
});

test('management assistant uses real scoped metrics, keeps keys secret, and external AI sends aggregates only after explicit setup',async()=>{
 const f=fixture(),{db,key,users,base}=f;
 try{
  const customer=createContact(db,users.admin,{name:'Private customer never sent',phone:'+201000000099'});
  db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?)').run(uid(),customer.id,null,'Synthetic overdue',new Date(Date.now()-3600000).toISOString(),'open',users.admin.id,now());
  const report=managementReport(db,users.admin,base,'https://crm.example.test','مين محتاج متابعة؟');assert.equal(report.metrics.overdue_tasks,1);assert.equal(report.cards[0].contact_id,customer.id);
  assert.throws(()=>managementReport(db,users.agent,base,'https://crm.example.test'),e=>e.status===403);
  const local=await askAssistant(db,users.admin,{question:'ملخص الشركة'},key,base,'https://crm.example.test',()=>{throw Error('must not call provider');});assert.equal(local.mode,'local');
  assert.throws(()=>saveAssistantSettings(db,users.admin,{enabled:true,model:'synthetic-model',apiKey:'synthetic-openai-key-not-live'},key),e=>e.status===400);
  saveAssistantSettings(db,users.admin,{enabled:true,external_data_ack:true,model:'synthetic-model',apiKey:'synthetic-openai-key-not-live'},key);
  const result=await askAssistant(db,users.admin,{question:'ملخص اليوم'},key,base,'https://crm.example.test',async(url,options)=>{
   assert.equal(url,'https://api.openai.com/v1/responses');const body=JSON.parse(options.body);assert.equal(body.store,false);assert.ok(!options.body.includes('Private customer'));assert.ok(!options.body.includes('201000000099'));assert.equal(body.tools,undefined);
   return {ok:true,json:async()=>({output:[{content:[{type:'output_text',text:'Synthetic answer from aggregate metrics'}]}]})};
  });
  assert.equal(result.mode,'openai');assert.ok(!JSON.stringify(assistantSettings(db,users.admin,key)).includes('synthetic-openai-key'));
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM audit').all()).includes('synthetic-openai-key'));
 }finally{db.close();}
});

test('HTTP communication workflow verifies an additional number, authenticates its webhook and sends through the same account',async()=>{
 const f=fixture(),{db,key,users,base}=f,password='Synthetic-login-only-2026!',hashed=await hashPassword(password);
 for(const u of Object.values(users))db.prepare('UPDATE users SET password=? WHERE id=?').run(hashed,u.id);
 const sends=[];const transport=async(url,options={})=>{
  if(url.endsWith('/messages')){sends.push({url,auth:options.headers.Authorization});return {ok:true,json:async()=>({messages:[{id:'http-out-'+sends.length}]})};}
  return mockAccount('2000')(url,options);
 };
 const app=createApp({db,secretKey:key,env:{META_PHONE_NUMBER_ID:base.phoneId,META_ACCESS_TOKEN:base.accessToken,META_APP_SECRET:base.appSecret,META_VERIFY_TOKEN:base.verifyToken,META_GRAPH_VERSION:base.version,META_INTAKE_USER_ID:base.intakeUser},transport});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const root='http://127.0.0.1:'+app.server.address().port;
 async function request(path,method='GET',body,session,headers={}){const r=await fetch(root+path,{method,headers:{'Content-Type':'application/json',...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{}),...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})});return {status:r.status,body:r.headers.get('content-type')?.includes('application/json')?await r.json():await r.text(),response:r};}
 try{
  const sessions={};for(const role of ['admin','agent']){const r=await request('/api/login','POST',{email:role+'@example.test',password});sessions[role]={cookie:r.response.headers.get('set-cookie').split(';')[0],csrf:r.body.csrf};}
  assert.equal((await request('/api/communication')).status,401);
  assert.equal((await request('/api/communication/accounts','POST',accountInput(f,'whatsapp','2000'),sessions.agent)).status,403);
  const saved=await request('/api/communication/accounts','POST',accountInput(f,'whatsapp','2000'),sessions.admin);assert.equal(saved.status,201);
  assert.equal((await request('/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=Synthetic-verify-extra&hub.challenge=synthetic-challenge')).body,'synthetic-challenge');
  assert.equal((await request('/api/communication/accounts/'+saved.body.id+'/subscribe','POST',{},sessions.admin)).status,200);
  const payload={object:'whatsapp_business_account',entry:[{changes:[{value:{metadata:{phone_number_id:'2000'},messages:[{id:'http-in-2000',from:'201000000099',timestamp:String(Math.floor(Date.now()/1000)),type:'text',text:{body:'Synthetic HTTP incoming'}}]}}]}]};
  const signature=signed(Buffer.from(JSON.stringify(payload)));
  assert.equal((await request('/webhooks/whatsapp','POST',payload,null,{'X-Hub-Signature-256':'sha256=bad'})).status,403);
  assert.equal((await request('/webhooks/whatsapp','POST',payload,null,{'X-Hub-Signature-256':signature})).status,200);await app.tick();
  const inbox=await request('/api/communication','GET',undefined,sessions.admin);assert.equal(inbox.status,200);assert.ok(!JSON.stringify(inbox.body).includes(secret));
  const thread=inbox.body.threads.find(t=>t.account_id==='2000');assert.ok(thread);assert.equal(thread.unread,1);
  const path='/api/communication/threads/'+encodeURIComponent(thread.key);
  assert.equal((await request(path+'/messages','GET',undefined,sessions.agent)).status,404);
  assert.equal((await request(path+'/messages','POST',{body:'Synthetic HTTP reply'},sessions.admin)).status,201);await app.tick();
  assert.equal(sends.length,1);assert.ok(sends[0].url.includes('/2000/messages'));
  await request(path+'/state','POST',{seen:true,status:'done'},sessions.admin);
  const updated=(await request('/api/communication','GET',undefined,sessions.admin)).body.threads.find(t=>t.key===thread.key);assert.equal(updated.unread,0);assert.equal(updated.status,'done');
  assert.equal((await request('/api/assistant','GET',undefined,sessions.agent)).status,403);
  const answer=await request('/api/assistant/ask','POST',{question:'ملخص الشركة'},sessions.admin);assert.equal(answer.status,200);assert.equal(answer.body.mode,'local');assert.equal(answer.body.metrics.customers,1);
  for(const asset of ['/workspace.js','/brand-icons.js','/workspace.css'])assert.equal((await request(asset)).status,200);
 }finally{await new Promise(resolve=>app.server.close(resolve));db.close();}
});
