import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../src/db.mjs';
import {uid,now} from '../src/service.mjs';
import {ensureOmniDefaults,setIntakeSettings} from '../src/omni-config.mjs';
import {installEducationWorkspace} from '../src/education.mjs';
import {createRegistration,processIntakeDelivery} from '../src/intake.mjs';
import {maybeSyncTemplates} from '../src/media.mjs';

test('pending receipt confirmations resume after approval without duplicate sends or polling loops',async()=>{
  const db=openDatabase(':memory:'),owner={id:uid(),role:'admin'},key=Buffer.alloc(32,4);
  db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?)').run(owner.id,'Synthetic owner','owner@example.test','unused','admin',1,now());
  ensureOmniDefaults(db);installEducationWorkspace(db,owner);
  setIntakeSettings(db,owner,{welcome_template:'synthetic_receipt',welcome_language:'ar',welcome_slots:['name','reference','receipt_url']});
  const config={phoneId:'900001',wabaId:'900002',accessToken:'synthetic-token',version:'v26.0'};
  let status='PENDING',calls=0;
  const transport=async url=>{
    calls++;assert.match(url,/v26\.0\/900002\/message_templates\?/);
    return new Response(JSON.stringify({data:[{id:'900003',name:'synthetic_receipt',language:'ar',category:'UTILITY',status,components:[{type:'BODY',text:'Synthetic {{1}} reference {{2}} receipt {{3}}.'}]}]}));
  };
  try{
    createRegistration(db,{name:'طالب تجريبي',phone:'01000000099',certificate:'ثانوي سوداني',academic_year:'2026',consent:true,whatsapp_opt_in:true,request_key:uid().replaceAll('-','')},key,'https://crm.example.test');
    await maybeSyncTemplates(db,config,transport);
    await processIntakeDelivery(db,config,key,'https://crm.example.test');
    let row=db.prepare('SELECT * FROM intake_registrations').get();
    assert.equal(row.delivery_status,'pending');assert.equal(row.delivery_reason,'TEMPLATE_REVIEW_PENDING');assert.equal(row.message_id,null);
    await maybeSyncTemplates(db,config,transport);assert.equal(calls,1);
    status='APPROVED';db.prepare("UPDATE settings SET value='0' WHERE key='wa.template_sync_next'").run();
    await maybeSyncTemplates(db,config,transport);await processIntakeDelivery(db,config,key,'https://crm.example.test');
    row=db.prepare('SELECT * FROM intake_registrations').get();assert.equal(row.delivery_status,'queued');assert.ok(row.message_id);
    await processIntakeDelivery(db,config,key,'https://crm.example.test');assert.equal(db.prepare('SELECT COUNT(*) n FROM messages').get().n,1);
    const message=JSON.parse(db.prepare('SELECT payload FROM messages').get().payload);
    assert.equal(message.template.components[0].parameters[0].text,'طالب تجريبي');
    assert.match(message.template.components[0].parameters[2].text,/^https:\/\/crm\.example\.test\/receipt\/[a-f0-9]{64}$/);
    db.prepare("UPDATE settings SET value='0' WHERE key='wa.template_sync_next'").run();
    await maybeSyncTemplates(db,config,async()=>{calls++;throw new Error('Synthetic outage');});
    await maybeSyncTemplates(db,config,transport);assert.equal(calls,3);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM audit WHERE action='sync_failed'").get().n,1);
  }finally{db.close();}
});
