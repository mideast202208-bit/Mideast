import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { openDatabase, transaction } from './db.mjs';
import { token, hash, hashPassword, checkPassword, validSignature, normalizePhone } from './security.mjs';
import { uid, now, manager, finance, fail, text, audit, owner, getContact, validateCustom,
  runAutomations, createContact, createLead, getData } from './service.mjs';
import { acceptWebhook, processWebhookQueue, queueMessage, sendNext } from './whatsapp.mjs';
import { loadServerKey, effectiveConfig } from './integration-settings.mjs';
import { handleExtensions } from './extensions.mjs';
import { processWorkflowJobs, validateWorkflow } from './workflows.mjs';
import { processMediaJob, maybeSyncTemplates } from './media.mjs';
import { verifyFactor, handleMfa } from './mfa.mjs';
import { bootstrapOwner } from './bootstrap.mjs';
import { maybeSnapshot } from './backups.mjs';
import { reassignContactRecords } from './studio.mjs';
import { handleBusiness } from './business-routes.mjs';
import { ensureOmniDefaults } from './omni-config.mjs';
import { handleOmni,handleOmniPublic } from './omni-routes.mjs';
import { processSocialEvents,sendSocialNext } from './social.mjs';
import { processIntakeDelivery } from './intake.mjs';
import {internationalPhone} from './international.mjs';
import {handleMarketing,processMarketingJobs,processMarketingPlans,recoverMarketingJobs} from './marketing.mjs';
import {handleCommunication} from './communication.mjs';
import {handleAssistant} from './assistant.mjs';
import {extraAccountConfigs,resolveWhatsAppConfig} from './accounts.mjs';
import {handleBackupMachine,backupDiagnostics} from './backup-routes.mjs';
import {healthStatus} from './storage-health.mjs';
import {startupPreflight} from './startup-preflight.mjs';

const publicDir = fileURLToPath(new URL('../public/',import.meta.url));
const safeUser = row => ({id:row.id,name:row.name,email:row.email,role:row.role});
export function createApp(options = {}) {
  const env = options.env || process.env;
  const db = options.db || openDatabase(env.DB_PATH || resolve('data/mid-east.sqlite'));
  const production = env.NODE_ENV === 'production';
  const transport=env.RECOVERY_MODE==='1'?async()=>{fail(409,'RECOVERY_OUTBOUND_BLOCKED');}:options.transport||fetch;
  const origin = env.PUBLIC_ORIGIN || env.RENDER_EXTERNAL_URL || 'http://127.0.0.1:3000';
  if (production && !origin.startsWith('https://')) throw new Error('Production requires HTTPS PUBLIC_ORIGIN');
  const allowedOrigins=new Set([new URL(origin).origin]);
  for(const value of String(env.ADDITIONAL_ORIGINS||'').split(',').map(s=>s.trim()).filter(Boolean)){
    let u;try{u=new URL(value);}catch{throw new Error('INVALID_ADDITIONAL_ORIGIN');}
    if(u.username||u.password||u.pathname!=='/'||u.search||u.hash||u.hostname.includes('*')||!['https:','http:'].includes(u.protocol)||production&&u.protocol!=='https:')throw new Error('INVALID_ADDITIONAL_ORIGIN');allowedOrigins.add(u.origin);
  }
  const secretKey=options.secretKey || loadServerKey(env);
  ensureOmniDefaults(db);
  recoverMarketingJobs(db);
  let config = effectiveConfig(db,env,secretKey);
  if(config.phoneId)db.prepare("INSERT OR IGNORE INTO wa_thread_accounts SELECT v.id,?,MAX(m.created_at) FROM conversations v JOIN messages m ON m.conversation_id=v.id LEFT JOIN message_accounts a ON a.message_id=m.id WHERE m.direction='in' AND a.message_id IS NULL GROUP BY v.id").run(String(config.phoneId));
  const limits = new Map();
  let sending = false;
  const sendJson = (res,status,data) => {res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  const rateLimit = (key,maximum,period) => {
    const stamp=Date.now();
    if(limits.size>10000) for(const [k,v] of limits) if(v.until<stamp) limits.delete(k);
    if(limits.size>20000) fail(429,'الخدمة مشغولة؛ حاول بعد قليل');
    const value=limits.get(key);
    if(!value || value.until<stamp){limits.set(key,{count:1,until:stamp+period});return;}
    if(++value.count>maximum)fail(429,'محاولات كثيرة؛ حاول بعد قليل');
  };
  async function rawBody(req,max=512000) {
    const chunks=[];let size=0;
    for await(const chunk of req){size+=chunk.length;if(size>max)fail(413,'حجم الطلب أكبر من المسموح');chunks.push(chunk);}
    return Buffer.concat(chunks);
  }
  async function jsonBody(req,max) {
    if(!String(req.headers['content-type'] || '').startsWith('application/json'))fail(415,'استخدم JSON');
    try {const value=JSON.parse((await rawBody(req,max)).toString('utf8'));if(!value || Array.isArray(value)||typeof value!=='object')fail(400,'طلب غير صالح');return value;}
    catch(error){if(error.status)throw error;fail(400,'JSON غير صالح');}
  }
  function authenticate(req,write=false) {
    const value=String(req.headers.cookie || '').split(';').map(x=>x.trim()).find(x=>x.startsWith('me_session='))?.slice(11);
    if(!value || !/^[a-f0-9]{64}$/.test(value))fail(401,'سجّل الدخول');
    const session=db.prepare(`SELECT s.hash,s.csrf,u.* FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.hash=? AND s.expires_at>? AND u.active=1`).get(hash(value),now());
    if(!session)fail(401,'انتهت الجلسة؛ سجّل الدخول');
    if(write && req.headers['x-csrf-token']!==session.csrf)fail(403,'رمز حماية الجلسة غير صالح');
    return session;
  }
  function conversationFor(user,id){
    const conversation=db.prepare('SELECT * FROM conversations WHERE id=?').get(id);
    if(!conversation)fail(404,'المحادثة غير متاحة');
    getContact(db,user,conversation.contact_id);return conversation;
  }
  async function handler(req,res) {
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','same-origin');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-src https://www.youtube.com https://www.tiktok.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      config=effectiveConfig(db,env,secretKey);
      const url=new URL(req.url,'http://localhost');
      const path=url.pathname;
      const method=req.method;
      const marketingImage=path.match(/^\/social-media\/([a-f0-9-]{36})$/);
      if(marketingImage&&method==='GET'){const image=db.prepare('SELECT mime,content FROM marketing_assets WHERE id=?').get(marketingImage[1]);if(!image)fail(404,'الصورة غير متاحة');res.writeHead(200,{'Content-Type':image.mime,'Cache-Control':'public,max-age=86400','Cross-Origin-Resource-Policy':'cross-origin'});res.end(image.content);return;}
      if(path==='/health' && method==='GET'){const health=healthStatus(db,env);sendJson(res,health.code,health.body);return;}
      if(await handleBackupMachine({path,method,req,res,db,env,secretKey,jsonBody,sendJson,rateLimit}))return;
      if(path==='/webhooks/whatsapp'){
        if(method==='GET'){
          if(url.searchParams.get('hub.mode')!=='subscribe'||![config,...extraAccountConfigs(db,'whatsapp',secretKey)].some(c=>c.verifyToken&&url.searchParams.get('hub.verify_token')===c.verifyToken))fail(403,'Forbidden');
          res.writeHead(200,{'Content-Type':'text/plain'});res.end(url.searchParams.get('hub.challenge')||'');return;
        }
        if(method!=='POST')fail(405,'Method not allowed');
        const raw=await rawBody(req,2*1024*1024);
        const accepted=[config,...extraAccountConfigs(db,'whatsapp',secretKey).filter(c=>c.active&&c.verified_at&&c.subscribed)].filter(c=>validSignature(raw,req.headers['x-hub-signature-256'],c.appSecret));
        if(!accepted.length)fail(403,'Invalid signature');
        try{const payload=JSON.parse(raw);if(payload.object!=='whatsapp_business_account')fail(400,'Invalid webhook object');payload.entry=(payload.entry||[]).map(e=>({...e,changes:(e.changes||[]).filter(c=>accepted.some(a=>String(a.phoneId)===String(c.value?.metadata?.phone_number_id)))}));acceptWebhook(db,Buffer.from(JSON.stringify(payload)));}catch(error){if(error.status)throw error;fail(400,'Invalid webhook');}
        sendJson(res,200,{received:true});return;
      }
      if(await handleOmniPublic({db,path,method,req,res,jsonBody,sendJson,secretKey,origin,rateLimit,rawBody}))return;
      if(!path.startsWith('/api/')){
        if(method!=='GET')fail(405,'Method not allowed');
        if(path==='/phone-lib.js'){res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-cache'});res.end(readFileSync(new URL('../node_modules/libphonenumber-js/bundle/libphonenumber-min.js',import.meta.url)));return;}
        const assets={'/marketing.js':['marketing.js','text/javascript; charset=utf-8'],'/marketing.css':['marketing.css','text/css; charset=utf-8'],'/tour':['tour.html','text/html; charset=utf-8'],'/tour.js':['tour.js','text/javascript; charset=utf-8'],'/countries.js':['countries.js','text/javascript; charset=utf-8'],'/documents.js':['documents.js','text/javascript; charset=utf-8'],'/workspace.js':['workspace.js','text/javascript; charset=utf-8'],'/brand-icons.js':['brand-icons.js','text/javascript; charset=utf-8'],'/workspace.css':['workspace.css','text/css; charset=utf-8'],'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8'],'/print.css':['print.css','text/css; charset=utf-8'],'/omni.css':['omni.css','text/css; charset=utf-8'],'/omni.js':['omni.js','text/javascript; charset=utf-8'],'/apply':['apply.html','text/html; charset=utf-8'],'/registration':['apply.html','text/html; charset=utf-8'],'/services.js':['services.js','text/javascript; charset=utf-8'],'/apply.js':['apply.js','text/javascript; charset=utf-8']};
        const asset=assets[path];if(!asset)fail(404,'الصفحة غير موجودة');
        if(path==='/apply'||path==='/registration'){
          res.removeHeader('X-Frame-Options');
          res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors https://mideastedu-eg.com https://www.mideastedu-eg.com; base-uri 'none'; form-action 'self'");
        }
        res.writeHead(200,{'Content-Type':asset[1],'Cache-Control':'no-cache'});res.end(readFileSync(join(publicDir,asset[0])));return;
      }
      const write=!['GET','HEAD'].includes(method);
      let developmentSameHost=false;
      if(!production&&req.headers.origin){try{developmentSameHost=new URL(req.headers.origin).host===req.headers.host;}catch{}}
      if(write && req.headers.origin && !allowedOrigins.has(req.headers.origin) && !developmentSameHost)fail(403,'المصدر غير مسموح');
      if(path==='/api/setup/status'&&method==='GET'){
        sendJson(res,200,{required:!db.prepare('SELECT id FROM users LIMIT 1').get(),browser_setup:Boolean(env.BOOTSTRAP_TOKEN&&env.BOOTSTRAP_TOKEN.length>=32)});return;
      }
      if(path==='/api/setup'&&method==='POST'){
        rateLimit('setup:'+req.socket.remoteAddress,10,900000);
        sendJson(res,201,await bootstrapOwner(db,await jsonBody(req),env.BOOTSTRAP_TOKEN));return;
      }
      if(path==='/api/login' && method==='POST'){
        const input=await jsonBody(req);
        const email=text(input.email,'البريد',254).toLowerCase();
        rateLimit('login:'+req.socket.remoteAddress,40,900000);
        rateLimit('account:'+email,10,900000);
        const row=db.prepare('SELECT * FROM users WHERE email=? AND active=1').get(email);
        if(!row || !await checkPassword(input.password,row.password))fail(401,'البريد أو كلمة المرور غير صحيحة');
        if(db.prepare('SELECT enabled FROM login_factors WHERE user_id=?').get(row.id)?.enabled && !verifyFactor(db,row.id,input.code,secretKey))fail(401,'أدخل رمز المصادقة من تطبيقك؛ لا يمكن إعادة استخدام الرمز');
        const value=token(),csrf=token();
        db.prepare('DELETE FROM sessions WHERE expires_at<?').run(now());
        db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(hash(value),row.id,csrf,new Date(Date.now()+8*3600000).toISOString());
        res.setHeader('Set-Cookie',`me_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${production?'; Secure':''}`);
        audit(db,row,'login','user',row.id);sendJson(res,200,{user:safeUser(row),csrf});return;
      }
      const user=authenticate(req,write);
      rateLimit('api:'+user.id,600,60000);
      if(write&&path.startsWith('/api/security/mfa'))rateLimit('mfa:'+user.id,10,300000);
      if(path==='/api/me' && method==='GET'){sendJson(res,200,{user:safeUser(user),csrf:user.csrf});return;}
      if(path==='/api/logout' && method==='POST'){
        db.prepare('DELETE FROM sessions WHERE hash=?').run(user.hash);
        res.setHeader('Set-Cookie',`me_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${production?'; Secure':''}`);
        sendJson(res,200,{ok:true});return;
      }
      if(path==='/api/data' && method==='GET'){sendJson(res,200,getData(db,user));return;}
      if(path==='/api/operations/storage'&&method==='GET'){sendJson(res,200,backupDiagnostics(db,user,env));return;}
      if(await handleMarketing({db,user,path,method,req,res,jsonBody,sendJson,secretKey,origin,config,transport}))return;
      if(await handleCommunication({db,user,path,method,req,res,jsonBody,sendJson,secretKey,origin,config,transport}))return;
      if(await handleAssistant({db,user,path,method,req,res,jsonBody,sendJson,secretKey,origin,config,transport}))return;
      if(await handleOmni({db,user,path,method,req,res,jsonBody,sendJson,secretKey,origin,config,transport}))return;
      if(await handleBusiness({db,user,path,method,req,res,jsonBody,sendJson,config}))return;
      if(await handleMfa({db,user,path,method,req,jsonBody,sendJson,res,key:secretKey}))return;
      if(await handleExtensions({db,user,path,method,req,res,jsonBody,sendJson,config,secretKey,transport,conversationFor}))return;
      if(path==='/api/integrations' && method==='GET'){
        if(!manager(user))fail(403,'للإدارة فقط');
        const webhook=db.prepare('SELECT status,COUNT(*) count FROM webhook_events GROUP BY status').all();
        sendJson(res,200,{whatsapp:{configured:Boolean(config.accessToken&&config.phoneId&&config.appSecret&&config.verifyToken&&config.version&&config.intakeUser),
          webhook_path:'/webhooks/whatsapp',phone_id_set:Boolean(config.phoneId),token_set:Boolean(config.accessToken),
          intake_set:Boolean(db.prepare('SELECT id FROM users WHERE active=1 AND id=?').get(config.intakeUser || '')),
          phone_id:config.phoneId||'',waba_id:config.wabaId||'',version:config.version||'',intake_user:config.intakeUser||'',
          auto_media:config.autoMedia,app_secret_set:Boolean(config.appSecret),verify_token_set:Boolean(config.verifyToken),events:webhook}});return;
      }
      if(path==='/api/contacts' && method==='POST'){
        sendJson(res,201,createContact(db,user,await jsonBody(req)));return;
      }
      const contactMatch=path.match(/^\/api\/contacts\/([^/]+)$/);
      if(contactMatch && method==='PATCH'){
        if(user.role==='accountant')fail(403,'غير مسموح');
        const current=getContact(db,user,contactMatch[1]);const input=await jsonBody(req);
        const newOwner=owner(db,user,input.owner_id || current.owner_id);
        const name=text(input.name ?? current.name,'الاسم');
        const phone=input.phone===undefined?current.phone:input.phone?(input.phone_country?internationalPhone(input.phone,input.phone_country):normalizePhone(input.phone)):null;
        const email=text(input.email ?? current.email,'البريد',254,false);
        const custom=validateCustom(db,'contact',input.custom ?? JSON.parse(current.custom));
        if(phone && db.prepare('SELECT id FROM contacts WHERE phone=? AND id<>?').get(phone,current.id))fail(409,'الرقم موجود بالفعل');
        transaction(db,()=>{
          db.prepare('UPDATE contacts SET name=?,phone=?,email=?,owner_id=?,custom=?,updated_at=? WHERE id=?').run(name,phone,email,newOwner,custom,now(),current.id);
          for(const table of ['leads','tasks','tickets'])db.prepare(`UPDATE ${table} SET owner_id=? WHERE contact_id=?`).run(newOwner,current.id);
          reassignContactRecords(db,current.id,newOwner);
          audit(db,user,'updated','contact',current.id,{owner_id:newOwner});
        });sendJson(res,200,{ok:true});return;
      }
      if(path==='/api/leads' && method==='POST'){sendJson(res,201,createLead(db,user,await jsonBody(req)));return;}
      const leadMatch=path.match(/^\/api\/leads\/([^/]+)$/);
      if(leadMatch && method==='PATCH'){
        if(user.role==='accountant')fail(403,'غير مسموح');
        const current=db.prepare('SELECT * FROM leads WHERE id=?').get(leadMatch[1]);if(!current)fail(404,'الفرصة غير موجودة');
        getContact(db,user,current.contact_id);const input=await jsonBody(req);
        const stage=input.stage ?? current.stage;if(!['new','contacted','qualified','proposal','won','lost'].includes(stage))fail(400,'مرحلة غير صالحة');
        const title=text(input.title ?? current.title,'عنوان الفرصة');
        const custom=validateCustom(db,'lead',input.custom ?? JSON.parse(current.custom));
        transaction(db,()=>{
          db.prepare('UPDATE leads SET stage=?,title=?,custom=?,updated_at=? WHERE id=?').run(stage,title,custom,now(),current.id);
          if(stage!==current.stage)runAutomations(db,'lead.stage_changed',{...current,stage},uid());
          audit(db,user,'updated','lead',current.id,{stage});
        });sendJson(res,200,{ok:true});return;
      }
      if(path==='/api/tasks' && method==='POST'){
        if(user.role==='accountant')fail(403,'غير مسموح');
        const input=await jsonBody(req),contact=input.contact_id?getContact(db,user,input.contact_id):null;
        const assigned=contact?.owner_id || owner(db,user,input.owner_id);const title=text(input.title,'المهمة');
        const due=input.due_at?new Date(input.due_at):null;if(due&&!Number.isFinite(due.getTime()))fail(400,'موعد غير صالح');
        const id=uid();db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?)').run(id,contact?.id||null,null,title,due?.toISOString()||null,'open',assigned,now());
        audit(db,user,'created','task',id);sendJson(res,201,{id});return;
      }
      const taskMatch=path.match(/^\/api\/tasks\/([^/]+)$/);
      if(taskMatch && method==='PATCH'){
        const task=db.prepare('SELECT * FROM tasks WHERE id=?').get(taskMatch[1]);if(!task || (!manager(user)&&task.owner_id!==user.id))fail(404,'المهمة غير متاحة');
        const input=await jsonBody(req);if(!['open','done'].includes(input.status))fail(400,'حالة غير صالحة');
        db.prepare('UPDATE tasks SET status=? WHERE id=?').run(input.status,task.id);audit(db,user,'updated','task',task.id);sendJson(res,200,{ok:true});return;
      }
      if(path==='/api/tickets' && method==='POST'){
        if(user.role==='accountant')fail(403,'غير مسموح');
        const input=await jsonBody(req),contact=getContact(db,user,input.contact_id);
        const title=text(input.title,'التذكرة'),priority=input.priority || 'normal';if(!['low','normal','high'].includes(priority))fail(400,'أولوية غير صالحة');
        const description=text(input.description || '','التفاصيل',10000,false);const id=uid();
        transaction(db,()=>{db.prepare('INSERT INTO tickets VALUES(?,?,?,?,?,?,?,?,?)').run(id,contact.id,title,priority,'open',description,contact.owner_id,now(),now());
          runAutomations(db,'ticket.created',{id:contact.id,contact_id:contact.id,owner_id:contact.owner_id,title,priority,status:'open'},id);audit(db,user,'created','ticket',id);});
        sendJson(res,201,{id});return;
      }
      const ticketMatch=path.match(/^\/api\/tickets\/([^/]+)$/);
      if(ticketMatch && method==='PATCH'){
        const ticket=db.prepare('SELECT * FROM tickets WHERE id=?').get(ticketMatch[1]);if(!ticket)fail(404,'التذكرة غير متاحة');
        getContact(db,user,ticket.contact_id);const input=await jsonBody(req);if(!['open','pending','resolved'].includes(input.status))fail(400,'حالة غير صالحة');
        db.prepare('UPDATE tickets SET status=?,updated_at=? WHERE id=?').run(input.status,now(),ticket.id);
        audit(db,user,'updated','ticket',ticket.id);sendJson(res,200,{ok:true});return;
      }
      const messagesMatch=path.match(/^\/api\/conversations\/([^/]+)\/messages$/);
      if(messagesMatch){
        const conversation=conversationFor(user,messagesMatch[1]);
        if(method==='GET'){sendJson(res,200,db.prepare('SELECT id,provider_id,direction,kind,body,media_id,status,error_code,created_at,(SELECT id FROM attachments a WHERE a.message_id=messages.id) AS attachment_id FROM messages WHERE conversation_id=? ORDER BY created_at,rowid LIMIT 500').all(conversation.id));return;}
        if(method==='POST'){sendJson(res,201,queueMessage(db,user,conversation,await jsonBody(req),config));return;}
      }
      if(path==='/api/conversations' && method==='POST'){
        if(user.role==='accountant')fail(403,'غير مسموح');
        const input=await jsonBody(req),contact=getContact(db,user,input.contact_id);if(!contact.phone)fail(400,'أضف رقمًا دوليًا للعميل أولًا');
        const existing=db.prepare('SELECT id FROM conversations WHERE contact_id=?').get(contact.id);if(existing){sendJson(res,200,existing);return;}
        const id=uid();db.prepare('INSERT INTO conversations(id,contact_id,created_at) VALUES(?,?,?)').run(id,contact.id,now());audit(db,user,'created','conversation',id);sendJson(res,201,{id});return;
      }
      const filesMatch=path.match(/^\/api\/contacts\/([^/]+)\/files$/);
      if(filesMatch){
        const contact=getContact(db,user,filesMatch[1]);
        if(method==='GET'){sendJson(res,200,db.prepare('SELECT id,name,mime,length(content) AS size,created_at FROM attachments WHERE contact_id=? ORDER BY created_at DESC').all(contact.id));return;}
        if(method==='POST'){
          if(user.role==='accountant')fail(403,'غير مسموح');
          const input=await jsonBody(req,14*1024*1024);const name=text(input.name,'اسم الملف',200);
          if(typeof input.content!=='string'||!/^[A-Za-z0-9+/]*={0,2}$/.test(input.content)||input.content.length%4!==0)fail(400,'بيانات الملف غير صالحة');
          const content=Buffer.from(input.content,'base64');if(!content.length||content.length>10*1024*1024)fail(413,'الحد الأقصى للملف 10 ميجابايت');
          const mime=text(input.mime || 'application/octet-stream','نوع الملف',120);const id=uid();
          db.prepare('INSERT INTO attachments VALUES(?,?,?,?,?,?,?)').run(id,contact.id,null,name,mime,content,now());audit(db,user,'uploaded','attachment',id);sendJson(res,201,{id});return;
        }
      }
      const fileMatch=path.match(/^\/api\/files\/([^/]+)$/);
      if(fileMatch && method==='GET'){
        const file=db.prepare('SELECT * FROM attachments WHERE id=?').get(fileMatch[1]);if(!file)fail(404,'الملف غير متاح');getContact(db,user,file.contact_id);
        audit(db,user,'downloaded','attachment',file.id);
        res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/'/g,'%27')}`,'Cache-Control':'no-store'});res.end(Buffer.from(file.content));return;
      }
      if(path==='/api/studio/fields' && method==='POST'){
        if(!manager(user))fail(403,'الاستوديو متاح للإدارة');const input=await jsonBody(req);
        if(!['contact','lead'].includes(input.entity) || !['text','number','date','select','boolean'].includes(input.type))fail(400,'نوع الحقل غير متاح');
        const key=text(input.field_key,'معرف الحقل',50);if(!/^[a-z][a-z0-9_]{1,49}$/.test(key) || ['constructor','prototype','__proto__'].includes(key))fail(400,'معرف الحقل بحروف إنجليزية وأرقام وشرطة سفلية');
        const label=text(input.label,'اسم الحقل',100);const choices=input.options || [];
        if(!Array.isArray(choices)||choices.length>100||choices.some(x=>typeof x!=='string'||!x.trim()||x.length>100))fail(400,'خيارات الحقل غير صالحة');
        if(input.type==='select'&&!choices.length)fail(400,'أضف خيارات للقائمة');
        if(db.prepare('SELECT id FROM studio_fields WHERE entity=? AND field_key=?').get(input.entity,key))fail(409,'معرف الحقل موجود');
        const id=uid();db.prepare('INSERT INTO studio_fields(id,entity,field_key,label,type,required,options,position) VALUES(?,?,?,?,?,?,?,?)').run(id,input.entity,key,label,input.type,input.required?1:0,JSON.stringify(choices),db.prepare('SELECT COUNT(*) n FROM studio_fields WHERE entity=?').get(input.entity).n);
        audit(db,user,'created','studio_field',id);sendJson(res,201,{id});return;
      }
      if(path==='/api/automations' && method==='POST'){
        if(!manager(user))fail(403,'للإدارة فقط');const input=await jsonBody(req);
        if(!['contact.created','lead.created','lead.stage_changed','whatsapp.received','ticket.created'].includes(input.trigger))fail(400,'حدث غير متاح');
        if(input.condition_stage&&!['new','contacted','qualified','proposal','won','lost'].includes(input.condition_stage))fail(400,'شرط غير صالح');
        if(input.condition_stage&&!input.trigger.startsWith('lead.'))fail(400,'شرط المرحلة متاح لأحداث فرص البيع فقط');
        const hours=input.due_hours ?? 24;if(!Number.isSafeInteger(hours)||hours<0||hours>8760)fail(400,'مدة متابعة غير صالحة');
        const workflow=validateWorkflow(db,input);
        const id=uid();db.prepare('INSERT INTO automations(id,name,trigger,condition_stage,task_title,due_hours,active,created_at,conditions,actions,delay_minutes) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,text(input.name,'اسم القاعدة'),input.trigger,input.condition_stage || null,text(input.task_title || 'متابعة تلقائية','عنوان المتابعة'),hours,1,now(),workflow.conditions,workflow.actions,workflow.delay);
        audit(db,user,'created','automation',id);sendJson(res,201,{id});return;
      }
      const automationMatch=path.match(/^\/api\/automations\/([^/]+)$/);
      if(automationMatch && method==='PATCH'){
        if(!manager(user))fail(403,'للإدارة فقط');const input=await jsonBody(req);if(typeof input.active!=='boolean')fail(400,'حالة غير صالحة');
        const result=db.prepare('UPDATE automations SET active=? WHERE id=?').run(input.active?1:0,automationMatch[1]);if(!result.changes)fail(404,'القاعدة غير موجودة');audit(db,user,'updated','automation',automationMatch[1]);sendJson(res,200,{ok:true});return;
      }
      if(path==='/api/users' && method==='POST'){
        if(user.role!=='admin')fail(403,'إدارة المستخدمين للمالك');const input=await jsonBody(req);
        const name=text(input.name,'الاسم');const email=text(input.email,'البريد',254).toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fail(400,'بريد غير صالح');
        if(!['admin','manager','agent','accountant'].includes(input.role))fail(400,'دور غير صالح');
        if(db.prepare('SELECT id FROM users WHERE email=?').get(email))fail(409,'البريد مسجل');
        let password;try{password=await hashPassword(input.password);}catch(error){fail(400,error.message);}
        const id=uid();db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?)').run(id,name,email,password,input.role,1,now());audit(db,user,'created','user',id);sendJson(res,201,{id});return;
      }
      const userMatch=path.match(/^\/api\/users\/([^/]+)$/);
      if(userMatch && method==='PATCH'){
        if(user.role!=='admin')fail(403,'للمالك فقط');const input=await jsonBody(req),target=db.prepare('SELECT * FROM users WHERE id=?').get(userMatch[1]);if(!target)fail(404,'المستخدم غير موجود');
        if(target.id===user.id && (input.active===false || (input.role && input.role!=='admin')))fail(400,'لا يمكنك إلغاء صلاحيتك الحالية');
        const role=input.role ?? target.role;if(!['admin','manager','agent','accountant'].includes(role))fail(400,'دور غير صالح');
        let password=target.password;if(input.password){try{password=await hashPassword(input.password);}catch(error){fail(400,error.message);}}
        transaction(db,()=>{db.prepare('UPDATE users SET role=?,active=?,password=? WHERE id=?').run(role,input.active===undefined?target.active:input.active?1:0,password,target.id);db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);audit(db,user,'updated','user',target.id);});
        sendJson(res,200,{ok:true});return;
      }
      if(path==='/api/invoices' && method==='POST'){
        if(!finance(user))fail(403,'للحسابات فقط');const input=await jsonBody(req);
        if(!db.prepare('SELECT id FROM contacts WHERE id=?').get(input.contact_id))fail(400,'العميل غير موجود');
        if(!Number.isSafeInteger(input.amount_minor)||input.amount_minor<=0)fail(400,'المبلغ بالقرش يجب أن يكون موجبًا');
        if(!['EGP','USD','SAR'].includes(input.currency||'EGP'))fail(400,'عملة غير مدعومة');
        const number=text(input.number,'رقم الفاتورة',80);if(db.prepare('SELECT id FROM invoices WHERE number=?').get(number))fail(409,'رقم الفاتورة موجود');
        const due=input.due_at?new Date(input.due_at):null;if(due&&!Number.isFinite(due.getTime()))fail(400,'تاريخ غير صالح');
        const id=uid();db.prepare('INSERT INTO invoices VALUES(?,?,?,?,?,?,?,?,?)').run(id,number,input.contact_id,text(input.description,'البيان',2000),input.amount_minor,input.currency||'EGP','draft',due?.toISOString()||null,now());audit(db,user,'created','invoice',id);sendJson(res,201,{id});return;
      }
      const invoiceMatch=path.match(/^\/api\/invoices\/([^/]+)$/);
      if(invoiceMatch && method==='PATCH'){
        if(!finance(user))fail(403,'للحسابات فقط');const invoice=db.prepare('SELECT * FROM invoices WHERE id=?').get(invoiceMatch[1]);if(!invoice)fail(404,'الفاتورة غير موجودة');
        const input=await jsonBody(req);if(!['issued','void'].includes(input.status)||invoice.status==='void')fail(400,'انتقال حالة غير صالح');
        if(input.status==='void'&&db.prepare('SELECT 1 FROM payments WHERE invoice_id=?').get(invoice.id))fail(409,'لا يمكن إلغاء فاتورة لها دفعات؛ يلزم مسار تسوية');
        db.prepare('UPDATE invoices SET status=? WHERE id=?').run(input.status,invoice.id);audit(db,user,'updated','invoice',invoice.id,{status:input.status});sendJson(res,200,{ok:true});return;
      }
      const paymentMatch=path.match(/^\/api\/invoices\/([^/]+)\/payments$/);
      if(paymentMatch && method==='POST'){
        if(!finance(user))fail(403,'للحسابات فقط');const invoice=db.prepare('SELECT * FROM invoices WHERE id=?').get(paymentMatch[1]);if(!invoice||invoice.status!=='issued')fail(409,'أصدر الفاتورة أولًا');
        const input=await jsonBody(req);if(!Number.isSafeInteger(input.amount_minor)||input.amount_minor<=0)fail(400,'دفعة غير صالحة');
        const paid=db.prepare('SELECT COALESCE(SUM(amount_minor),0) total FROM payments WHERE invoice_id=?').get(invoice.id).total;
        if(paid+input.amount_minor>invoice.amount_minor)fail(409,'الدفعة تتجاوز الرصيد المتبقي');
        const id=uid();db.prepare('INSERT INTO payments VALUES(?,?,?,?,?,?)').run(id,invoice.id,input.amount_minor,text(input.reference,'مرجع الدفع',200),user.id,now());audit(db,user,'created','payment',id);sendJson(res,201,{id});return;
      }
      if(path==='/api/audit' && method==='GET'){
        if(!manager(user))fail(403,'للإدارة فقط');sendJson(res,200,db.prepare('SELECT a.*,u.name AS user_name FROM audit a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC,a.rowid DESC LIMIT 300').all());return;
      }
      if(path==='/api/export' && method==='GET'){
        if(user.role!=='admin')fail(403,'تصدير البيانات للمالك');audit(db,user,'exported','data','all');
        res.setHeader('Content-Disposition','attachment; filename="mid-east-export.json"');sendJson(res,200,{exported_at:now(),...getData(db,user)});return;
      }
      if(path==='/api/settings' && method==='PATCH'){
        if(user.role!=='admin')fail(403,'للمالك فقط');const input=await jsonBody(req);
        for(const key of ['company_name','currency'])if(input[key]!==undefined){const value=text(input[key],key,150);db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value);}
        audit(db,user,'updated','settings','company');sendJson(res,200,{ok:true});return;
      }
      fail(404,'المسار غير موجود');
    } catch(error) {
      if(res.headersSent){res.end();return;}
      const status=error.status || 500;
      if(status===500)options.onError?.(error);
      sendJson(res,status,{error:status===500?'تعذر تنفيذ العملية؛ راجع سجل التشغيل':error.message});
    }
  }
  const server=http.createServer(handler);
  server.requestTimeout=120000;
  const tick=async()=>{
    if(sending||env.RECOVERY_MODE==='1')return;sending=true;
    try{config=effectiveConfig(db,env,secretKey);processWebhookQueue(db,config,origin,secretKey);processSocialEvents(db,secretKey,origin);processWorkflowJobs(db);await maybeSyncTemplates(db,config,transport);await processIntakeDelivery(db,config,secretKey,origin);await sendNext(db,config,transport,secretKey);await sendSocialNext(db,secretKey,transport);await processMediaJob(db,config,transport,secretKey);}catch(error){options.onError?.(error);}finally{sending=false;}
  };
  let marketingBusy=false,planChecked=0;const marketingTick=async()=>{if(marketingBusy||env.RECOVERY_MODE==='1')return;marketingBusy=true;try{const cfg=effectiveConfig(db,env,secretKey);if(Date.now()-planChecked>60000){processMarketingPlans(db,secretKey,cfg,origin);planChecked=Date.now();}await processMarketingJobs(db,secretKey,cfg,origin,transport);}catch(error){options.onError?.(error);}finally{marketingBusy=false;}};
  let backupBusy=false;const backupTick=async()=>{if(backupBusy||env.RECOVERY_MODE==='1')return;backupBusy=true;try{await maybeSnapshot(db,secretKey,env);}catch(error){options.onError?.(error);}finally{backupBusy=false;}};
  return {server,db,tick,marketingTick,backupTick,get config(){return config;}};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  process.umask(0o077);
  await startupPreflight(process.env);
  const app=createApp({onError:error=>console.error('Operation failed:',error.name)});
  if(!app.db.prepare('SELECT id FROM users LIMIT 1').get()&&(!process.env.BOOTSTRAP_TOKEN || process.env.BOOTSTRAP_TOKEN.length<32)){
    console.error('No administrator exists. Run npm run setup before starting.');process.exit(1);
  }
  const flag=name=>{const index=process.argv.indexOf(name);return index>=0?process.argv[index+1]:undefined;};
  const port=Number(flag('--port')||process.env.PORT||3000),host=flag('--host')||process.env.HOST||'127.0.0.1';
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid listening port');
  app.db.prepare("UPDATE media_jobs SET status='pending' WHERE status='working'").run();
  app.server.listen(port,host,()=>console.log(`Mid East listening on ${host}:${port}`));
  const timer=setInterval(app.tick,3000);timer.unref();
  const marketingTimer=setInterval(app.marketingTick,10000);marketingTimer.unref();
  const backupTimer=setInterval(app.backupTick,30000);backupTimer.unref();
  const stop=()=>{clearInterval(timer);clearInterval(marketingTimer);clearInterval(backupTimer);app.server.close(()=>{app.db.close();process.exit(0);});setTimeout(()=>process.exit(1),30000).unref();};
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
