import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.mjs';
import { createApp } from '../src/server.mjs';
import { hashPassword } from '../src/security.mjs';
import { createContact,uid,now } from '../src/service.mjs';
import { installEducationWorkspace } from '../src/education.mjs';
import { readiness } from '../src/operations.mjs';

test('v0.3 quotations, customer notes, printable documents and readiness',async t=>{
  const db=openDatabase(':memory:'),password='Synthetic-business-test-only!',encoded=await hashPassword(password),users={};
  for(const [name,role] of [['Owner','admin'],['Agent','agent'],['Other','agent'],['Accountant','accountant']]){
    users[name]={id:uid(),name,role,email:name.toLowerCase()+'@example.test'};const u=users[name];
    db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?)').run(u.id,u.name,u.email,encoded,u.role,1,now());
  }
  const app=createApp({db,env:{},secretKey:Buffer.alloc(32,6)});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+app.server.address().port;
  const request=async(path,method='GET',body,auth)=>{
    const response=await fetch(base+'/api'+path,{method,headers:{'Content-Type':'application/json',...(auth?{Cookie:auth.cookie,'X-CSRF-Token':auth.csrf}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
    return {status:response.status,body:response.headers.get('content-type')?.includes('application/json')?await response.json():await response.text(),response};
  };
  const login=async name=>{const result=await request('/login','POST',{email:users[name].email,password});assert.equal(result.status,200);return {cookie:result.response.headers.get('set-cookie').split(';')[0],csrf:result.body.csrf};};
  const owner=await login('Owner'),agent=await login('Agent'),other=await login('Other'),accountant=await login('Accountant');
  const contact=createContact(db,users.Agent,{name:'<img src=x onerror=alert(1)>',phone:'+201000000009'});let quoteId,invoiceId;
  try{
    await t.test('agent creates a quotation only for their customer',async()=>{
      const input={number:'ME-Q-TEST',contact_id:contact.id,description:'Admission service <script>bad()</script>',amount_minor:250000,currency:'EGP'};
      assert.equal((await request('/quotes','POST',input,other)).status,404);
      const result=await request('/quotes','POST',input,agent);assert.equal(result.status,201);quoteId=result.body.id;
      assert.equal((await request('/quotes','GET',undefined,other)).body.length,0);
      assert.equal((await request('/quotes','POST',input,owner)).status,409);
    });
    await t.test('acceptance requires prior sent state and a reference',async()=>{
      assert.equal((await request('/quotes/'+quoteId,'PATCH',{status:'accepted',acceptance_reference:'test'},agent)).status,409);
      assert.equal((await request('/quotes/'+quoteId,'PATCH',{status:'sent'},agent)).status,200);
      assert.equal((await request('/quotes/'+quoteId,'PATCH',{status:'accepted'},agent)).status,400);
      assert.equal((await request('/quotes/'+quoteId,'PATCH',{status:'accepted',acceptance_reference:'Synthetic written confirmation'},agent)).status,200);
    });
    await t.test('invoice conversion is financial-role restricted and idempotent',async()=>{
      assert.equal((await request('/quotes/'+quoteId+'/invoice','POST',{number:'ME-INV-TEST'},agent)).status,403);
      const result=await request('/quotes/'+quoteId+'/invoice','POST',{number:'ME-INV-TEST'},accountant);assert.equal(result.status,201);invoiceId=result.body.id;
      const again=await request('/quotes/'+quoteId+'/invoice','POST',{number:'ANOTHER'},accountant);assert.equal(again.body.id,invoiceId);assert.equal(again.body.existing,true);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM invoices').get().n,1);
      const invoice=db.prepare('SELECT * FROM invoices').get();assert.equal(invoice.amount_minor,250000);assert.equal(invoice.status,'draft');
    });
    await t.test('print routes protect customer data and escape all dynamic HTML',async()=>{
      assert.equal((await request('/print/quote/'+quoteId)).status,401);
      assert.equal((await request('/print/quote/'+quoteId,'GET',undefined,other)).status,403);
      assert.equal((await request('/print/quote/'+quoteId,'GET',undefined,agent)).status,403);
      const quote=await request('/print/quote/'+quoteId,'GET',undefined,owner);assert.equal(quote.status,200);assert.ok(!quote.body.includes('<img src=x'));assert.ok(quote.body.includes('&lt;script&gt;'));
      assert.equal((await request('/print/invoice/'+invoiceId,'GET',undefined,agent)).status,403);
      assert.equal((await request('/print/invoice/'+invoiceId,'GET',undefined,accountant)).status,403);
      assert.equal((await request('/print/invoice/'+invoiceId,'GET',undefined,owner)).status,200);
    });
    await t.test('customer notes follow contact ownership and do not alter original record',async()=>{
      assert.equal((await request('/contacts/'+contact.id+'/notes','POST',{body:'Synthetic followup note'},agent)).status,201);
      assert.equal((await request('/contacts/'+contact.id+'/notes','GET',undefined,other)).status,404);
      const notes=await request('/contacts/'+contact.id+'/notes','GET',undefined,agent);assert.equal(notes.body.length,1);assert.equal(notes.body[0].author,'Agent');
      await request('/contacts/'+contact.id,'PATCH',{owner_id:users.Other.id},owner);
      assert.equal((await request('/contacts/'+contact.id+'/notes','GET',undefined,agent)).status,404);
      assert.equal((await request('/contacts/'+contact.id+'/notes','GET',undefined,other)).body.length,1);
    });
    await t.test('education setup is owner-only, idempotent and creates no student records',async()=>{
      assert.equal((await request('/workspace/education','POST',{},agent)).status,403);
      assert.equal((await request('/workspace/education','POST',{},owner)).status,200);
      const count=db.prepare('SELECT COUNT(*) n FROM app_fields').get().n;
      assert.equal((await request('/workspace/education','POST',{},owner)).status,200);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM studio_apps').get().n,3);assert.equal(db.prepare('SELECT COUNT(*) n FROM app_fields').get().n,count);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM app_records').get().n,0);
    });
    await t.test('readiness is restricted and does not invent successful live connectivity',async()=>{
      assert.equal((await request('/operations','GET',undefined,agent)).status,403);
      const result=await request('/operations','GET',undefined,owner);assert.equal(result.status,200);assert.equal(result.body.database.integrity,'ok');assert.equal(result.body.database.schema_version,9);
      assert.equal(result.body.whatsapp.live_acceptance_verified,false);assert.equal(result.body.deployment.public_hosting_verified,false);
      assert.ok(!JSON.stringify(result.body).includes(contact.name));
    });
  }finally{await new Promise(resolve=>app.server.close(resolve));db.close();}
});

test('education templates do not replace incompatible fields already owned by the company',()=>{
  const db=openDatabase(':memory:'),user={id:uid(),role:'admin'};
  try{
    db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?)').run(user.id,'Synthetic owner','owner@example.test','synthetic','admin',1,now());
    installEducationWorkspace(db,user);
    const app=db.prepare("SELECT id FROM studio_apps WHERE app_key='me_students'").get();
    db.prepare("UPDATE app_fields SET type='text',relation_target=NULL WHERE app_id=? AND field_key='guardian'").run(app.id);
    assert.throws(()=>installEducationWorkspace(db,user),error=>error.status===409);
    assert.equal(db.prepare("SELECT type FROM app_fields WHERE app_id=? AND field_key='guardian'").get(app.id).type,'text');
    assert.equal(readiness(db).database.foreign_key_errors,0);
  }finally{db.close();}
});
