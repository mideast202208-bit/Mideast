import { createHash } from 'node:crypto';
import { uid, now, fail, audit } from './service.mjs';
import { intakeSettings } from './omni-config.mjs';
import {messageWhatsAppConfig} from './accounts.mjs';

export const mediaConfigured=config=>Boolean(config.accessToken&&/^v\d+\.\d+$/.test(config.version||'')&&/^\d+$/.test(config.phoneId||''));
const auth=config=>({Authorization:'Bearer '+config.accessToken});
export async function graphJson(config,path,transport=fetch,init={}){
  if(!mediaConfigured(config))fail(409,'إعداد WhatsApp غير مكتمل');
  const response=await transport(`https://graph.facebook.com/${config.version}/${path}`,{...init,headers:{...auth(config),...init.headers},redirect:'error',signal:AbortSignal.timeout(20000)});
  if(!response.ok)fail(502,'رفضت Meta الطلب: HTTP '+response.status);
  const length=Number(response.headers?.get?.('content-length')||0);if(length>2*1024*1024)fail(502,'استجابة Meta أكبر من المسموح');
  return response.json();
}
export function trustedMediaUrl(value){
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||url.port||!(url.hostname==='lookaside.fbsbx.com'||url.hostname.endsWith('.fbcdn.net')||url.hostname==='lookaside.facebook.com'))fail(502,'عنوان مرفق غير موثوق');
  return url.toString();
}
export async function downloadMessageMedia(db,config,messageId,transport=fetch,key){
  if(key)config=messageWhatsAppConfig(db,key,config,messageId);
  const existing=db.prepare('SELECT id FROM attachments WHERE message_id=?').get(messageId);if(existing)return existing;
  const message=db.prepare('SELECT m.*,c.contact_id FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.id=?').get(messageId);
  if(!message || !message.media_id || message.direction!=='in')fail(404,'لا يوجد مرفق وارد');
  if(!/^\d+$/.test(message.media_id))fail(400,'معرف المرفق غير صالح');
  const metadata=await graphJson(config,`${message.media_id}?phone_number_id=${config.phoneId}`,transport);
  if(Number(metadata.file_size)>10*1024*1024)fail(413,'المرفق يتجاوز حد 10 ميجابايت');
  const url=trustedMediaUrl(metadata.url);
  const response=await transport(url,{headers:auth(config),redirect:'error',signal:AbortSignal.timeout(25000)});
  if(!response.ok)fail(502,'تعذر تنزيل المرفق من Meta');
  if(Number(response.headers?.get?.('content-length')||0)>10*1024*1024)fail(413,'المرفق أكبر من المسموح');
  const chunks=[];let size=0;
  if(!response.body)fail(502,'استجابة المرفق فارغة');
  for await(const part of response.body){size+=part.length;if(size>10*1024*1024)fail(413,'المرفق أكبر من المسموح');chunks.push(Buffer.from(part));}
  const bytes=Buffer.concat(chunks);if(!bytes.length)fail(502,'المرفق فارغ');
  if(metadata.sha256){
    const actual=createHash('sha256').update(bytes),expected=String(metadata.sha256);
    if(actual.digest(/^[a-f0-9]{64}$/i.test(expected)?'hex':'base64')!==expected)fail(502,'بصمة المرفق غير مطابقة');
  }
  const id=uid();const mime=String(metadata.mime_type||'application/octet-stream').slice(0,120);
  const extensions={'image/jpeg':'jpg','image/png':'png','application/pdf':'pdf','audio/ogg':'ogg','audio/mpeg':'mp3','video/mp4':'mp4','image/webp':'webp'};
  const storedPayload=JSON.parse(message.payload || '{}');
  const name=String(storedPayload.filename || `whatsapp-${message.provider_id?.slice(-12) || message.id.slice(0,8)}.${extensions[mime]||'bin'}`).slice(0,200);
  // Another manual download may have completed while the network request was in flight.
  const duplicate=db.prepare('SELECT id FROM attachments WHERE message_id=?').get(messageId);if(duplicate)return duplicate;
  db.prepare('INSERT INTO attachments VALUES(?,?,?,?,?,?,?)').run(id,message.contact_id,message.id,name,mime,bytes,now());
  db.prepare("UPDATE media_jobs SET status='done',error_code=NULL WHERE message_id=?").run(messageId);
  audit(db,null,'archived_media','attachment',id,{message_id:messageId});return {id};
}
export async function processMediaJob(db,config,transport=fetch,key){
  if(!config.autoMedia || !mediaConfigured(config))return;
  const job=db.prepare("SELECT * FROM media_jobs WHERE status='pending' AND next_at<=? ORDER BY next_at LIMIT 1").get(now());if(!job)return;
  db.prepare("UPDATE media_jobs SET status='working',attempts=attempts+1 WHERE message_id=?").run(job.message_id);
  try{await downloadMessageMedia(db,config,job.message_id,transport,key);}
  catch(error){const retry=job.attempts<2&&error.status!==413;db.prepare('UPDATE media_jobs SET status=?,next_at=?,error_code=? WHERE message_id=?').run(retry?'pending':'error',new Date(Date.now()+60000*(job.attempts+1)).toISOString(),error.status===413?'TOO_LARGE':'MEDIA_DOWNLOAD_FAILED',job.message_id);}
}
export async function syncTemplates(db,config,transport=fetch){
  if(!/^\d+$/.test(config.wabaId||''))fail(409,'أضف WABA ID في إعدادات الربط');
  let after='',count=0,pages=0;
  do{
    const page=await graphJson(config,`${config.wabaId}/message_templates?limit=100&fields=id,name,language,status,category,components${after?'&after='+encodeURIComponent(after):''}`,transport);
    if(!Array.isArray(page.data))fail(502,'قائمة القوالب غير صالحة');
    for(const template of page.data){
      if(typeof template.id!=='string'||typeof template.name!=='string'||typeof template.language!=='string')continue;
      db.prepare(`INSERT INTO wa_templates VALUES(?,?,?,?,?,?,?) ON CONFLICT(name,language) DO UPDATE SET
        id=excluded.id,category=excluded.category,status=excluded.status,components=excluded.components,synced_at=excluded.synced_at`)
        .run(template.id,template.name,template.language,template.category||'',template.status||'UNKNOWN',JSON.stringify(template.components||[]),now());count++;
    }
    after=page.paging?.next ? page.paging?.cursors?.after || '' : '';
    pages++;
  }while(after&&pages<20);
  return {count,has_more:Boolean(after)};
}
export async function maybeSyncTemplates(db,config,transport=fetch){
  if(!mediaConfigured(config)||!/^\d+$/.test(config.wabaId||'')||!intakeSettings(db).welcome_template)return;
  const next=Number(db.prepare("SELECT value FROM settings WHERE key='wa.template_sync_next'").get()?.value||0);
  if(next>Date.now())return;
  db.prepare("INSERT INTO settings VALUES('wa.template_sync_next',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(Date.now()+15*60000));
  try{
    const result=await syncTemplates(db,config,transport);
    audit(db,null,'synced_automatically','templates','whatsapp',{count:result.count});
    return result;
  }catch{
    audit(db,null,'sync_failed','templates','whatsapp',{code:'META_TEMPLATE_SYNC_FAILED'});
    return {error:true};
  }
}
export async function uploadMedia(config,file,transport=fetch){
  const allowed=['image/jpeg','image/png','image/webp','application/pdf','audio/ogg','audio/mpeg','audio/mp4','video/mp4','text/plain'];
  if(!allowed.includes(file.mime))fail(400,'نوع هذا الملف غير مدعوم للإرسال في هذا الإصدار');
  const form=new FormData();form.append('messaging_product','whatsapp');form.append('type',file.mime);
  form.append('file',new Blob([file.content],{type:file.mime}),file.name);
  const response=await graphJson(config,`${config.phoneId}/media`,transport,{method:'POST',body:form});
  if(!/^\d+$/.test(response.id||''))fail(502,'لم تُرجع Meta معرف مرفق');return response.id;
}
