import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../src/db.mjs';
import {uid,now,createContact,createLead} from '../src/service.mjs';
import {ensureOmniDefaults} from '../src/omni-config.mjs';
import {installEducationWorkspace} from '../src/education.mjs';
import {createRegistration,registrationFiles,intakeLimits} from '../src/intake.mjs';
import {registrationLink,resolveRegistrationLink} from '../src/intake-links.mjs';
import {embedScript} from '../src/omni-routes.mjs';
import vm from 'node:vm';

test('twelve registration files and a conversation link stay attached to one protected CRM customer',()=>{
  const db=openDatabase(':memory:'),key=Buffer.alloc(32,9),owner={id:uid(),role:'admin'},other={id:uid(),role:'agent'};
  for(const user of [owner,other])db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?)').run(user.id,'Synthetic user',user.id+'@example.test','unused',user.role,1,now());
  ensureOmniDefaults(db);installEducationWorkspace(db,owner);
  try{
    const contact=createContact(db,owner,{name:'Synthetic Facebook customer',source:'facebook'});
    const enquiry=createLead(db,owner,{contact_id:contact.id,title:'استفسار عميل فيسبوك تجريبي'});
    const link=new URL(registrationLink(contact.id,'facebook',key,'https://crm.example.test'));
    const linkToken=link.searchParams.get('client');assert.equal(resolveRegistrationLink(linkToken,key),contact.id);
    const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_',last=alphabet.indexOf(linkToken.at(-1));
    assert.throws(()=>resolveRegistrationLink(linkToken.slice(0,-1)+alphabet[last+1],key),e=>e.status===400);
    assert.throws(()=>resolveRegistrationLink(linkToken.slice(0,-1)+(linkToken.endsWith('A')?'B':'A'),key),e=>e.status===400);
    assert.throws(()=>resolveRegistrationLink(linkToken.replace(/\.\d{10}\./,'.1000000000.'),key),e=>e.status===410);
    const files=Array.from({length:12},(_,i)=>({name:'synthetic-'+i+'.pdf',mime:'application/pdf',content:Buffer.from('%PDF-1.7\nSynthetic fixture '+i).toString('base64')}));
    const input={name:'طالب تجريبي',phone:'01000000099',certificate:'ثانوي سوداني',academic_year:'2026',source:'facebook',consent:true,link_token:linkToken,request_key:uid().replaceAll('-',''),files};
    const receipt=createRegistration(db,input,key,'https://crm.example.test');
    const record=db.prepare('SELECT * FROM intake_registrations WHERE reference=?').get(receipt.reference);
    assert.equal(record.contact_id,contact.id);assert.equal(record.lead_id,enquiry.id);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM contacts').get().n,1);assert.equal(db.prepare('SELECT COUNT(*) n FROM leads').get().n,1);
    assert.equal(db.prepare('SELECT phone,name FROM contacts').get().phone,'+201000000099');assert.equal(db.prepare('SELECT name FROM contacts').get().name,'Synthetic Facebook customer');
    const stored=registrationFiles(db,owner,record.id);assert.equal(stored.length,13);assert.equal(stored.filter(f=>f.mime==='application/pdf').length,12);
    assert.throws(()=>registrationFiles(db,other,record.id),e=>e.status===404);
    assert.equal(createRegistration(db,input,key,'https://crm.example.test').replayed,true);assert.equal(registrationFiles(db,owner,record.id).length,13);
    assert.throws(()=>createRegistration(db,{...input,request_key:uid().replaceAll('-',''),files:[...files,files[0]]},key,'https://crm.example.test'),e=>e.status===400);
    assert.throws(()=>createRegistration(db,{...input,phone:'01000000098',request_key:uid().replaceAll('-','')},key,'https://crm.example.test'),e=>e.status===409);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM intake_registrations').get().n,1);
    assert.equal(intakeLimits.maxFiles,12);
    const connector=embedScript('https://crm.example.test');new vm.Script(connector);assert.match(connector,/attributeFilter:\['src'\]/);assert.match(connector,/me-quick-contact/);assert.match(connector,/requestAnimationFrame/);
  }finally{db.close();}
});
