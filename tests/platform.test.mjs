import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDatabase } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';
import { hashPassword } from '../src/security.mjs';
import { uid, now } from '../src/service.mjs';

test('Original Mid East platform integration and access boundaries',async t=>{
  const db=openDatabase(':memory:');const password='Synthetic-test-only-2026!';
  const encoded=await hashPassword(password);
  const accounts={};
  for(const [name,role] of [['Owner','admin'],['Agent One','agent'],['Agent Two','agent'],['Accountant','accountant']]){
    const id=uid(),email=name.replaceAll(' ','').toLowerCase()+'@example.test';
    db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?)').run(id,name,email,encoded,role,1,now());
    accounts[name]={id,email};
  }
  let sendCount=0,transportThrows=false;
  const env={PUBLIC_ORIGIN:'http://127.0.0.1:3000',META_APP_SECRET:'synthetic-secret',META_VERIFY_TOKEN:'synthetic-verify',
    META_ACCESS_TOKEN:'synthetic-not-a-real-token',META_PHONE_NUMBER_ID:'123456789',META_GRAPH_VERSION:'v99.0',META_INTAKE_USER_ID:accounts['Agent One'].id};
  const errors=[];
  const app=createApp({db,env,secretKey:Buffer.alloc(32,5),onError:error=>errors.push(error),transport:async()=>{
    sendCount++;if(transportThrows)throw new Error('Simulated timeout');
    return {ok:true,json:async()=>({messages:[{id:'out.'+sendCount}]})};
  }});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+app.server.address().port;
  const request=async(path,method='GET',body,auth)=>{
    const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(auth?{Cookie:auth.cookie,'X-CSRF-Token':auth.csrf}:{} )},...(body!==undefined?{body:JSON.stringify(body)}:{})});
    const content=response.headers.get('content-type')?.includes('application/json')?await response.json():await response.text();
    return {status:response.status,body:content,response};
  };
  const login=async name=>{
    const result=await request('/api/login','POST',{email:accounts[name].email,password});
    assert.equal(result.status,200);return {cookie:result.response.headers.get('set-cookie').split(';')[0],csrf:result.body.csrf};
  };
  const admin=await login('Owner'),one=await login('Agent One'),two=await login('Agent Two'),accountant=await login('Accountant');
  const signedWebhook=async payload=>{
    const raw=JSON.stringify(payload),signature='sha256='+createHmac('sha256',env.META_APP_SECRET).update(raw).digest('hex');
    return fetch(base+'/webhooks/whatsapp',{method:'POST',headers:{'Content-Type':'application/json','X-Hub-Signature-256':signature},body:raw});
  };
  const inbound=(id,body='أريد استشارة',phone='201130343708')=>({object:'whatsapp_business_account',entry:[{changes:[{value:{metadata:{phone_number_id:env.META_PHONE_NUMBER_ID},contacts:[{wa_id:phone,profile:{name:'Test inbound'}}],messages:[{id,from:phone,timestamp:String(Math.floor(Date.now()/1000)),type:'text',text:{body}}]}}]}]});
  let contact,lead,invoice,conversation;
  try{
    await t.test('public access cannot read CRM or create records',async()=>{
      assert.equal((await request('/api/data')).status,401);
      assert.equal((await request('/api/contacts','POST',{name:'No auth'})).status,401);
      assert.equal((await request('/')).status,200);
      assert.equal((await request('/data/mid-east.sqlite')).status,404);
      assert.equal((await request('/api/login','POST',{email:accounts.Owner.email,password:'wrong-password'})).status,401);
    });
    await t.test('CSRF and foreign origins are rejected',async()=>{
      const bad=await request('/api/contacts','POST',{name:'Denied'},{cookie:one.cookie,csrf:'wrong'});assert.equal(bad.status,403);
      const result=await fetch(base+'/api/contacts',{method:'POST',headers:{'Content-Type':'application/json',Cookie:one.cookie,'X-CSRF-Token':one.csrf,Origin:'https://foreign.example'},body:JSON.stringify({name:'Denied'})});assert.equal(result.status,403);
    });
    await t.test('contact canonical number deduplication and ownership',async()=>{
      const result=await request('/api/contacts','POST',{name:'Test student',phone:'+20 100 000 0001'},one);assert.equal(result.status,201);contact=result.body;
      assert.equal(contact.phone,'+201000000001');
      assert.equal((await request('/api/contacts','POST',{name:'Duplicate',phone:'00201000000001'},two)).status,409);
      assert.equal((await request('/api/contacts','POST',{name:'No country',phone:'01000000001'},one)).status,400);
      assert.equal((await request('/api/contacts','POST',{name:'Wrong owner',owner_id:accounts['Agent Two'].id},one)).status,403);
      const other=await request('/api/data','GET',undefined,two);assert.equal(other.body.contacts.length,0);
      assert.equal((await request('/api/contacts/'+contact.id,'PATCH',{name:'Steal'},two)).status,404);
    });
    await t.test('studio validates permissions, types and required data on server',async()=>{
      const field={entity:'contact',field_key:'certificate',label:'نوع الشهادة',type:'select',required:true,options:['IGCSE','American']};
      assert.equal((await request('/api/studio/fields','POST',field,one)).status,403);
      assert.equal((await request('/api/studio/fields','POST',field,admin)).status,201);
      assert.equal((await request('/api/contacts','POST',{name:'Missing required'},one)).status,400);
      assert.equal((await request('/api/contacts','POST',{name:'Wrong choice',custom:{certificate:'Other'}},one)).status,400);
      const result=await request('/api/contacts/'+contact.id,'PATCH',{custom:{certificate:'IGCSE'}},one);assert.equal(result.status,200);
      assert.equal((await request('/api/studio/fields','POST',{...field,field_key:'constructor'},admin)).status,400);
    });
    await t.test('stage automation creates one task for an actual stage change',async()=>{
      const rule=await request('/api/automations','POST',{name:'Follow proposal',trigger:'lead.stage_changed',condition_stage:'proposal',task_title:'Follow this proposal',due_hours:1},admin);assert.equal(rule.status,201);
      const result=await request('/api/leads','POST',{contact_id:contact.id,title:'Admission consultation',value_minor:250000},one);assert.equal(result.status,201);lead=result.body;
      assert.equal((await request('/api/leads/'+lead.id,'PATCH',{stage:'proposal'},one)).status,200);
      assert.equal((await request('/api/leads/'+lead.id,'PATCH',{stage:'proposal'},one)).status,200);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM tasks').get().n,1);
    });
    await t.test('ticket and attachment access follows customer assignment',async()=>{
      assert.equal((await request('/api/tickets','POST',{contact_id:contact.id,title:'Document question',description:'Test detail'},one)).status,201);
      const uploaded=await request('/api/contacts/'+contact.id+'/files','POST',{name:'sample.txt',mime:'text/plain',content:Buffer.from('synthetic sample').toString('base64')},one);assert.equal(uploaded.status,201);
      assert.equal((await request('/api/files/'+uploaded.body.id,'GET',undefined,two)).status,404);
      assert.equal((await request('/api/contacts/'+contact.id,'PATCH',{owner_id:accounts['Agent Two'].id},admin)).status,200);
      assert.equal((await request('/api/files/'+uploaded.body.id,'GET',undefined,one)).status,404);
      assert.equal((await request('/api/files/'+uploaded.body.id,'GET',undefined,two)).status,200);
      const data=await request('/api/data','GET',undefined,two);assert.equal(data.body.leads.length,1);assert.equal(data.body.tasks.length,1);assert.equal(data.body.tickets.length,1);
    });
    await t.test('agent cannot export, create staff or access financial records',async()=>{
      assert.equal((await request('/api/export','GET',undefined,two)).status,403);
      assert.equal((await request('/api/users','POST',{name:'Forbidden'},two)).status,403);
      assert.equal((await request('/api/invoices','POST',{contact_id:contact.id},two)).status,403);
      assert.equal((await request('/api/data','GET',undefined,accountant)).body.contacts.length,0);
    });
    await t.test('invoice and payments retain integer minor-unit balances',async()=>{
      const result=await request('/api/invoices','POST',{number:'ME-TEST-001',contact_id:contact.id,description:'Internal test',amount_minor:10000,currency:'EGP'},accountant);assert.equal(result.status,201);invoice=result.body;
      assert.equal((await request('/api/invoices/'+invoice.id+'/payments','POST',{amount_minor:100,reference:'Before issue'},accountant)).status,409);
      assert.equal((await request('/api/invoices/'+invoice.id,'PATCH',{status:'issued'},accountant)).status,200);
      assert.equal((await request('/api/invoices/'+invoice.id+'/payments','POST',{amount_minor:6000,reference:'Receipt one'},accountant)).status,201);
      assert.equal((await request('/api/invoices/'+invoice.id+'/payments','POST',{amount_minor:5000,reference:'Too much'},accountant)).status,409);
      assert.equal((await request('/api/invoices/'+invoice.id,'PATCH',{status:'void'},accountant)).status,409);
      const data=await request('/api/data','GET',undefined,accountant);assert.equal(data.body.invoices[0].paid_minor,6000);
    });
    await t.test('webhook rejects invalid signatures and confirms verification challenge',async()=>{
      const invalid=await fetch(base+'/webhooks/whatsapp',{method:'POST',headers:{'X-Hub-Signature-256':'sha256=wrong'},body:'{}'});assert.equal(invalid.status,403);
      const challenge=await fetch(base+'/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=synthetic-verify&hub.challenge=123');assert.equal(challenge.status,200);assert.equal(await challenge.text(),'123');
    });
    await t.test('signed webhook is durable, deduplicated and generates CRM records',async()=>{
      const payload=inbound('wamid.in.1');
      assert.equal((await signedWebhook(payload)).status,200);assert.equal((await signedWebhook(payload)).status,200);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM webhook_events').get().n,1);
      await app.tick();
      assert.equal(db.prepare("SELECT status FROM webhook_events").get().status,'done');
      const inboundContact=db.prepare('SELECT * FROM contacts WHERE phone=?').get('+201130343708');assert.ok(inboundContact);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM leads WHERE contact_id=?').get(inboundContact.id).n,1);
      conversation=db.prepare('SELECT * FROM conversations WHERE contact_id=?').get(inboundContact.id);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM messages').get().n,1);
      await signedWebhook({...payload,extra:'different wrapper'});await app.tick();assert.equal(db.prepare('SELECT COUNT(*) n FROM messages').get().n,1);
    });
    await t.test('callback for another configured phone is ignored',async()=>{
      const payload=inbound('wrong.phone');payload.entry[0].changes[0].value.metadata.phone_number_id='777';await signedWebhook(payload);await app.tick();
      assert.equal(db.prepare('SELECT COUNT(*) n FROM messages WHERE provider_id=?').get('wrong.phone').n,0);
    });
    await t.test('outbound text queues and simulated transport accepts it',async()=>{
      assert.equal((await request('/api/conversations/'+conversation.id+'/messages','POST',{body:'Hello'},two)).status,404);
      const result=await request('/api/conversations/'+conversation.id+'/messages','POST',{body:'Hello'},one);assert.equal(result.status,201);
      await app.tick();const message=db.prepare('SELECT * FROM messages WHERE id=?').get(result.body.id);assert.equal(message.status,'accepted');assert.equal(message.provider_id,'out.1');assert.equal(sendCount,1);
    });
    await t.test('late or out-of-order delivery events reconcile without regression',async()=>{
      const payload={object:'whatsapp_business_account',entry:[{changes:[{value:{metadata:{phone_number_id:env.META_PHONE_NUMBER_ID},statuses:[{id:'out.1',status:'read',timestamp:'100'},{id:'out.1',status:'sent',timestamp:'101'}]}}]}]};
      await signedWebhook(payload);await app.tick();assert.equal(db.prepare("SELECT status FROM messages WHERE provider_id='out.1'").get().status,'read');
    });
    await t.test('expired service window rejects free-form text',async()=>{
      db.prepare('UPDATE conversations SET last_inbound=? WHERE id=?').run(new Date(Date.now()-25*3600000).toISOString(),conversation.id);
      assert.equal((await request('/api/conversations/'+conversation.id+'/messages','POST',{body:'Too late'},one)).status,409);
      assert.equal((await request('/api/conversations/'+conversation.id+'/messages','POST',{kind:'template',template_name:'test_approved',language:'ar'},one)).status,201);
      await app.tick();assert.equal(sendCount,2);
    });
    await t.test('uncertain sends are not automatically duplicated',async()=>{
      transportThrows=true;
      const result=await request('/api/conversations/'+conversation.id+'/messages','POST',{kind:'template',template_name:'test_approved',language:'ar'},one);assert.equal(result.status,201);
      await app.tick();await app.tick();assert.equal(sendCount,3);assert.equal(db.prepare('SELECT status FROM messages WHERE id=?').get(result.body.id).status,'unknown');
    });
    await t.test('disabling a user revokes all their existing sessions',async()=>{
      assert.equal((await request('/api/users/'+accounts['Agent Two'].id,'PATCH',{active:false},admin)).status,200);
      assert.equal((await request('/api/data','GET',undefined,two)).status,401);
      assert.equal((await request('/api/users/'+accounts.Owner.id,'PATCH',{active:false},admin)).status,400);
    });
    await t.test('audit excludes credentials and provider tokens',async()=>{
      const result=await request('/api/audit','GET',undefined,admin);assert.equal(result.status,200);assert.ok(result.body.length>10);
      assert.ok(!JSON.stringify(result.body).includes(password));assert.ok(!JSON.stringify(result.body).includes(env.META_ACCESS_TOKEN));
    });
  }finally{
    await new Promise(resolve=>app.server.close(resolve));db.close();
  }
  assert.equal(errors.length,0);
});

test('backup and restore preserve database records, revoke sessions, refuse overwrite',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'mid-east-backup-test-'));
  try{
    const dbPath=join(folder,'source.sqlite'),backupDir=join(folder,'backups'),restorePath=join(folder,'restored.sqlite');
    const db=openDatabase(dbPath);db.prepare('INSERT INTO settings VALUES(?,?)').run('company_name','Synthetic backup test');
    db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?)').run('backup-user','Synthetic user','backup@example.test','synthetic-not-a-login-hash','admin',1,now());
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run('synthetic-session-hash','backup-user','synthetic-csrf',new Date(Date.now()+3600000).toISOString());
    db.close();
    const result=execFileSync(process.execPath,['scripts/backup.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,DB_PATH:dbPath,BACKUP_DIR:backupDir},encoding:'utf8'});
    const file=result.split('\n')[0].split('created: ')[1];assert.ok(file);
    execFileSync(process.execPath,['scripts/restore.mjs',file,restorePath],{cwd:new URL('..',import.meta.url)});
    const restored=openDatabase(restorePath);assert.equal(restored.prepare('SELECT value FROM settings WHERE key=?').get('company_name').value,'Synthetic backup test');assert.equal(restored.prepare('SELECT COUNT(*) n FROM sessions').get().n,0);restored.close();
    assert.throws(()=>execFileSync(process.execPath,['scripts/restore.mjs',file,restorePath],{cwd:new URL('..',import.meta.url),stdio:'pipe'}));
  }finally{rmSync(folder,{recursive:true,force:true});}
});
