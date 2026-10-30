import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../src/db.mjs';
import {uid,now} from '../src/service.mjs';
import {ensureOmniDefaults,setIntakeSettings} from '../src/omni-config.mjs';
import {acceptWebhook,processWebhookQueue,sendNext} from '../src/whatsapp.mjs';

test('WhatsApp welcome is atomic, first-inbound-only, and stays within the reply window',async()=>{
  const db=openDatabase(':memory:'),owner={id:uid(),role:'admin'};
  db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?)').run(owner.id,'Synthetic owner','owner@example.test','unused','admin',1,now());
  ensureOmniDefaults(db);setIntakeSettings(db,owner,{whatsapp_auto_reply:true});
  const config={phoneId:'900001',intakeUser:owner.id,accessToken:'synthetic-token',version:'v26.0'};
  const ingest=(id,from='201000000099',age=0)=>{
    acceptWebhook(db,Buffer.from(JSON.stringify({object:'whatsapp_business_account',entry:[{changes:[{value:{metadata:{phone_number_id:config.phoneId},messages:[{id,from,type:'text',timestamp:String(Math.floor((Date.now()-age)/1000)),text:{body:'Synthetic request'}}]}}]}]})));
    processWebhookQueue(db,config,'https://crm.example.test');
  };
  try{
    ingest('synthetic-first');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE direction='in'").get().n,1);
    const greeting=db.prepare("SELECT * FROM messages WHERE direction='out'").get();
    assert.equal(greeting.status,'queued');
    assert.match(greeting.body,/رد آلي/);assert.match(greeting.body,/https:\/\/crm\.example\.test\/apply\?source=whatsapp/);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM webhook_events WHERE status='done'").get().n,1);
    ingest('synthetic-first');ingest('synthetic-second');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE direction='in'").get().n,2);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE direction='out'").get().n,1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM contacts').get().n,1);
    let calls=0;
    await sendNext(db,config,async(url,init)=>{
      calls++;assert.equal(url,'https://graph.facebook.com/v26.0/900001/messages');
      const payload=JSON.parse(init.body);assert.equal(payload.to,'201000000099');assert.equal(payload.type,'text');
      return {ok:true,json:async()=>({messages:[{id:'synthetic-accepted'}]})};
    });
    assert.equal(calls,1);assert.equal(db.prepare('SELECT status FROM messages WHERE id=?').get(greeting.id).status,'accepted');
    ingest('synthetic-stale','201000000098',25*3600000);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE direction='out'").get().n,1);
    setIntakeSettings(db,owner,{whatsapp_auto_reply:false});ingest('synthetic-disabled','201000000097');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE direction='out'").get().n,1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM webhook_events WHERE status='error'").get().n,0);
  }finally{db.close();}
});
