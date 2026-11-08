import test from 'node:test';
import assert from 'node:assert/strict';
import { inboundFixture } from './inbound-fixture.mjs';
import { randomUUID } from 'node:crypto';
import { token,hash } from '../src/security.mjs';

function session(f,user){
  const cookie=token(),csrf=token();
  f.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(hash(cookie),user.id,csrf,new Date(Date.now()+3600000).toISOString());
  return {cookie:'me_session='+cookie,'x-csrf-token':csrf};
}
const request=async(f,path,headers={},body,method=body===undefined?'GET':'POST')=>{
  const r=await fetch(f.base+path,{method,headers:{'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:r.status,data:await r.json()};
};
const count=(f,table)=>f.db.prepare('SELECT COUNT(*) n FROM '+table).get().n;

test('website registration adds one private opportunity, contact, notification, task and conversation, and two agents cannot claim it',async()=>{
  const f=await inboundFixture({followup:false});
  try{
    const admin=session(f,f.users.owner),first=session(f,f.users.intake),second=session(f,f.users.assigned);
    assert.equal((await request(f,'/api/crm-inbox/settings',first,{enabled:true},'PATCH')).status,403);
    assert.equal((await request(f,'/api/crm-inbox/settings',admin,{enabled:true},'PATCH')).status,200);
    const payload=f.registration();
    const received=await request(f,'/public/registrations',{},payload);
    assert.equal(received.status,201);
    const diagnose='/api/crm-inbox/registrations/'+received.data.reference;
    assert.equal((await request(f,diagnose,first)).status,403);
    const diagnosis=(await request(f,diagnose,admin)).data;
    assert.equal(diagnosis.notification_recorded,1);assert.equal(diagnosis.waiting,1);
    assert.equal(diagnosis.phone,undefined);assert.equal(diagnosis.email,undefined);
    assert.equal((await request(f,'/public/registrations',{},payload)).status,200);
    for(const table of ['contacts','leads','tasks','conversations','crm_activity','crm_waiting'])assert.equal(count(f,table),1,table);
    const adminFeed=(await request(f,'/api/crm-inbox',admin)).data;
    const item=(await request(f,'/api/crm-inbox',first)).data.waiting[0];
    const lead=f.db.prepare('SELECT * FROM leads').get();
    assert.equal(item.lead_id,lead.id);assert.equal(item.contact_name,undefined);assert.equal(item.title,undefined);
    assert.equal(adminFeed.waiting[0].contact_name,payload.name);
    assert.equal((await request(f,'/api/data',first)).data.contacts.length,0);
    assert.equal((await request(f,'/api/contacts/'+lead.contact_id+'/workspace',second)).status,404);
    const results=await Promise.all([first,second].map(a=>request(f,'/api/crm-inbox/'+lead.id+'/claim',a,{})));
    assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
    const staff=[first,second],winner=results.findIndex(r=>r.status===200);
    const owned=(await request(f,'/api/data',staff[winner])).data;
    assert.equal(owned.contacts.length,1);assert.equal(owned.leads.length,1);assert.equal(owned.tasks.length,1);
    assert.equal(owned.contacts[0].phone,null);
    assert.equal((await request(f,'/api/data',staff[1-winner])).data.leads.length,0);
    assert.equal((await request(f,'/api/crm-inbox',staff[1-winner])).data.waiting.length,0);
    assert.equal((await request(f,'/api/data',admin)).data.leads.length,1);
    const timeline=(await request(f,'/api/contacts/'+lead.contact_id+'/workspace',staff[winner])).data.timeline;
    assert(timeline.some(e=>e.action==='assigned'&&e.assigned_to===e.author));
    const newOwner=[f.users.intake,f.users.assigned][1-winner];
    assert.equal((await request(f,'/api/crm-inbox/'+lead.id+'/assign',staff[winner],{owner_id:newOwner.id,reason:'إعادة توزيع'})).status,403);
    assert.equal((await request(f,'/api/crm-inbox/'+lead.id+'/assign',admin,{owner_id:newOwner.id,reason:'إعادة توزيع'})).status,200);
    assert.equal((await request(f,'/api/data',staff[winner])).data.contacts.length,0);
    assert.equal((await request(f,'/api/data',staff[1-winner])).data.contacts.length,1);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_records WHERE owner_id<>?').get(newOwner.id).n,0);
    assert.equal(f.externalCalls,0);
  }finally{await f.close();}
});

for(const channel of ['whatsapp','facebook','instagram']){
  test(channel+' creates one eligible opportunity and one notification from a repeated signed inbound message',async()=>{
    const f=await inboundFixture({followup:false});
    try{
      f.db.prepare("INSERT INTO settings VALUES('crm.claim_enabled','1')").run();
      const message=f.payload(channel,'synthetic-'+channel);
      await f.post(channel,message);f.drain();
      await f.post(channel,{...message,wrapped:1});f.drain();
      for(const table of ['contacts','leads','tasks','crm_waiting','crm_activity'])assert.equal(count(f,table),1,table);
      const contact=f.db.prepare('SELECT id FROM contacts').get();
      const admin=session(f,f.users.owner);
      const activity=(await request(f,'/api/contacts/'+contact.id+'/workspace',admin)).data.timeline;
      assert(activity.some(e=>e.action==='received'&&e.channel===channel));
      assert.equal(f.externalCalls,0);
    }finally{await f.close();}
  });
}

test('an owner can retry a failed inbound event at most three times without changing customer records',async()=>{
  const f=await inboundFixture();
  try{
    const id=randomUUID(),admin=session(f,f.users.owner),staff=session(f,f.users.intake);
    f.db.prepare("INSERT INTO webhook_events(id,digest,payload,status,created_at) VALUES(?,?,?,'error',?)")
      .run(id,hash(id),'{}',new Date().toISOString());
    const path='/api/crm-inbox/retry/whatsapp/'+id;
    assert.equal((await request(f,path,staff,{})).status,403);
    for(let n=0;n<3;n++){
      assert.equal((await request(f,path,admin,{})).status,200);
      assert.equal((await request(f,path,admin,{})).status,409);
      f.db.prepare("UPDATE webhook_events SET status='error' WHERE id=?").run(id);
    }
    assert.equal((await request(f,path,admin,{})).status,409);
    assert.equal(count(f,'contacts'),0);
  }finally{await f.close();}
});
