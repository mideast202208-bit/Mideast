import { transaction } from './db.mjs';
import { uid, now, text, fail, manager, audit, getContact } from './service.mjs';
import { appFor, recordFor, validKey, fieldDefinition, saveRecord, reorderFields } from './studio.mjs';
import { saveIntegration } from './integration-settings.mjs';
import { syncTemplates, downloadMessageMedia, uploadMedia, graphJson } from './media.mjs';
import { queueMessage } from './whatsapp.mjs';

export async function handleExtensions(context){
  const {db,user,path,method,req,res,jsonBody,sendJson,config,secretKey,transport,conversationFor}=context;
  const respond=(status,value)=>{sendJson(res,status,value);return true;};
  if(path==='/api/studio/apps'&&method==='POST'){
    if(!manager(user))fail(403,'بناء التطبيقات للإدارة');const input=await jsonBody(req),key=validKey(input.app_key);
    if(db.prepare('SELECT id FROM studio_apps WHERE app_key=?').get(key))fail(409,'معرف التطبيق موجود');
    const id=uid();db.prepare('INSERT INTO studio_apps VALUES(?,?,?,?,?)').run(id,key,text(input.name,'اسم التطبيق'),text(input.description||'','الوصف',1000,false),now());
    audit(db,user,'created','studio_app',id);return respond(201,{id});
  }
  const fields=path.match(/^\/api\/studio\/apps\/([^/]+)\/fields$/);
  if(fields&&method==='POST'){
    if(!manager(user))fail(403,'للإدارة');appFor(db,fields[1]);const input=await jsonBody(req),field=fieldDefinition(db,input);
    if(db.prepare('SELECT id FROM app_fields WHERE app_id=? AND field_key=?').get(fields[1],field.key))fail(409,'معرف الحقل موجود');
    const id=uid(),position=db.prepare('SELECT COUNT(*) n FROM app_fields WHERE app_id=?').get(fields[1]).n;
    db.prepare('INSERT INTO app_fields VALUES(?,?,?,?,?,?,?,?,?)').run(id,fields[1],field.key,field.label,field.type,field.required,field.options,field.target,position);
    audit(db,user,'created','app_field',id);return respond(201,{id});
  }
  if(path==='/api/studio/reorder'&&method==='POST'){
    const input=await jsonBody(req);reorderFields(db,user,input.entity,input.ids);return respond(200,{ok:true});
  }
  const editField=path.match(/^\/api\/studio\/fields\/([^/]+)$/);
  if(editField&&method==='PATCH'){
    if(!manager(user))fail(403,'للإدارة');const input=await jsonBody(req);
    const table=input.app_id?'app_fields':'studio_fields';
    const field=db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(editField[1]);if(!field)fail(404,'الحقل غير موجود');
    const label=text(input.label ?? field.label,'اسم الحقل',100),required=input.required===undefined?field.required:input.required?1:0;
    db.prepare(`UPDATE ${table} SET label=?,required=? WHERE id=?`).run(label,required,field.id);
    audit(db,user,'updated','form_field',field.id);return respond(200,{ok:true});
  }
  const records=path.match(/^\/api\/apps\/([^/]+)\/records$/);
  if(records){
    appFor(db,records[1]);if(user.role==='accountant')fail(403,'التطبيق غير متاح لهذا الدور');
    if(method==='GET')return respond(200,db.prepare('SELECT * FROM app_records WHERE app_id=?'+(manager(user)?'':' AND owner_id=?')+' ORDER BY updated_at DESC').all(...(manager(user)?[records[1]]:[records[1],user.id])));
    if(method==='POST')return respond(201,saveRecord(db,user,records[1],await jsonBody(req)));
  }
  const record=path.match(/^\/api\/apps\/([^/]+)\/records\/([^/]+)$/);
  if(record){
    if(method==='GET')return respond(200,recordFor(db,user,record[2],record[1]));
    if(method==='PATCH')return respond(200,saveRecord(db,user,record[1],await jsonBody(req),record[2]));
  }
  if(path==='/api/pipeline'&&method==='PATCH'){
    if(!manager(user))fail(403,'للإدارة');const input=await jsonBody(req),items=input.stages;
    const current=db.prepare('SELECT stage_key FROM pipeline_stages').all().map(r=>r.stage_key);
    if(!Array.isArray(items)||items.length!==current.length||new Set(items.map(i=>i.stage_key)).size!==current.length||items.some(i=>!current.includes(i.stage_key)))fail(400,'أرسل المراحل الست دون تغيير معرفاتها');
    const labels=items.map(i=>text(i.label,'اسم المرحلة',80));
    transaction(db,()=>{items.forEach((item,index)=>db.prepare('UPDATE pipeline_stages SET label=?,position=? WHERE stage_key=?').run(labels[index],index,item.stage_key));audit(db,user,'updated','pipeline','stages');});return respond(200,{ok:true});
  }
  if(path==='/api/automation-jobs'&&method==='GET'){
    if(!manager(user))fail(403,'للإدارة');return respond(200,db.prepare('SELECT j.id,j.rule_id,a.name,j.status,j.due_at,j.error_code FROM automation_jobs j JOIN automations a ON a.id=j.rule_id ORDER BY j.created_at DESC LIMIT 100').all());
  }
  if(path==='/api/integrations/whatsapp'&&method==='PATCH'){
    const input=await jsonBody(req);transaction(db,()=>saveIntegration(db,user,input,secretKey));return respond(200,{ok:true});
  }
  if(path==='/api/integrations/whatsapp/test'&&method==='POST'){
    if(user.role!=='admin')fail(403,'للمالك');const result=await graphJson(config,`${config.phoneId}?fields=display_phone_number,verified_name,quality_rating`,transport);
    audit(db,user,'tested','integration','whatsapp');return respond(200,{display_phone_number:result.display_phone_number,verified_name:result.verified_name,quality_rating:result.quality_rating});
  }
  if(path==='/api/whatsapp/templates/sync'&&method==='POST'){
    if(!manager(user))fail(403,'للإدارة');const result=await syncTemplates(db,config,transport);audit(db,user,'synced','templates','whatsapp',{count:result.count});return respond(200,result);
  }
  if(path==='/api/whatsapp/events'&&method==='GET'){
    if(!manager(user))fail(403,'للإدارة');return respond(200,db.prepare('SELECT id,status,attempts,created_at FROM webhook_events ORDER BY created_at DESC LIMIT 100').all());
  }
  const retry=path.match(/^\/api\/whatsapp\/events\/([^/]+)\/retry$/);
  if(retry&&method==='POST'){
    if(user.role!=='admin')fail(403,'للمالك');const result=db.prepare("UPDATE webhook_events SET status='new' WHERE id=? AND status='error'").run(retry[1]);if(!result.changes)fail(409,'الحدث ليس في حالة خطأ');audit(db,user,'retried','webhook',retry[1]);return respond(200,{ok:true});
  }
  const media=path.match(/^\/api\/messages\/([^/]+)\/media$/);
  if(media&&method==='POST'){
    const message=db.prepare('SELECT conversation_id FROM messages WHERE id=?').get(media[1]);if(!message)fail(404,'الرسالة غير متاحة');conversationFor(user,message.conversation_id);
    const file=await downloadMessageMedia(db,config,media[1],transport,secretKey);
    conversationFor(user,message.conversation_id);audit(db,user,'requested_media','attachment',file.id);return respond(200,file);
  }
  const sendFile=path.match(/^\/api\/conversations\/([^/]+)\/files$/);
  if(sendFile&&method==='POST'){
    const conversation=conversationFor(user,sendFile[1]),input=await jsonBody(req);
    const file=db.prepare('SELECT * FROM attachments WHERE id=?').get(input.file_id||'');if(!file||file.contact_id!==conversation.contact_id)fail(404,'المرفق ليس ضمن ملفات هذا العميل');
    if(!conversation.last_inbound || Date.now()-Date.parse(conversation.last_inbound)>=86400000)fail(409,'نافذة الرد انتهت');
    const mediaId=await uploadMedia(config,file,transport);
    const currentUser=db.prepare('SELECT id,role,active FROM users WHERE id=?').get(user.id);if(!currentUser?.active)fail(401,'انتهت صلاحية الحساب');
    const fresh=conversationFor(currentUser,conversation.id);
    const type=file.mime.startsWith('image/')?'image':file.mime.startsWith('audio/')?'audio':file.mime.startsWith('video/')?'video':'document';
    return respond(201,queueMessage(db,currentUser,fresh,{kind:'media',media_type:type,media_id:mediaId,filename:file.name,caption:input.caption||''},config));
  }
  const preference=path.match(/^\/api\/contacts\/([^/]+)\/preferences$/);
  if(preference&&method==='PATCH'){
    getContact(db,user,preference[1]);const input=await jsonBody(req);if(typeof input.whatsapp_opt_in!=='boolean')fail(400,'حدد موافقة التواصل صراحة');
    db.prepare('INSERT INTO contact_preferences VALUES(?,?,?) ON CONFLICT(contact_id) DO UPDATE SET whatsapp_opt_in=excluded.whatsapp_opt_in,updated_at=excluded.updated_at').run(preference[1],input.whatsapp_opt_in?1:0,now());
    audit(db,user,'consent_updated','contact',preference[1],{whatsapp_opt_in:input.whatsapp_opt_in});return respond(200,{ok:true});
  }
  return false;
}
