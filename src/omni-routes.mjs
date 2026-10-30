import { uid,now,text,fail,manager,audit,getContact } from './service.mjs';
import { ensureOmniDefaults,intakeSettings,setIntakeSettings,intakeOwner,channelSummary,channelConfig,saveChannel,issueIntegrationKey,authorizeIntegrationKey } from './omni-config.mjs';
import { listRegistrations,createRegistration,receiptByToken } from './intake.mjs';
import { socialThread,queueSocialReply,testSocialAccount,acceptSocialWebhook } from './social.mjs';
import { runVirtualLab } from './virtual-lab.mjs';
import { timingSafeEqual } from 'node:crypto';

export function integrationLinks(origin){
  return {website:origin+'/apply?source=website',facebook:origin+'/apply?source=facebook',instagram:origin+'/apply?source=instagram',whatsapp:origin+'/apply?source=whatsapp',api:origin+'/api/external/registrations',facebook_webhook:origin+'/webhooks/facebook',instagram_webhook:origin+'/webhooks/instagram',whatsapp_webhook:origin+'/webhooks/whatsapp',connect_script:origin+'/connect.js'};
}
export function embedScript(origin){
  const target=JSON.stringify(origin+'/apply'),allowed=JSON.stringify(['mideastedu-eg.com','www.mideastedu-eg.com']);
  return '(function(){if('+allowed+'.indexOf(location.hostname)<0)return;function connect(){document.querySelectorAll("a[href]").forEach(function(a){try{var u=new URL(a.href,location.href);if(u.hostname===location.hostname&&u.pathname.replace(/\\/$/,"")==="/registration"){var p=new URLSearchParams(u.search);if(!p.has("source"))p.set("source",new URLSearchParams(location.search).get("source")||"website");a.href='+target+'+"?"+p.toString();}}catch(e){}});document.querySelectorAll("iframe[src]").forEach(function(f){try{var u=new URL(f.src);if(u.hostname==="middle-east-education-services.odoo.com"&&u.pathname==="/contactus"){var p=new URLSearchParams(u.search);if(!p.has("source"))p.set("source",new URLSearchParams(location.search).get("source")||"website");f.src='+target+'+"?"+p.toString();f.title="التسجيل مع ميد إيست";f.style.minHeight="1100px";f.style.width="100%";f.style.border="0";}}catch(e){}});}if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",connect);else connect();new MutationObserver(connect).observe(document.documentElement,{childList:true,subtree:true});})();';
}
export async function handleOmniPublic(ctx){
  const {db,path,method,req,res,jsonBody,sendJson,secretKey,origin,rateLimit,rawBody}=ctx;
  ensureOmniDefaults(db);
  const receipt=path.match(/^\/receipt\/([a-f0-9]{64})$/);
  if(receipt&&method==='GET'){
    const row=receiptByToken(db,receipt[1]);
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Disposition':'inline; filename="registration-'+row.reference+'.html"'});res.end(row.content);return true;
  }
  if(path==='/connect.js'&&method==='GET'){res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-cache'});res.end(embedScript(origin));return true;}
  if(path==='/public/intake'&&method==='GET'){
    const settings=intakeSettings(db);
    sendJson(res,200,{enabled:Boolean(settings.enabled&&intakeOwner(db)),company_name:db.prepare("SELECT value FROM settings WHERE key='company_name'").get()?.value||'Middle East',max_files:3,max_file_mb:5,whatsapp:'201130343708'});return true;
  }
  if((path==='/public/registrations'||path==='/api/external/registrations')&&method==='POST'){
    const settings=intakeSettings(db);
    if(path.startsWith('/public/')){
      const permitted=[origin];try{permitted.push(new URL(settings.website).origin);}catch{}
      if(req.headers.origin&&!permitted.includes(req.headers.origin))fail(403,'المصدر غير مسموح');
      rateLimit('intake:'+req.socket.remoteAddress,30,3600000);rateLimit('intake:global',400,3600000);
    }else{
      const apiKey=authorizeIntegrationKey(db,req.headers['x-mideast-key']);rateLimit('intake-key:'+apiKey.id,300,3600000);
    }
    const input=await jsonBody(req,15*1024*1024);
    if(path.startsWith('/api/'))input.source='api';
    const result=createRegistration(db,input,secretKey,origin);
    sendJson(res,result.replayed?200:201,result);return true;
  }
  const hook=path.match(/^\/webhooks\/(facebook|instagram)$/);
  if(hook){
    const channel=hook[1],config=channelConfig(db,channel,secretKey);
    if(method==='GET'){
      const url=new URL(req.url,'http://localhost'),given=Buffer.from(url.searchParams.get('hub.verify_token')||''),expected=Buffer.from(config?.verifyToken||'');
      if(!config?.active||!expected.length||given.length!==expected.length||!timingSafeEqual(given,expected)||url.searchParams.get('hub.mode')!=='subscribe')fail(403,'Forbidden');
      res.writeHead(200,{'Content-Type':'text/plain'});res.end(url.searchParams.get('hub.challenge')||'');return true;
    }
    if(method!=='POST')fail(405,'Method not allowed');
    const raw=await rawBody(req,2*1024*1024);
    sendJson(res,200,acceptSocialWebhook(db,channel,raw,req.headers['x-hub-signature-256'],secretKey));return true;
  }
  return false;
}
export function hubData(db,user,origin,config){
  if(user.role==='accountant')fail(403,'مركز القنوات لفريق العملاء');
  ensureOmniDefaults(db);
  const scope=manager(user)?'':' WHERE c.owner_id=?',args=manager(user)?[]:[user.id];
  const threads=db.prepare('SELECT t.id,t.channel,t.contact_id,t.last_inbound,c.name,c.owner_id,(SELECT body FROM social_messages m WHERE m.thread_id=t.id ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1) AS preview FROM social_threads t JOIN contacts c ON c.id=t.contact_id'+scope+' ORDER BY COALESCE(t.last_inbound,t.created_at) DESC LIMIT 300').all(...args);
  const registrations=listRegistrations(db,user);
  const bySource=db.prepare('SELECT c.source,COUNT(*) AS contacts FROM contacts c'+scope+' GROUP BY c.source').all(...args);
  const replies=db.prepare('SELECT * FROM reply_templates ORDER BY category,name').all();
  const channels=channelSummary(db).map(c=>({...c,state:!c.active?'disabled':c.verified_at?(c.last_event_at?'receiving':'verified'):'needs_setup'}));
  return {settings:manager(user)?intakeSettings(db):null,links:integrationLinks(origin),channels,threads,registrations,replies,by_source:bySource,
    whatsapp:{configured:Boolean(config.accessToken&&config.phoneId&&config.appSecret&&config.verifyToken&&config.intakeUser),approved_templates:db.prepare("SELECT name,language,components FROM wa_templates WHERE status='APPROVED'").all()},
    keys:user.role==='admin'?db.prepare('SELECT id,name,prefix,active,created_at,last_used_at FROM integration_keys ORDER BY created_at DESC').all():[],
    lab_runs:manager(user)?db.prepare('SELECT id,scenario,result,created_at FROM lab_runs ORDER BY created_at DESC LIMIT 10').all().map(r=>({...r,result:JSON.parse(r.result)})):[]};
}
export async function handleOmni(ctx){
  const {db,user,path,method,req,res,jsonBody,sendJson,secretKey,origin,config,transport}=ctx;
  const respond=(status,value)=>{sendJson(res,status,value);return true;};
  if(path==='/api/hub'&&method==='GET')return respond(200,hubData(db,user,origin,config));
  if(path==='/api/intake/settings'&&method==='PATCH')return respond(200,setIntakeSettings(db,user,await jsonBody(req)));
  const channel=path.match(/^\/api\/channels\/(facebook|instagram)(\/test)?$/);
  if(channel){
    if(channel[2]&&method==='POST')return respond(200,await testSocialAccount(db,user,channel[1],secretKey,transport));
    if(!channel[2]&&method==='PATCH')return respond(200,saveChannel(db,user,channel[1],await jsonBody(req),secretKey));
  }
  if(path==='/api/integration-keys'&&method==='POST'){const input=await jsonBody(req);return respond(201,issueIntegrationKey(db,user,input.name));}
  const key=path.match(/^\/api\/integration-keys\/([^/]+)\/revoke$/);
  if(key&&method==='POST'){
    if(user.role!=='admin')fail(403,'إدارة المفاتيح للمالك');
    const updated=db.prepare('UPDATE integration_keys SET active=0 WHERE id=?').run(key[1]);if(!updated.changes)fail(404,'المفتاح غير موجود');
    audit(db,user,'revoked','integration_key',key[1]);return respond(200,{ok:true});
  }
  const thread=path.match(/^\/api\/social\/threads\/([^/]+)\/messages$/);
  if(thread){
    socialThread(db,user,thread[1]);
    if(method==='GET')return respond(200,db.prepare('SELECT * FROM social_messages WHERE thread_id=? ORDER BY created_at,rowid LIMIT 500').all(thread[1]));
    if(method==='POST'){const input=await jsonBody(req);return respond(201,queueSocialReply(db,user,thread[1],input.body));}
  }
  const retry=path.match(/^\/api\/intake\/([^/]+)\/retry$/);
  if(retry&&method==='POST'){
    if(user.role!=='admin')fail(403,'إعادة التجهيز للمالك');
    const row=db.prepare('SELECT * FROM intake_registrations WHERE id=?').get(retry[1]);if(!row)fail(404,'التسجيل غير موجود');
    if(row.delivery_status!=='blocked'||row.message_id)fail(409,'يمكن إعادة تجهيز الطلب المحجوب قبل الإرسال فقط');
    db.prepare("UPDATE intake_registrations SET delivery_status='pending',delivery_reason=NULL WHERE id=?").run(row.id);
    audit(db,user,'retried','intake_delivery',row.id);return respond(200,{ok:true});
  }
  if(path==='/api/reply-templates'&&method==='POST'){
    if(!manager(user))fail(403,'إدارة الردود للإدارة');const input=await jsonBody(req),id=uid();
    db.prepare('INSERT INTO reply_templates VALUES(?,?,?,?,?)').run(id,text(input.name,'اسم الرد',100),text(input.body,'نص الرد',2000),text(input.category||'عام','التصنيف',50),now());
    audit(db,user,'created','reply_template',id);return respond(201,{id});
  }
  const reply=path.match(/^\/api\/reply-templates\/([^/]+)$/);
  if(reply&&method==='PATCH'){
    if(!manager(user))fail(403,'إدارة الردود للإدارة');const current=db.prepare('SELECT * FROM reply_templates WHERE id=?').get(reply[1]);if(!current)fail(404,'الرد غير موجود');
    const input=await jsonBody(req);
    db.prepare('UPDATE reply_templates SET name=?,body=? WHERE id=?').run(text(input.name??current.name,'اسم الرد',100),text(input.body??current.body,'النص',2000),current.id);
    audit(db,user,'updated','reply_template',current.id);return respond(200,{ok:true});
  }
  if(path==='/api/lab/run'&&method==='POST'){
    if(!manager(user))fail(403,'المختبر للإدارة');
    const result=await runVirtualLab();
    const id=uid();db.prepare('INSERT INTO lab_runs VALUES(?,?,?,?,?)').run(id,'registration-and-channels',JSON.stringify(result),user.id,now());
    audit(db,user,'simulated','lab',id);return respond(201,{id,...result});
  }
  return false;
}
