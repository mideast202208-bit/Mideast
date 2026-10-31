import {uid,now,fail,text,audit} from './service.mjs';
import {encryptSecret,decryptSecret} from './integration-settings.mjs';
import {mergeProfiles} from './profiles.mjs';

export const accountLimits=Object.freeze({facebook:10,instagram:10,whatsapp:10});
export function extraAccountConfig(db,channel,accountId,key){
 const row=db.prepare('SELECT * FROM communication_accounts WHERE channel=? AND account_id=?').get(channel,accountId);
 if(!row)return null;
 const cfg=JSON.parse(decryptSecret(row.configuration_cipher,key));
 return {...cfg,...row,accessToken:cfg.accessToken,appSecret:cfg.appSecret,verifyToken:cfg.verifyToken,phoneId:channel==='whatsapp'?row.account_id:undefined,intakeUser:row.intake_user,intake_user:row.intake_user};
}
export function extraAccountConfigs(db,channel,key){return db.prepare('SELECT account_id FROM communication_accounts WHERE channel=?').all(channel).map(r=>extraAccountConfig(db,channel,r.account_id,key));}
export function resolveWhatsAppConfig(db,key,base,phoneId){
 if(!phoneId||String(base.phoneId)===String(phoneId))return base;
 const cfg=extraAccountConfig(db,'whatsapp',phoneId,key);
 return cfg?.active&&cfg.verified_at&&cfg.subscribed?cfg:{};
}
export function messageWhatsAppConfig(db,key,base,messageId){return resolveWhatsAppConfig(db,key,base,db.prepare('SELECT phone_id FROM message_accounts WHERE message_id=?').get(messageId)?.phone_id);}
export function accountSummary(db,base,origin){
 const legacy=db.prepare('SELECT channel,account_id,profile_url,active,verified_at,last_event_at FROM channel_accounts WHERE account_id<>\'\'').all().map(r=>({...r,id:'primary-'+r.channel,name:r.channel==='facebook'?'فيسبوك الرئيسي':'إنستجرام الرئيسي',primary:true,subscribed:Boolean(r.verified_at)}));
 if(base.phoneId)legacy.push({id:'primary-whatsapp',channel:'whatsapp',account_id:base.phoneId,name:'واتساب الرئيسي',primary:true,active:Boolean(base.accessToken),verified_at:null,last_event_at:db.prepare("SELECT MAX(m.created_at) stamp FROM messages m LEFT JOIN message_accounts a ON a.message_id=m.id WHERE m.direction='in' AND COALESCE(a.phone_id,?)=?").get(base.phoneId,base.phoneId)?.stamp||null,subscribed:Boolean(base.appSecret&&base.verifyToken)});
 const extras=db.prepare('SELECT id,channel,account_id,name,intake_user,active,verified_at,subscribed,last_event_at,created_at FROM communication_accounts ORDER BY created_at').all();
 return mergeProfiles(db,[...legacy,...extras].map(r=>({...r,webhook:origin+'/webhooks/'+r.channel,state:!r.active?'disabled':r.last_event_at?'receiving':r.verified_at&&r.subscribed?'verified':'needs_setup'})));
}
export function saveExtraAccount(db,user,input,key,base,id){
 if(user.role!=='admin')fail(403,'ربط الحسابات للمالك فقط');
 const current=id?db.prepare('SELECT * FROM communication_accounts WHERE id=?').get(id):null;
 if(id&&!current)fail(404,'الحساب غير موجود');
 const channel=current?.channel||input.channel;if(!Object.hasOwn(accountLimits,channel))fail(400,'اختر قناة صحيحة');
 const account_id=current?.account_id||String(input.account_id||'');if(!/^\d{1,40}$/.test(account_id))fail(400,'معرف الحساب يجب أن يكون أرقامًا');
 if(!current){
  const primary=channel==='whatsapp'?base.phoneId:db.prepare('SELECT account_id FROM channel_accounts WHERE channel=?').get(channel)?.account_id;
  if(String(primary||'')===account_id||db.prepare('SELECT id FROM communication_accounts WHERE channel=? AND account_id=?').get(channel,account_id))fail(409,'الحساب مضاف بالفعل');
  if(accountSummary(db,base,'').filter(a=>a.channel===channel).length>=accountLimits[channel])fail(409,'وصلت لحد '+accountLimits[channel]+' حسابات لهذه القناة');
 }
 const cfg=current?JSON.parse(decryptSecret(current.configuration_cipher,key)):{};
 let credentialChange=!current;
 for(const name of ['accessToken','appSecret','verifyToken','version','wabaId','appId'])if(input[name]!==undefined&&input[name]!==''){
  const value=text(input[name],name,['accessToken','appSecret','verifyToken'].includes(name)?4096:100);
  if(name==='version'&&!/^v\d+\.\d+$/.test(value))fail(400,'إصدار Graph غير صالح');
  if(['wabaId','appId'].includes(name)&&!/^\d+$/.test(value))fail(400,'معرف غير صالح');
  credentialChange ||= cfg[name]!==value;cfg[name]=value;
 }
 const intake_user=input.intake_user||current?.intake_user||base.intakeUser;
 if(!db.prepare("SELECT id FROM users WHERE id=? AND active=1 AND role IN('admin','manager','agent')").get(intake_user||''))fail(400,'اختر مسؤول استقبال نشطًا');
 const name=text(input.name||current?.name||'', 'اسم الحساب',100),accountId=current?.id||uid();
 if(current)db.prepare('UPDATE communication_accounts SET name=?,intake_user=?,configuration_cipher=?,active=?,verified_at=?,subscribed=? WHERE id=?').run(name,intake_user,encryptSecret(JSON.stringify(cfg),key),credentialChange?0:current.active,credentialChange?null:current.verified_at,credentialChange?0:current.subscribed,accountId);
 else db.prepare('INSERT INTO communication_accounts(id,channel,account_id,name,configuration_cipher,intake_user,created_at) VALUES(?,?,?,?,?,?,?)').run(accountId,channel,account_id,name,encryptSecret(JSON.stringify(cfg),key),intake_user,now());
 audit(db,user,'configured','communication_account',accountId,{channel});return {id:accountId,requires_verification:credentialChange};
}
async function graph(cfg,path,transport,body,auth){
 const response=await transport('https://graph.facebook.com/'+cfg.version+'/'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+(auth||cfg.accessToken),...(body?{'Content-Type':'application/x-www-form-urlencoded'}:{})},...(body?{body:new URLSearchParams(body).toString()}:{}),redirect:'error',signal:AbortSignal.timeout(20000)});
 if(!response.ok)fail(502,'رفضت Meta الطلب: HTTP '+response.status);
 const result=await response.json();if(result.error)fail(502,'تعذر تأكيد الحساب لدى Meta');return result;
}
export async function verifyExtraAccount(db,user,id,key,origin,subscribe=false,transport=fetch){
 if(user.role!=='admin')fail(403,'اختبار الحسابات للمالك');
 const row=db.prepare('SELECT channel,account_id FROM communication_accounts WHERE id=?').get(id);if(!row)fail(404,'الحساب غير موجود');
 const cfg=extraAccountConfig(db,row.channel,row.account_id,key);
 if(!cfg.accessToken||!/^v\d+\.\d+$/.test(cfg.version||''))fail(409,'أكمل التوكن وإصدار Graph');
 const result=await graph(cfg,cfg.account_id+'?fields='+(row.channel==='whatsapp'?'id,display_phone_number,verified_name':row.channel==='instagram'?'id,username':'id,name'),transport);
 if(String(result.id)!==cfg.account_id)fail(409,'التوكن لا يطابق الحساب');
 if(row.channel==='whatsapp'){
  if(!cfg.wabaId)fail(409,'أضف معرف WABA');
  const phones=await graph(cfg,cfg.wabaId+'/phone_numbers?fields=id&limit=100',transport);
  if(!phones.data?.some(p=>String(p.id)===cfg.account_id))fail(409,'الرقم غير موجود في WABA المحدد');
 }
 db.prepare('UPDATE communication_accounts SET verified_at=? WHERE id=?').run(now(),id);
 if(subscribe){
  if(!cfg.appId||!cfg.appSecret||!cfg.verifyToken)fail(409,'أكمل App ID وApp Secret وVerify Token');
  // Shared callback preserves all other accounts attached to the same Meta app.
  const hook=await graph(cfg,cfg.appId+'/subscriptions',transport,{object:row.channel==='facebook'?'page':row.channel==='instagram'?'instagram':'whatsapp_business_account',fields:'messages',callback_url:origin+'/webhooks/'+row.channel,verify_token:cfg.verifyToken},cfg.appId+'|'+cfg.appSecret);
  if(hook.success!==true)fail(502,'لم تؤكد Meta عنوان الاستقبال');
  const sub=await graph(cfg,(row.channel==='whatsapp'?cfg.wabaId:cfg.account_id)+'/subscribed_apps',transport,row.channel==='whatsapp'?{}:{subscribed_fields:'messages'});
  if(sub.success!==true)fail(502,'لم تؤكد Meta الاشتراك');
  db.prepare('UPDATE communication_accounts SET subscribed=1,active=1 WHERE id=?').run(id);
 }
 audit(db,user,subscribe?'connected':'verified','communication_account',id);
 return {id,identity_verified:true,subscribed:subscribe||Boolean(cfg.subscribed),name:result.name||result.username||result.verified_name||'',secrets_returned:false};
}
