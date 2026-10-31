import {whatsappStatusReply} from './customer-status.mjs';
import { transaction } from './db.mjs';
import { hash, normalizePhone, statusProgress, windowOpen } from './security.mjs';
import { uid, now, audit, runAutomations, fail, text, ensureInboundLead } from './service.mjs';
import { intakeSettings, renderReply } from './omni-config.mjs';
import { registrationLink } from './intake-links.mjs';
import {resolveWhatsAppConfig,messageWhatsAppConfig} from './accounts.mjs';
export function accountWindow(db,conversation,phoneId){const scoped=db.prepare('SELECT last_inbound FROM wa_thread_accounts WHERE conversation_id=? AND phone_id=?').get(conversation.id,phoneId||'');if(scoped)return scoped.last_inbound;return db.prepare('SELECT 1 FROM wa_thread_accounts WHERE conversation_id=?').get(conversation.id)?null:conversation.last_inbound;}


export function configuration(env) {
  return {appSecret:env.META_APP_SECRET,verifyToken:env.META_VERIFY_TOKEN,accessToken:env.META_ACCESS_TOKEN,
    phoneId:env.META_PHONE_NUMBER_ID,version:env.META_GRAPH_VERSION,intakeUser:env.META_INTAKE_USER_ID};
}
export function acceptWebhook(db, raw) {
  const payload = JSON.parse(raw.toString('utf8'));
  if (!payload || payload.object !== 'whatsapp_business_account') fail(400, 'Invalid webhook object');
  db.prepare('INSERT OR IGNORE INTO webhook_events(id,digest,payload,created_at) VALUES(?,?,?,?)')
    .run(uid(), hash(raw), JSON.stringify(payload), now());
}
export function processWebhookQueue(db, baseConfig, origin = '', key) {
  const events = db.prepare("SELECT * FROM webhook_events WHERE status='new' ORDER BY created_at LIMIT 10").all();
  for (const event of events) {
    try {
      transaction(db, () => {
        const payload = JSON.parse(event.payload);
        for (const entry of payload.entry || []) for (const change of entry.changes || []) {
          const value = change.value || {};
          const config=resolveWhatsAppConfig(db,key,baseConfig,String(value.metadata?.phone_number_id||''));
          const intake=db.prepare("SELECT * FROM users WHERE id=? AND active=1 AND role IN('admin','manager','agent')").get(config.intakeUser||'');
          if(!intake||!config.phoneId||String(value.metadata?.phone_number_id)!==String(config.phoneId))continue;
          for (const item of value.statuses || []) {
            if (!item.id || !item.status) continue;
            const statusId = hash([item.id,item.status,item.timestamp || ''].join(':'));
            db.prepare('INSERT OR IGNORE INTO provider_statuses VALUES(?,?,?,?,?)')
              .run(statusId,item.id,item.status,String(item.timestamp || ''),now());
          }
          for (const item of value.messages || []) {
            if (!item.id || !item.from || db.prepare('SELECT 1 FROM messages WHERE provider_id=?').get(item.id)) continue;
            const phone = normalizePhone('+' + item.from);
            let contact = db.prepare('SELECT * FROM contacts WHERE phone=?').get(phone);
            if (!contact) {
              const name = String((value.contacts || []).find(c => c.wa_id === item.from)?.profile?.name || phone).slice(0,200);
              contact = {id:uid(),name,phone,owner_id:intake.id};
              db.prepare('INSERT INTO contacts VALUES(?,?,?,?,?,?,?,?,?)')
                .run(contact.id,name,phone,'','whatsapp',intake.id,'{}',now(),now());
              runAutomations(db,'contact.created',contact,contact.id);
              audit(db,null,'whatsapp_created','contact',contact.id);
            }
            ensureInboundLead(db,contact,'whatsapp');
            let conversation = db.prepare('SELECT * FROM conversations WHERE contact_id=?').get(contact.id);
            if (!conversation) {
              conversation={id:uid(),contact_id:contact.id};
              db.prepare('INSERT INTO conversations(id,contact_id,created_at) VALUES(?,?,?)').run(conversation.id,contact.id,now());
            }
            const supported = ['text','image','audio','document','video','sticker','interactive'];
            const kind = supported.includes(item.type) ? item.type : 'other';
            const content = item[item.type] || {};
            const body = String(content.body || content.caption || content.filename || content.button_reply?.title || content.list_reply?.title || '').slice(0,10000);
            const timestamp = Number(item.timestamp) * 1000;
            if (!Number.isFinite(timestamp) || timestamp <= 0) throw new Error('Invalid provider timestamp');
            const received = new Date(Math.min(timestamp,Date.now())).toISOString();
            const firstInbound = !db.prepare("SELECT 1 FROM messages m LEFT JOIN message_accounts a ON a.message_id=m.id WHERE m.conversation_id=? AND m.direction='in' AND COALESCE(a.phone_id,?)=? LIMIT 1").get(conversation.id,baseConfig.phoneId||'',config.phoneId);
            const messageId = uid();
            db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?,?)')
              .run(messageId,conversation.id,item.id,'in',kind,body,content.id || null,JSON.stringify({filename:content.filename || ''}),'received',null,received);
            db.prepare('INSERT INTO message_accounts VALUES(?,?)').run(messageId,config.phoneId);
            db.prepare('INSERT INTO wa_thread_accounts VALUES(?,?,?) ON CONFLICT(conversation_id,phone_id) DO UPDATE SET last_inbound=MAX(COALESCE(last_inbound,excluded.last_inbound),excluded.last_inbound)').run(conversation.id,config.phoneId,received);
            db.prepare("UPDATE communication_accounts SET last_event_at=? WHERE channel='whatsapp' AND account_id=?").run(now(),config.phoneId);
            if(content.id)db.prepare('INSERT OR IGNORE INTO media_jobs(message_id,next_at) VALUES(?,?)').run(messageId,now());
            // Explicit column names keep record shape changes visible and retain the latest inbound time.
            db.prepare('UPDATE conversations SET last_inbound=MAX(COALESCE(last_inbound,?),?) WHERE id=?').run(received,received,conversation.id);
            runAutomations(db,'whatsapp.received',contact,messageId);
            const settings=intakeSettings(db);
            const statusReply=windowOpen(received)&&settings.whatsapp_auto_reply&&settings.whatsapp_status_lookup===true&&kind==='text'?whatsappStatusReply(db,contact,phone,body):null;
            if(windowOpen(received)&&settings.whatsapp_auto_reply&&(statusReply||firstInbound&&/^https?:\/\//.test(origin))){
              const template=db.prepare("SELECT body FROM reply_templates WHERE id='social_welcome'").get();
              const body=statusReply||renderReply(template?.body||'استلمنا رسالتك. فريقنا هيتابع معك.',{registration_url:registrationLink(contact.id,'whatsapp',key,origin)});
              const replyId=uid();
              db.prepare(`INSERT INTO messages(id,conversation_id,direction,kind,body,payload,status,created_at)
                VALUES(?,?,?,?,?,?,?,?)`).run(replyId,conversation.id,'out','text',body,JSON.stringify({type:'text',text:{body}}),'queued',now());
              db.prepare('INSERT INTO message_accounts VALUES(?,?)').run(replyId,config.phoneId);
              audit(db,intake,statusReply?'auto_status':'auto_welcome','message',replyId);
            }
          }
        }
        db.prepare("UPDATE webhook_events SET status='done',attempts=attempts+1 WHERE id=?").run(event.id);
      });
    } catch {
      db.prepare("UPDATE webhook_events SET status='error',attempts=attempts+1 WHERE id=?").run(event.id);
    }
  }
  reconcileStatuses(db);
}
export function reconcileStatuses(db) {
  for (const item of db.prepare('SELECT * FROM provider_statuses ORDER BY provider_time,created_at').all()) {
    const message = db.prepare('SELECT id,status FROM messages WHERE provider_id=? AND direction=?').get(item.provider_id,'out');
    if (message) {
      db.prepare('UPDATE messages SET status=? WHERE id=?').run(statusProgress(message.status,item.status),message.id);
      db.prepare('DELETE FROM provider_statuses WHERE id=?').run(item.id);
    }
  }
}
export function queueMessage(db, user, conversation, input, config) {
  if (!config.phoneId || !config.accessToken || !/^v\d+\.\d+$/.test(config.version || '')) fail(409,'ربط WhatsApp غير مكتمل على السيرفر؛ لم يتم إرسال أي رسالة');
  const lastInbound=accountWindow(db,conversation,config.phoneId);
  let payload;
  if (input.kind === 'template') {
    const name = text(input.template_name,'اسم القالب',128);
    if (!/^[a-z0-9_]+$/.test(name)) fail(400,'اسم القالب غير صالح');
    const language = text(input.language || 'ar','لغة القالب',20);
    if (!/^[a-z]{2,3}(?:_[A-Za-z]{2,4})?$/.test(language)) fail(400,'لغة القالب غير صالحة');
    const components = input.components || [];
    if (!Array.isArray(components) || JSON.stringify(components).length > 12000) fail(400,'متغيرات القالب غير صالحة');
    payload={type:'template',template:{name,language:{code:language},components}};
    if(db.prepare("SELECT 1 FROM communication_accounts WHERE channel='whatsapp' AND account_id=?").get(config.phoneId))fail(409,'قوالب الأرقام الإضافية تُرسل بعد مراجعة واعتماد قوالب حسابها؛ استخدم الرد داخل النافذة حاليًا');
    const known=db.prepare('SELECT status FROM wa_templates WHERE name=? AND language=?').get(name,language);
    if(known && known.status!=='APPROVED')fail(409,'القالب غير معتمد في آخر مزامنة');
  } else if(input.kind==='media') {
    if(!windowOpen(lastInbound))fail(409,'إرسال المرفقات يحتاج نافذة رد مفتوحة');
    if(!['image','audio','video','document'].includes(input.media_type)||!/^\d+$/.test(input.media_id||''))fail(400,'إعداد المرفق غير صالح');
    const part={id:input.media_id};if(input.media_type==='document')part.filename=text(input.filename||'document','اسم الملف',200);
    if(input.caption&&['image','video','document'].includes(input.media_type))part.caption=text(input.caption,'الوصف',1024);
    payload={type:input.media_type,[input.media_type]:part};
  } else {
    if (!windowOpen(lastInbound)) fail(409,'نافذة الرد انتهت؛ استخدم قالبًا معتمدًا من Meta');
    payload={type:'text',text:{body:text(input.body,'الرسالة',4096)}};
  }
  const id = uid();
  transaction(db,()=>{
    db.prepare(`INSERT INTO messages(id,conversation_id,direction,kind,body,payload,status,created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(id,conversation.id,'out',payload.type,input.body || input.template_name || '',JSON.stringify(payload),'queued',now());
    db.prepare('INSERT INTO message_accounts VALUES(?,?)').run(id,config.phoneId);
    audit(db,user,'queued','message',id);
  });
  return {id,status:'queued'};
}
export async function sendNext(db, baseConfig, transport = fetch,key) {
  const message = db.prepare(`SELECT m.*,c.phone,v.last_inbound FROM messages m
    JOIN conversations v ON v.id=m.conversation_id JOIN contacts c ON c.id=v.contact_id
    WHERE m.status='queued' AND m.direction='out' ORDER BY m.created_at LIMIT 1`).get();
  if (!message) return;
  const config=messageWhatsAppConfig(db,key,baseConfig,message.id);
  if(!config.accessToken||!config.phoneId||!/^v\d+\.\d+$/.test(config.version||'')){if(db.prepare('SELECT phone_id FROM message_accounts WHERE message_id=?').get(message.id)?.phone_id!==baseConfig.phoneId)db.prepare("UPDATE messages SET status='blocked',error_code='ACCOUNT_DISABLED' WHERE id=?").run(message.id);return;}
  message.last_inbound=accountWindow(db,{id:message.conversation_id,last_inbound:message.last_inbound},config.phoneId);
  if(db.prepare('SELECT id FROM intake_registrations WHERE message_id=?').get(message.id)){
    const consent=db.prepare('SELECT p.whatsapp_opt_in FROM contact_preferences p JOIN conversations c ON c.contact_id=p.contact_id WHERE c.id=?').get(message.conversation_id);
    if(!consent?.whatsapp_opt_in){db.prepare("UPDATE messages SET status='failed',error_code='CONSENT_REVOKED' WHERE id=?").run(message.id);return;}
  }
  if (message.kind !== 'template' && !windowOpen(message.last_inbound)) {
    db.prepare("UPDATE messages SET status='failed',error_code='WINDOW_EXPIRED' WHERE id=?").run(message.id); return;
  }
  const claim = db.prepare("UPDATE messages SET status='unknown' WHERE id=? AND status='queued'").run(message.id);
  if (!claim.changes) return;
  try {
    const result = await transport(`https://graph.facebook.com/${config.version}/${config.phoneId}/messages`,{
      method:'POST',headers:{Authorization:`Bearer ${config.accessToken}`,'Content-Type':'application/json'},
      body:JSON.stringify({messaging_product:'whatsapp',to:message.phone.slice(1),...JSON.parse(message.payload)}),
      signal:AbortSignal.timeout(25000)});
    if (!result.ok) {
      db.prepare("UPDATE messages SET status='failed',error_code=? WHERE id=?").run('META_HTTP_'+result.status,message.id);return;
    }
    const response=await result.json();
    if (!response.messages?.[0]?.id) throw new Error('No provider ID');
    db.prepare("UPDATE messages SET status='accepted',provider_id=? WHERE id=?").run(response.messages[0].id,message.id);
    reconcileStatuses(db);
  } catch {
    db.prepare("UPDATE messages SET error_code='DELIVERY_UNCERTAIN' WHERE id=?").run(message.id);
  }
}
