import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {openDatabase} from '../src/db.mjs';
import {createApp} from '../src/server.mjs';
import {hashPassword} from '../src/security.mjs';
import {uid,now} from '../src/service.mjs';
import {installEducationWorkspace} from '../src/education.mjs';
import {ensureOmniDefaults,saveChannel,issueIntegrationKey,channelSummary} from '../src/omni-config.mjs';
import {createRegistration,processIntakeDelivery,receiptByToken} from '../src/intake.mjs';
import {runVirtualLab} from '../src/virtual-lab.mjs';
import {createSnapshot} from '../src/backups.mjs';

const payload=(extra={})=>({name:'طالب اختبار',phone:'٠١١٣٠٣٤٣٧٠٨',certificate:'ثانوي سوداني',academic_year:'2026',source:'facebook',university:'القاهرة',faculty:'الطب',consent:true,request_key:uid().replaceAll('-',''),...extra});
test('v0.4 intake, channels, public privacy, and simulation',async t=>{
  const db=openDatabase(':memory:'),key=Buffer.alloc(32,6),encoded=await hashPassword('Synthetic-test-only-2026!');
  const users={};
  for(const [name,role] of [['owner','admin'],['agent','agent'],['other','agent'],['accountant','accountant']]){
    users[name]={id:uid(),name,email:name+'@example.test',role};
    db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?)').run(users[name].id,name,users[name].email,encoded,role,1,now());
  }
  ensureOmniDefaults(db);installEducationWorkspace(db,users.owner);
  const env={PUBLIC_ORIGIN:'http://127.0.0.1:3000'};
  let outgoing=0,timeout=false;
  const transport=async()=>{outgoing++;if(timeout)throw new Error('simulated uncertainty');return {ok:true,json:async()=>({message_id:'mock-'+outgoing})};};
  const app=createApp({db,env,secretKey:key,transport});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+app.server.address().port;
  async function request(path,method='GET',body,auth,headers={}){
    const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(auth?{Cookie:auth.cookie,'X-CSRF-Token':auth.csrf}:{}),...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})});
    return {status:response.status,body:response.headers.get('content-type')?.includes('application/json')?await response.json():await response.text(),response};
  }
  const logins={};for(const [name,u] of Object.entries(users)){const r=await request('/api/login','POST',{email:u.email,password:'Synthetic-test-only-2026!'});logins[name]={cookie:r.response.headers.get('set-cookie').split(';')[0],csrf:r.body.csrf};}
  let registration,submitted;
  try{
    await t.test('registration atomically creates student, admission, task, generated file and source',async()=>{
      submitted=payload({whatsapp_opt_in:true});const r=await request('/public/registrations','POST',submitted);
      assert.equal(r.status,201);registration=r.body;
      assert.equal(db.prepare('SELECT COUNT(*) n FROM contacts').get().n,1);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM app_records').get().n,3);
      assert.equal(db.prepare('SELECT source FROM intake_registrations').get().source,'facebook');
      assert.equal(db.prepare('SELECT phone FROM contacts').get().phone,'+201130343708');
      const receipt=await request(new URL(registration.receipt_url).pathname);
      assert.equal(receipt.status,200);assert.match(receipt.body,/طالب اختبار/);
      assert.equal(receipt.response.headers.get('cache-control'),'no-store');
    });
    await t.test('idempotency rejects changed payload and preserves a single registration',async()=>{
      const replay=await request('/public/registrations','POST',submitted);assert.equal(replay.status,200);assert.equal(replay.body.reference,registration.reference);
      const changed=await request('/public/registrations','POST',{...submitted,name:'Changed'});assert.equal(changed.status,409);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM intake_registrations').get().n,1);
    });
    await t.test('new student on existing phone keeps original contact and creates separate student records',()=>{
      createRegistration(db,payload({name:'طالب ثان لنفس ولي الأمر'}),key,base);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM contacts').get().n,1);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM intake_registrations').get().n,2);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM app_records').get().n,6);
    });
    await t.test('receipt token and authenticated files enforce confidentiality',async()=>{
      assert.equal((await request('/receipt/'+'0'.repeat(64))).status,404);
      const file=db.prepare('SELECT file_id FROM intake_registrations LIMIT 1').get().file_id;
      assert.equal((await request('/api/files/'+file)).status,401);
      assert.equal((await request('/api/files/'+file,'GET',undefined,logins.other)).status,403);
      assert.equal((await request('/api/hub','GET',undefined,logins.accountant)).status,403);
    });
    await t.test('public consent, origin, honeypot, and real file validation reject invalid input before persistence',async()=>{
      const before=db.prepare('SELECT COUNT(*) n FROM intake_registrations').get().n;
      assert.equal((await request('/public/registrations','POST',payload({consent:false}))).status,400);
      assert.equal((await request('/public/registrations','POST',payload({company_url:'spam'}))).status,400);
      assert.equal((await request('/public/registrations','POST',payload(),null,{Origin:'https://foreign.invalid'})).status,403);
      assert.equal((await request('/public/registrations','POST',payload({files:[{name:'bad.pdf',mime:'application/pdf',content:Buffer.from('<script>bad</script>').toString('base64')}]}))).status,400);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM intake_registrations').get().n,before);
    });
    await t.test('form framing allows only company origins while CRM stays frame-protected',async()=>{
      const form=await request('/apply'),crm=await request('/');
      assert.match(form.response.headers.get('content-security-policy'),/frame-ancestors https:\/\/mideastedu-eg.com/);
      assert.equal(form.response.headers.get('x-frame-options'),null);
      assert.equal(crm.response.headers.get('x-frame-options'),'DENY');
    });
    await t.test('API key is create-only, non-public, and revocable',async()=>{
      const issued=await request('/api/integration-keys','POST',{name:'server connector'},logins.owner);
      assert.equal(issued.status,201);assert.ok(!db.prepare('SELECT key_hash FROM integration_keys').get().key_hash.includes(issued.body.key));
      assert.equal((await request('/api/external/registrations','POST',payload())).status,401);
      assert.equal((await request('/api/external/registrations','POST',payload(),null,{'X-MidEast-Key':issued.body.key})).status,201);
      assert.equal((await request('/api/data','GET',undefined,null,{'X-MidEast-Key':issued.body.key})).status,401);
      const hub=await request('/api/hub','GET',undefined,logins.owner);assert.ok(!JSON.stringify(hub.body).includes(issued.body.key));
      await request('/api/integration-keys/'+issued.body.id+'/revoke','POST',{},logins.owner);
      assert.equal((await request('/api/external/registrations','POST',payload(),null,{'X-MidEast-Key':issued.body.key})).status,401);
    });
    await t.test('outbound registration confirmation blocks missing Meta configuration and respects opt-in',async()=>{
      await processIntakeDelivery(db,{},key,base);
      assert.equal(db.prepare('SELECT delivery_reason FROM intake_registrations WHERE reference=?').get(registration.reference).delivery_reason,'WHATSAPP_NOT_CONFIGURED');
      assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE direction='out'").get().n,0);
      assert.ok(db.prepare("SELECT COUNT(*) n FROM intake_registrations WHERE delivery_status='not_requested'").get().n>0);
    });
    await t.test('signed social webhooks verify secrets and are idempotent; other account events are ignored',async()=>{
      saveChannel(db,users.owner,'facebook',{account_id:'2222',intake_user:users.agent.id,version:'v99.0',accessToken:'synthetic-token',appSecret:'synthetic-secret',verifyToken:'synthetic-verify',active:true},key);
      db.prepare("UPDATE channel_accounts SET verified_at=? WHERE channel='facebook'").run(now());
      const hook={object:'page',entry:[{id:'2222',messaging:[{sender:{id:'9999'},recipient:{id:'2222'},timestamp:Date.now(),message:{mid:'fb-inbound',text:'طلب تجريبي'}}]}]};
      const raw=JSON.stringify(hook),signature='sha256='+createHmac('sha256','synthetic-secret').update(raw).digest('hex');
      assert.equal((await request('/webhooks/facebook','POST',hook,null,{'X-Hub-Signature-256':'sha256=bad'})).status,403);
      assert.equal((await request('/webhooks/facebook?hub.mode=subscribe&hub.verify_token=synthetic-verify&hub.challenge=123')).body,'123');
      assert.equal((await request('/webhooks/facebook','POST',hook,null,{'X-Hub-Signature-256':signature})).status,200);
      await request('/webhooks/facebook','POST',hook,null,{'X-Hub-Signature-256':signature});
      await app.tick();
      assert.equal(db.prepare("SELECT COUNT(*) n FROM social_threads WHERE channel='facebook'").get().n,1);
      assert.equal(db.prepare("SELECT COUNT(*) n FROM social_messages WHERE provider_id='fb-inbound'").get().n,1);
      const hub=await request('/api/hub','GET',undefined,logins.owner);
      assert.ok(!JSON.stringify(hub.body).includes('synthetic-secret'));assert.ok(!JSON.stringify(hub.body).includes('synthetic-token'));
    });
    await t.test('social thread assignment and reply-window restrictions are enforced server-side',async()=>{
      const thread=db.prepare('SELECT * FROM social_threads LIMIT 1').get();
      assert.equal((await request('/api/social/threads/'+thread.id+'/messages','GET',undefined,logins.other)).status,404);
      assert.equal((await request('/api/social/threads/'+thread.id+'/messages','GET',undefined,logins.agent)).status,200);
      db.prepare("UPDATE social_threads SET last_inbound='2020-01-01T00:00:00.000Z' WHERE id=?").run(thread.id);
      assert.equal((await request('/api/social/threads/'+thread.id+'/messages','POST',{body:'late'},logins.agent)).status,409);
    });
    await t.test('reassignment transfers student and admission access with the contact',async()=>{
      const contact=db.prepare("SELECT id FROM contacts WHERE phone='+201130343708'").get();
      await request('/api/contacts/'+contact.id,'PATCH',{owner_id:users.agent.id},logins.owner);
      const assigned=(await request('/api/data','GET',undefined,logins.agent)).body;
      assert.equal(assigned.appRecords.length,9);
      await request('/api/contacts/'+contact.id,'PATCH',{owner_id:users.other.id},logins.owner);
      assert.equal((await request('/api/data','GET',undefined,logins.agent)).body.appRecords.length,0);
    });
    await t.test('virtual lab cannot use live configuration or contaminate production data',async()=>{
      const before=db.prepare('SELECT COUNT(*) n FROM contacts').get().n;
      assert.equal((await request('/api/lab/run','POST',{},logins.agent)).status,403);
      const run=await request('/api/lab/run','POST',{},logins.owner);
      assert.equal(run.status,201);assert.equal(run.body.passed,true);assert.equal(run.body.external_network_calls,0);
      assert.equal(run.body.mode,'simulation');assert.equal(run.body.live_channels_verified,false);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM contacts').get().n,before);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM lab_runs').get().n,1);
    });
    await t.test('encrypted receipt links require a recoverable backup key',async()=>{
      await assert.rejects(()=>createSnapshot(db,null,'/tmp/unused-omni-backup'),/Encryption key/);
    });
    await t.test('unknown social sends are retained without automatic duplicate delivery',async()=>{
      const thread=db.prepare('SELECT id FROM social_threads LIMIT 1').get();
      db.prepare('UPDATE social_threads SET last_inbound=? WHERE id=?').run(now(),thread.id);
      const queued=await request('/api/social/threads/'+thread.id+'/messages','POST',{body:'uncertain'},logins.agent);
      assert.equal(queued.status,201);timeout=true;const before=outgoing;await app.tick();await app.tick();
      assert.equal(outgoing,before+1);assert.equal(db.prepare('SELECT status FROM social_messages WHERE id=?').get(queued.body.id).status,'unknown');
    });
  }finally{await new Promise(resolve=>app.server.close(resolve));db.close();}
});
