import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openDatabase } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';
import { hashPassword } from '../src/security.mjs';
import { uid, now, createContact, createLead } from '../src/service.mjs';
import { processWorkflowJobs } from '../src/workflows.mjs';
import { trustedMediaUrl, downloadMessageMedia, processMediaJob } from '../src/media.mjs';
import { base32, totp } from '../src/mfa.mjs';
import { encryptSecret, decryptSecret } from '../src/integration-settings.mjs';
import { bootstrapOwner } from '../src/bootstrap.mjs';

test('v0.2 studio, workflows, integration settings and MFA',async t=>{
  const db=openDatabase(':memory:'),key=Buffer.alloc(32,7),password='Synthetic-fixture-password!';
  const encoded=await hashPassword(password),users={};
  for(const [name,role] of [['Owner','admin'],['Agent','agent'],['Other','agent']]){
    users[name]={id:uid(),name,role,email:name.toLowerCase()+'@example.test'};
    const u=users[name];db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?)').run(u.id,name,u.email,encoded,role,1,now());
  }
  let networkCalls=0;
  const templatePage={data:[{id:'9001',name:'hello_test',language:'ar',status:'APPROVED',category:'UTILITY',components:[{type:'BODY',text:'أهلًا {{1}}'}]}]};
  const app=createApp({db,secretKey:key,env:{},transport:async url=>{networkCalls++;return new Response(JSON.stringify(templatePage),{status:200,headers:{'Content-Type':'application/json'}});}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+app.server.address().port;
  const request=async(path,method='GET',body,auth)=>{
    const response=await fetch(base+'/api'+path,{method,headers:{'Content-Type':'application/json',...(auth?{Cookie:auth.cookie,'X-CSRF-Token':auth.csrf}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
    return {status:response.status,body:await response.json(),response};
  };
  const login=async(name,code)=>{const result=await request('/login','POST',{email:users[name].email,password,...(code?{code}:{})});return {status:result.status,body:result.body,...(result.status===200?{cookie:result.response.headers.get('set-cookie').split(';')[0],csrf:result.body.csrf}:{})};};
  const admin=await login('Owner'),agent=await login('Agent'),other=await login('Other');
  let appId,fieldA,fieldB,recordId;
  const own=createContact(db,users.Agent,{name:'Synthetic own',phone:'+201000000001'});
  const foreign=createContact(db,users.Other,{name:'Synthetic other',phone:'+201000000002'});
  try{
    await t.test('studio creates original custom apps and restricts builder permissions',async()=>{
      assert.equal((await request('/studio/apps','POST',{app_key:'students',name:'ملفات الطلاب'},agent)).status,403);
      const result=await request('/studio/apps','POST',{app_key:'students',name:'ملفات الطلاب'},admin);assert.equal(result.status,201);appId=result.body.id;
      assert.equal((await request('/studio/apps','POST',{app_key:'students',name:'Duplicate'},admin)).status,409);
    });
    await t.test('custom application required fields and relations are validated',async()=>{
      const a=await request('/studio/apps/'+appId+'/fields','POST',{field_key:'guardian',label:'ولي الأمر',type:'relation',relation_target:'contact',required:true},admin);assert.equal(a.status,201);fieldA=a.body.id;
      const b=await request('/studio/apps/'+appId+'/fields','POST',{field_key:'score',label:'المجموع',type:'number'},admin);assert.equal(b.status,201);fieldB=b.body.id;
      assert.equal((await request('/apps/'+appId+'/records','POST',{name:'Missing',data:{}},agent)).status,400);
      assert.equal((await request('/apps/'+appId+'/records','POST',{name:'Foreign relation',data:{guardian:foreign.id}},agent)).status,404);
      assert.equal((await request('/apps/'+appId+'/records','POST',{name:'Wrong type',data:{guardian:own.id,score:'99'}},agent)).status,400);
      const result=await request('/apps/'+appId+'/records','POST',{name:'طالب تجريبي',data:{guardian:own.id,score:99}},agent);assert.equal(result.status,201);recordId=result.body.id;
      assert.equal((await request('/apps/'+appId+'/records','GET',undefined,other)).body.length,0);
      assert.equal((await request('/apps/'+appId+'/records/'+recordId,'PATCH',{name:'Tampered'},other)).status,404);
    });
    await t.test('application-to-application relations preserve access boundaries',async()=>{
      const result=await request('/studio/apps','POST',{app_key:'registrations',name:'التسجيلات'},admin),second=result.body.id;
      assert.equal((await request('/studio/apps/'+second+'/fields','POST',{field_key:'student',label:'الطالب',type:'relation',relation_target:appId,required:true},admin)).status,201);
      assert.equal((await request('/apps/'+second+'/records','POST',{name:'Valid link',data:{student:recordId}},agent)).status,201);
      assert.equal((await request('/apps/'+second+'/records','POST',{name:'Invalid link',data:{student:recordId}},other)).status,404);
    });
    await t.test('form order and labels persist without changing data types',async()=>{
      assert.equal((await request('/studio/reorder','POST',{entity:appId,ids:[fieldB]},admin)).status,400);
      assert.equal((await request('/studio/reorder','POST',{entity:appId,ids:[fieldB,fieldA]},admin)).status,200);
      assert.equal(db.prepare('SELECT id FROM app_fields WHERE app_id=? ORDER BY position').all(appId)[0].id,fieldB);
      assert.equal((await request('/studio/fields/'+fieldA,'PATCH',{app_id:appId,label:'جهة الاتصال',required:true},admin)).status,200);
      assert.equal(db.prepare('SELECT type FROM app_fields WHERE id=?').get(fieldA).type,'relation');
    });
    await t.test('sales stage labels and display order can be changed by management',async()=>{
      const stages=db.prepare('SELECT * FROM pipeline_stages ORDER BY position DESC').all().map(p=>({stage_key:p.stage_key,label:'مرحلة '+p.stage_key}));
      assert.equal((await request('/pipeline','PATCH',{stages},agent)).status,403);
      assert.equal((await request('/pipeline','PATCH',{stages},admin)).status,200);
      assert.equal(db.prepare('SELECT label FROM pipeline_stages ORDER BY position').get().label,'مرحلة lost');
    });
    await t.test('multi-action automation schedules, routes then creates a task once',async()=>{
      const rule={name:'Routed followup',trigger:'contact.created',delay_minutes:0,conditions:[{field:'source',op:'eq',value:'manual'}],actions:[{type:'assign',user_id:users.Other.id},{type:'task',title:'Call after routing',due_hours:2}]};
      assert.equal((await request('/automations','POST',rule,admin)).status,201);
      const result=await request('/contacts','POST',{name:'Workflow customer'},agent);assert.equal(result.status,201);
      assert.equal(db.prepare("SELECT COUNT(*) n FROM automation_jobs WHERE status='pending'").get().n,1);
      processWorkflowJobs(db);processWorkflowJobs(db);
      assert.equal(db.prepare('SELECT owner_id FROM contacts WHERE id=?').get(result.body.id).owner_id,users.Other.id);
      assert.equal(db.prepare("SELECT COUNT(*) n FROM tasks WHERE title='Call after routing'").get().n,1);
      assert.equal(db.prepare("SELECT owner_id FROM tasks WHERE title='Call after routing'").get().owner_id,users.Other.id);
    });
    await t.test('delayed workflows are not executed early and disabled rules cancel them',async()=>{
      const result=await request('/automations','POST',{name:'Deferred',trigger:'lead.created',delay_minutes:60,actions:[{type:'task',title:'Later',due_hours:1}]},admin);assert.equal(result.status,201);
      createLead(db,users.Agent,{contact_id:own.id,title:'Delayed lead'});processWorkflowJobs(db);
      assert.equal(db.prepare("SELECT COUNT(*) n FROM tasks WHERE title='Later'").get().n,0);
      await request('/automations/'+result.body.id,'PATCH',{active:false},admin);
      db.prepare('UPDATE automation_jobs SET due_at=? WHERE rule_id=?').run('2000-01-01T00:00:00.000Z',result.body.id);processWorkflowJobs(db);
      assert.equal(db.prepare('SELECT status FROM automation_jobs WHERE rule_id=?').get(result.body.id).status,'cancelled');
    });
    await t.test('integration secrets are encrypted and never returned to agents or admin UI',async()=>{
      const settings={phoneId:'12345',wabaId:'67890',version:'v99.0',intakeUser:users.Agent.id,accessToken:'synthetic-provider-secret',appSecret:'synthetic-app-secret',verifyToken:'synthetic-verify-secret',autoMedia:true};
      assert.equal((await request('/integrations/whatsapp','PATCH',settings,agent)).status,403);
      assert.equal((await request('/integrations/whatsapp','PATCH',settings,admin)).status,200);
      const stored=db.prepare("SELECT value FROM settings WHERE key='wa.accessToken'").get().value;assert.ok(!stored.includes(settings.accessToken));assert.equal(decryptSecret(stored,key),settings.accessToken);
      const display=await request('/integrations','GET',undefined,admin);assert.ok(!JSON.stringify(display.body).includes(settings.accessToken));assert.equal(display.body.whatsapp.configured,true);
      await request('/integrations/whatsapp','PATCH',{accessToken:''},admin);
      assert.equal(decryptSecret(db.prepare("SELECT value FROM settings WHERE key='wa.accessToken'").get().value,key),settings.accessToken);
    });
    await t.test('approved template metadata sync uses configured WABA ID',async()=>{
      const result=await request('/whatsapp/templates/sync','POST',{},admin);assert.equal(result.status,200);assert.equal(result.body.count,1);assert.equal(networkCalls,1);
      assert.equal(db.prepare('SELECT status FROM wa_templates').get().status,'APPROVED');
    });
    await t.test('MFA enrollment requires a valid time code and blocks password-only login',async()=>{
      const result=await request('/security/mfa/enroll','POST',{},agent);assert.equal(result.status,200);
      assert.equal((await request('/security/mfa/confirm','POST',{code:'000000'},agent)).status,400);
      const counter=Math.floor(Date.now()/30000),code=totp(result.body.secret,counter);
      assert.equal((await request('/security/mfa/confirm','POST',{code},agent)).status,200);
      assert.equal((await login('Agent')).status,401);
      assert.equal((await login('Agent',code)).status,401);
      assert.equal((await login('Agent',totp(result.body.secret,counter+1))).status,200);
    });
  }finally{await new Promise(resolve=>app.server.close(resolve));db.close();}
});

test('TOTP matches RFC test vector and authenticated encryption detects tampering',()=>{
  const secret=base32(Buffer.from('12345678901234567890'));assert.equal(totp(secret,1,8),'94287082');
  const key=Buffer.alloc(32,9),cipher=encryptSecret('synthetic private value',key);assert.equal(decryptSecret(cipher,key),'synthetic private value');
  const parts=cipher.split('.');parts[2]=(parts[2][0]==='a'?'b':'a')+parts[2].slice(1);assert.throws(()=>decryptSecret(parts.join('.'),key));
});

test('media download validates destination, digest, deduplication and archive linkage',async()=>{
  for(const url of ['http://lookaside.fbsbx.com/a','https://127.0.0.1/x','https://lookaside.fbsbx.com.evil.test/x','https://user:secret@lookaside.fbsbx.com/x'])assert.throws(()=>trustedMediaUrl(url));
  const db=openDatabase(':memory:'),user={id:uid(),name:'Test',role:'admin'};
  db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?)').run(user.id,user.name,'media@example.test','synthetic','admin',1,now());
  const contact=createContact(db,user,{name:'Test media',phone:'+201000000001'}),conversation=uid(),message=uid();
  db.prepare('INSERT INTO conversations(id,contact_id,created_at) VALUES(?,?,?)').run(conversation,contact.id,now());
  db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(message,conversation,'in.media','in','document','', '99887',JSON.stringify({filename:'sample.pdf'}),'received',null,now());
  db.prepare('INSERT INTO media_jobs(message_id,next_at) VALUES(?,?)').run(message,now());
  const bytes=Buffer.from('Synthetic file content'),digest=createHash('sha256').update(bytes).digest('hex');let calls=0;
  const config={accessToken:'synthetic',version:'v99.0',phoneId:'12345',autoMedia:true};
  const transport=async url=>{calls++;if(url.startsWith('https://graph.facebook.com/'))return new Response(JSON.stringify({url:'https://lookaside.fbsbx.com/media',mime_type:'application/pdf',file_size:bytes.length,sha256:digest}),{status:200});return new Response(bytes,{status:200});};
  try{
    await processMediaJob(db,config,transport);assert.equal(db.prepare('SELECT status FROM media_jobs').get().status,'done');
    const file=db.prepare('SELECT * FROM attachments').get();assert.equal(file.contact_id,contact.id);assert.equal(file.name,'sample.pdf');assert.deepEqual(Buffer.from(file.content),bytes);
    await downloadMessageMedia(db,config,message,transport);assert.equal(calls,2);assert.equal(db.prepare('SELECT COUNT(*) n FROM attachments').get().n,1);
  }finally{db.close();}
});

test('one-time owner setup is secret-gated and cannot replace an existing owner',async()=>{
  const db=openDatabase(':memory:'),expected='synthetic-bootstrap-token-with-more-than-32-characters';
  try{
    await assert.rejects(()=>bootstrapOwner(db,{token:'wrong',name:'Test owner',email:'owner@example.test',password:'Synthetic-test-password!'},expected),error=>error.status===403);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n,0);
    await bootstrapOwner(db,{token:expected,name:'Test owner',email:'owner@example.test',password:'Synthetic-test-password!'},expected);
    await assert.rejects(()=>bootstrapOwner(db,{token:expected,name:'Replacement',email:'replace@example.test',password:'Synthetic-test-password!'},expected),error=>error.status===409);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n,1);
  }finally{db.close();}
});
