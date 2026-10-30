import { transaction } from './db.mjs';
import { uid,now,fail,audit,getContact,runAutomations } from './service.mjs';
import { hash,windowOpen,validSignature } from './security.mjs';
import { channelConfig,intakeSettings,renderReply } from './omni-config.mjs';
import { registrationLink } from './intake-links.mjs';

export function acceptSocialWebhook(db,channel,raw,signature,key){
  const config=channelConfig(db,channel,key);
  if(!config?.active||!validSignature(raw,signature,config.appSecret))fail(403,'توقيع القناة غير صحيح');
  let payload;try{payload=JSON.parse(raw);}catch{fail(400,'حدث غير صالح');}
  if(payload.object!==(channel==='facebook'?'page':'instagram'))fail(400,'نوع حدث غير صالح');
  const digest=hash(channel+':'+raw);
  db.prepare('INSERT OR IGNORE INTO social_events(id,channel,digest,payload,created_at) VALUES(?,?,?,?,?)').run(uid(),channel,digest,JSON.stringify(payload),now());
  return {received:true};
}
export function processSocialEvents(db,key,origin){
  for(const event of db.prepare("SELECT * FROM social_events WHERE status='new' ORDER BY created_at LIMIT 10").all()){
    const config=channelConfig(db,event.channel,key);
    const owner=db.prepare("SELECT * FROM users WHERE id=? AND active=1 AND role IN('admin','manager','agent')").get(config?.intake_user||'');
    if(!config?.active||!owner||!config.account_id)continue;
    try{transaction(db,()=>{
      const payload=JSON.parse(event.payload);
      for(const entry of payload.entry||[]){
        if(String(entry.id)!==config.account_id)continue;
        for(const item of entry.messaging||[]){
          const message=item.message;
          if(!message?.mid||message.is_echo||!item.sender?.id||String(item.recipient?.id)!==config.account_id)continue;
          if(db.prepare('SELECT id FROM social_messages WHERE provider_id=?').get(message.mid))continue;
          const sender=String(item.sender.id);if(!/^\d{1,40}$/.test(sender))continue;
          let thread=db.prepare('SELECT * FROM social_threads WHERE channel=? AND account_id=? AND sender_id=?').get(event.channel,config.account_id,sender);
          const first=!thread;
          const stamp=Number(item.timestamp);if(!Number.isFinite(stamp)||stamp<=0)continue;
          if(!thread){
            const contact={id:uid(),name:(event.channel==='facebook'?'عميل فيسبوك ':'عميل إنستجرام ')+sender.slice(-6),owner_id:owner.id,source:event.channel};
            db.prepare('INSERT INTO contacts VALUES(?,?,?,?,?,?,?,?,?)').run(contact.id,contact.name,null,'',event.channel,owner.id,'{}',now(),now());
            runAutomations(db,'contact.created',contact,contact.id);
            const lead={id:uid(),contact_id:contact.id,title:'استفسار '+contact.name,owner_id:owner.id,stage:'new'};
            db.prepare('INSERT INTO leads VALUES(?,?,?,?,?,?,?,?,?)').run(lead.id,contact.id,lead.title,'new',0,owner.id,'{}',now(),now());
            runAutomations(db,'lead.created',lead,lead.id);
            thread={id:uid(),contact_id:contact.id};db.prepare('INSERT INTO social_threads VALUES(?,?,?,?,?,?,?)').run(thread.id,event.channel,config.account_id,sender,contact.id,null,now());
          }
          const received=new Date(Math.min(Date.now(),stamp)).toISOString();
          const body=String(message.text|| (message.attachments?.length?'[مرفق وارد: راجعه في القناة الأصلية]':'[رسالة غير نصية]')).slice(0,10000);
          db.prepare('INSERT INTO social_messages VALUES(?,?,?,?,?,?,?,?)').run(uid(),thread.id,message.mid,'in',body,'received',null,received);
          db.prepare('UPDATE social_threads SET last_inbound=MAX(COALESCE(last_inbound,?),?) WHERE id=?').run(received,received,thread.id);
          db.prepare('UPDATE channel_accounts SET last_event_at=? WHERE channel=?').run(now(),event.channel);
          if(first&&intakeSettings(db).social_auto_reply){
            const template=db.prepare("SELECT body FROM reply_templates WHERE id='social_welcome'").get();
            const reply=renderReply(template?.body||'استلمنا رسالتك. فريقنا هيتابع معك.',{registration_url:registrationLink(thread.contact_id,event.channel,key,origin)});
            db.prepare('INSERT INTO social_messages VALUES(?,?,?,?,?,?,?,?)').run(uid(),thread.id,null,'out',reply,'queued',null,now());
          }
        }
      }
      db.prepare("UPDATE social_events SET status='done' WHERE id=?").run(event.id);
    });}catch{db.prepare("UPDATE social_events SET status='error',error_code='PROCESSING_FAILED' WHERE id=?").run(event.id);}
  }
}
export function socialThread(db,user,id){
  const thread=db.prepare('SELECT * FROM social_threads WHERE id=?').get(id);if(!thread)fail(404,'المحادثة غير متاحة');
  getContact(db,user,thread.contact_id);return thread;
}
export function queueSocialReply(db,user,id,body){
  const thread=socialThread(db,user,id);
  if(!windowOpen(thread.last_inbound))fail(409,'نافذة الرد انتهت؛ افتح القناة الأصلية لمراجعة الخيارات المتاحة');
  if(typeof body!=='string'||!body.trim()||body.length>1000)fail(400,'اكتب رسالة لا تزيد عن 1000 حرف');
  const account=db.prepare('SELECT active,token_cipher,version FROM channel_accounts WHERE channel=?').get(thread.channel);
  if(!account?.active||!account.token_cipher||!account.version)fail(409,'ربط القناة غير مكتمل');
  const messageId=uid();db.prepare('INSERT INTO social_messages VALUES(?,?,?,?,?,?,?,?)').run(messageId,id,null,'out',body.trim(),'queued',null,now());
  audit(db,user,'queued','social_message',messageId);return {id:messageId,status:'queued'};
}
export async function sendSocialNext(db,key,transport=fetch){
  const message=db.prepare("SELECT m.*,t.channel,t.account_id,t.sender_id,t.last_inbound FROM social_messages m JOIN social_threads t ON t.id=m.thread_id WHERE m.status='queued' AND m.direction='out' ORDER BY m.created_at LIMIT 1").get();
  if(!message)return;
  const config=channelConfig(db,message.channel,key);
  if(!config?.active||!config.accessToken||!/^v\d+\.\d+$/.test(config.version)||!config.verified_at){
    db.prepare("UPDATE social_messages SET status='blocked',error_code='CHANNEL_NOT_VERIFIED' WHERE id=?").run(message.id);return;
  }
  if(!windowOpen(message.last_inbound)){db.prepare("UPDATE social_messages SET status='failed',error_code='WINDOW_EXPIRED' WHERE id=?").run(message.id);return;}
  if(!db.prepare("UPDATE social_messages SET status='unknown' WHERE id=? AND status='queued'").run(message.id).changes)return;
  try{
    const response=await transport('https://graph.facebook.com/'+config.version+'/'+config.account_id+'/messages',{method:'POST',headers:{Authorization:'Bearer '+config.accessToken,'Content-Type':'application/json'},body:JSON.stringify({recipient:{id:message.sender_id},message:{text:message.body},...(message.channel==='facebook'?{messaging_type:'RESPONSE'}:{})}),redirect:'error',signal:AbortSignal.timeout(25000)});
    if(!response.ok){db.prepare("UPDATE social_messages SET status='failed',error_code=? WHERE id=?").run('META_HTTP_'+response.status,message.id);return;}
    const result=await response.json();if(!result.message_id)throw new Error('Missing provider ID');
    db.prepare("UPDATE social_messages SET status='accepted',provider_id=?,error_code=NULL WHERE id=?").run(result.message_id,message.id);
  }catch{db.prepare("UPDATE social_messages SET error_code='DELIVERY_UNCERTAIN' WHERE id=?").run(message.id);}
}
export async function testSocialAccount(db,user,channel,key,transport=fetch){
  if(user.role!=='admin')fail(403,'اختبار الربط للمالك');
  const config=channelConfig(db,channel,key);
  if(!config?.account_id||!config.accessToken||!/^v\d+\.\d+$/.test(config.version))fail(409,'أضف معرف الحساب والتوكن وإصدار Graph');
  const response=await transport('https://graph.facebook.com/'+config.version+'/'+config.account_id+'?fields=id,name',{headers:{Authorization:'Bearer '+config.accessToken},redirect:'error',signal:AbortSignal.timeout(20000)});
  if(!response.ok)fail(502,'رفضت Meta اختبار الحساب: HTTP '+response.status);
  const result=await response.json();if(String(result.id)!==config.account_id)fail(502,'معرف الحساب لا يطابق الإعدادات');
  db.prepare('UPDATE channel_accounts SET verified_at=? WHERE channel=?').run(now(),channel);
  audit(db,user,'verified','channel',channel);return {id:result.id,name:result.name||result.username||'',verified_at:now(),webhook_received:Boolean(config.last_event_at)};
}
