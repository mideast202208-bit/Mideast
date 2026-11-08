import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { inboundFixture,syntheticPhone } from './inbound-fixture.mjs';
import { hash } from '../src/security.mjs';
import { createRegistration } from '../src/intake.mjs';
import { saveRecord } from '../src/studio.mjs';

test('quick enquiry uses the assigned contact, stays private and can be promoted exactly once by its responsible staff',async()=>{
  const f=await inboundFixture({followup:false});
  try{
    const contact=f.seedContact('whatsapp');
    const data={name:'Synthetic guardian',phone:'٠١٠٠٠٠٠٠٠٧٧',phone_country:'EG',service:'استشارة وتواصل مع الفريق',source:'google_business',campaign:'synthetic campaign',consent:true,request_key:randomUUID()};
    const post=(body,origin=f.origin)=>fetch(f.base+'/public/enquiries',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(body)});
    assert.equal((await post({...data,consent:false})).status,400);
    assert.equal((await post({...data,files:[]})).status,400);
    assert.equal((await post(data,'https://foreign.example.test')).status,403);
    const pair=await Promise.all([post(data),post(data)]);
    assert.deepEqual(pair.map(r=>r.status).sort(),[200,201]);
    const results=await Promise.all(pair.map(r=>r.json()));
    assert.equal(results[0].reference,results[1].reference);
    assert.deepEqual(Object.keys(results[0]).sort(),['reference','replayed']);
    assert.equal((await post({...data,notes:'changed'})).status,409);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM contacts').get().n,1);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM tasks').get().n,1);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_records').get().n,0);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM contact_preferences').get().n,0);
    const q=f.db.prepare('SELECT * FROM quick_enquiries').get();
    const lead=f.db.prepare('SELECT * FROM leads').get();
    assert.equal(lead.owner_id,contact.owner_id);
    assert.equal(q.source,'google_business');
    const endpoint=f.base+'/api/enquiries/'+lead.id+'/registration-link';
    assert.equal((await fetch(endpoint,{method:'POST'})).status,401);
    const sessionHeaders=user=>{
      const session=hash(randomUUID()),csrf=hash(randomUUID());
      f.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(hash(session),user.id,csrf,new Date(Date.now()+3600000).toISOString());
      return {Cookie:'me_session='+session,'X-CSRF-Token':csrf};
    };
    const other=sessionHeaders(f.users.intake),assigned=sessionHeaders(f.users.assigned);
    assert.equal((await fetch(endpoint,{method:'POST',headers:other})).status,404);
    assert.equal((await (await fetch(f.base+'/api/hub',{headers:other})).json()).enquiries.length,0);
    const response=await fetch(endpoint,{method:'POST',headers:assigned});
    assert.equal(response.status,200);
    const url=new URL((await response.json()).registration_url);
    const body=f.registration({source:'website',link_token:url.searchParams.get('client'),enquiry_lead_id:url.searchParams.get('enquiry')});
    assert.throws(()=>createRegistration(f.db,{...body,phone:'+201000000088'},f.key,f.origin),e=>e.status===409);
    assert.throws(()=>createRegistration(f.db,{...body,enquiry_lead_id:randomUUID()},f.key,f.origin),e=>e.status===400);
    const registered=createRegistration(f.db,body,f.key,f.origin);
    assert.equal(createRegistration(f.db,body,f.key,f.origin).reference,registered.reference);
    assert.throws(()=>createRegistration(f.db,{...body,request_key:randomUUID()},f.key,f.origin),e=>e.status===409);
    const row=f.db.prepare('SELECT * FROM intake_registrations').get();
    assert.equal(row.lead_id,lead.id);
    assert.equal(row.campaign,'synthetic campaign');
    assert.equal(row.source,'google_business');
    assert.equal(f.db.prepare('SELECT phone FROM contacts').get().phone,syntheticPhone);
    assert.equal((await (await fetch(f.base+'/api/hub',{headers:assigned})).json()).enquiries[0].registered,1);
    assert.equal(f.externalCalls,0);
  }finally{await f.close();}
});

test('an admission has its own season, confirmed enrolment evidence and concurrent edit guard',async()=>{
  const f=await inboundFixture({followup:false});
  try{
    createRegistration(f.db,f.registration({academic_year:'2026/2027'}),f.key,f.origin);
    const row=f.db.prepare('SELECT a.* FROM intake_registrations r JOIN app_records a ON a.id=r.admission_id').get();
    const data=JSON.parse(row.data);
    assert.equal(data.academic_year,'2026/2027');
    const confirmed={...data,application_status:'قيد مؤكد'};
    assert.throws(()=>saveRecord(f.db,f.users.owner,row.app_id,{data:confirmed},row.id),e=>e.status===400);
    const evidence={...confirmed,official_reference:'SYNTHETIC-ENROLMENT',decision_date:'2026-11-07'};
    saveRecord(f.db,f.users.owner,row.app_id,{data:evidence,expected_updated_at:row.updated_at},row.id);
    assert.throws(()=>saveRecord(f.db,f.users.owner,row.app_id,{data,expected_updated_at:row.updated_at},row.id),e=>e.status===409);
    const audit=f.db.prepare("SELECT metadata FROM audit WHERE entity_id=? AND action='updated'").get(row.id);
    assert.equal(JSON.parse(audit.metadata).to_status,'قيد مؤكد');
    assert.equal(f.db.prepare('SELECT stage FROM leads').get().stage,'new');
    const page=await fetch(f.base+'/enquire');
    assert.equal(page.headers.get('X-Robots-Tag'),'noindex, nofollow');
    assert.match(await page.text(),/استفسار سريع/);
    const anonymous=await fetch(f.base+'/api/data');
    assert.equal(anonymous.status,401);
    assert.equal(anonymous.headers.get('X-Robots-Tag'),'noindex, nofollow');
  }finally{await f.close();}
});
