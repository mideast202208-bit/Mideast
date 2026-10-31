import {createHmac} from 'node:crypto';
import {openDatabase} from '../src/db.mjs';
import {createApp} from '../src/server.mjs';
import {uid,now} from '../src/service.mjs';
import {ensureOmniDefaults,saveChannel,setIntakeSettings} from '../src/omni-config.mjs';
import {installEducationWorkspace} from '../src/education.mjs';
import {processWebhookQueue} from '../src/whatsapp.mjs';
import {processSocialEvents} from '../src/social.mjs';

export const syntheticPhone='+201000000077';
export async function inboundFixture({followup=true}={}){
 const db=openDatabase(':memory:'),key=Buffer.alloc(32,9),users={};
 for(const [name,role] of [['owner','admin'],['intake','agent'],['assigned','agent']]){const u={id:uid(),name:'Synthetic '+name,role};users[name]=u;db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?)').run(u.id,u.name,name+'@example.test','unused-test-password',role,1,now());}
 ensureOmniDefaults(db);installEducationWorkspace(db,users.owner);setIntakeSettings(db,users.owner,{enabled:true,intake_user:users.intake.id,social_auto_reply:true,whatsapp_auto_reply:true});
 const secret='synthetic-inbound-signing-secret',origin='https://crm.example.test';
 for(const [channel,id] of [['facebook','100'],['instagram','200']])saveChannel(db,users.owner,channel,{account_id:id,intake_user:users.intake.id,accessToken:'synthetic-only-token',appSecret:secret,verifyToken:'synthetic-only-verify',active:true,version:'v26.0'},key);
 if(followup)db.prepare('INSERT INTO automations(id,name,trigger,condition_stage,task_title,due_hours,active,created_at) VALUES(?,?,?,?,?,?,?,?)').run(uid(),'Synthetic lead followup','lead.created','new','Synthetic followup',1,1,now());
 let externalCalls=0;
 const env={PUBLIC_ORIGIN:origin,META_APP_SECRET:secret,META_VERIFY_TOKEN:'synthetic-only-verify',META_ACCESS_TOKEN:'synthetic-only-token',META_PHONE_NUMBER_ID:'300',META_GRAPH_VERSION:'v26.0',META_INTAKE_USER_ID:users.intake.id};
 const app=createApp({db,env,secretKey:key,transport:async()=>{externalCalls++;throw Error('External transport forbidden in this acceptance fixture');}});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port;
 const payload=(channel,id,body='Synthetic education enquiry',sender)=>channel==='whatsapp'?{object:'whatsapp_business_account',entry:[{changes:[{value:{metadata:{phone_number_id:'300'},contacts:[{wa_id:sender||syntheticPhone.slice(1),profile:{name:'Synthetic student'}}],messages:[{id,from:sender||syntheticPhone.slice(1),timestamp:String(Math.floor(Date.now()/1000)),type:'text',text:{body}}]}}]}]}:{object:channel==='facebook'?'page':'instagram',entry:[{id:channel==='facebook'?'100':'200',messaging:[{sender:{id:sender||'900'},recipient:{id:channel==='facebook'?'100':'200'},timestamp:Date.now(),message:{mid:id,text:body}}]}]};
 async function post(channel,value,valid=true){const raw=JSON.stringify(value),signature='sha256='+createHmac('sha256',secret).update(raw).digest('hex');const response=await fetch(base+'/webhooks/'+channel,{method:'POST',headers:{'Content-Type':'application/json','X-Hub-Signature-256':valid?signature:'sha256=bad'},body:raw});return {status:response.status,body:await response.json()};}
 function drain(){processWebhookQueue(db,app.config,origin,key);processSocialEvents(db,key,origin);}
 function seedContact(channel,{linked=true,stage=null}={}){
  const c={id:uid(),name:'Synthetic existing student',phone:syntheticPhone,owner_id:users.assigned.id,source:'manual'};
  db.prepare('INSERT INTO contacts VALUES(?,?,?,?,?,?,?,?,?)').run(c.id,c.name,c.phone,'','manual',c.owner_id,'{}',now(),now());
  if(channel!=='whatsapp'&&linked)db.prepare('INSERT INTO social_threads VALUES(?,?,?,?,?,?,?)').run(uid(),channel,channel==='facebook'?'100':'200','900',c.id,null,now());
  if(stage)db.prepare('INSERT INTO leads VALUES(?,?,?,?,?,?,?,?,?)').run(uid(),c.id,'Synthetic existing opportunity',stage,0,c.owner_id,'{}',now(),now());return c;
 }
 const registration=(extra={})=>({name:'Synthetic student',phone:syntheticPhone,certificate:'ثانوي سوداني',academic_year:'2026',source:'website',university:'Synthetic University',faculty:'Synthetic Faculty',consent:true,whatsapp_opt_in:false,request_key:uid().replaceAll('-',''),...extra});
 return {db,key,users,origin,base,app,payload,post,drain,seedContact,registration,get externalCalls(){return externalCalls;},close:async()=>{await new Promise(r=>app.server.close(r));db.close();}};
}
