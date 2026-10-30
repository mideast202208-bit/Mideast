import { uid, now, fail, audit } from './service.mjs';
import { encryptSecret, decryptSecret } from './integration-settings.mjs';
import { hash, token } from './security.mjs';

export const channelNames={website:'الموقع',facebook:'فيسبوك',instagram:'إنستجرام',whatsapp:'واتساب',api:'API',manual:'يدوي'};
export function ensureOmniDefaults(db){
  if(!db.prepare('SELECT id FROM users LIMIT 1').get()||db.prepare("SELECT value FROM settings WHERE key='omni.initialized.v4'").get())return;
  const defaults={enabled:true,website:'https://mideastedu-eg.com',facebook:'https://www.facebook.com/mideastedu',instagram:'https://www.instagram.com/mideastedu/',whatsapp:'201130343708',welcome_template:'',welcome_language:'ar',welcome_slots:['name','reference','receipt_url'],social_auto_reply:true};
  db.prepare('INSERT OR IGNORE INTO settings VALUES(?,?)').run('omni.intake',JSON.stringify(defaults));
  for(const channel of ['facebook','instagram'])db.prepare('INSERT OR IGNORE INTO channel_accounts(channel,profile_url,created_at) VALUES(?,?,?)').run(channel,defaults[channel],now());
  for(const [id,name,body,category] of [
    ['registration','تأكيد استلام الطلب','أهلًا {{name}}، استلمنا طلبك {{reference}} في ميد إيست. ملف تسجيلك: {{receipt_url}}. فريقنا هيراجع بياناتك ويتواصل معك.','تسجيل'],
    ['documents','استكمال المستندات','أهلًا {{name}}، لاستكمال مراجعة ملفك نحتاج صورة واضحة من جواز السفر والشهادة الدراسية وكشف الدرجات. أرسل المستندات المطلوبة فقط.','مستندات'],
    ['social_welcome','ترحيب القنوات','أهلًا بك في Middle East للخدمات التعليمية. ده رد آلي لتأكيد استلام رسالتك. ابدأ طلبك من {{registration_url}}، وموظفنا هيتابع معك.','ترحيب'],
    ['followup','متابعة العميل','أهلًا {{name}}، بنتابع معك طلب الدراسة في مصر. لو عندك مستندات أو استفسار جديد ابعته هنا لفريق المتابعة.','متابعة']
  ])db.prepare('INSERT OR IGNORE INTO reply_templates VALUES(?,?,?,?,?)').run(id,name,body,category,now());
  db.prepare("INSERT OR IGNORE INTO settings VALUES('omni.initialized.v4','true')").run();
}
export function intakeSettings(db){return JSON.parse(db.prepare("SELECT value FROM settings WHERE key='omni.intake'").get()?.value||'{}');}
export function setIntakeSettings(db,user,input){
  if(user.role!=='admin')fail(403,'إعداد بوابة التسجيل للمالك');
  const current=intakeSettings(db),next={...current};
  for(const key of ['enabled','social_auto_reply'])if(input[key]!==undefined){if(typeof input[key]!=='boolean')fail(400,'حالة غير صالحة');next[key]=input[key];}
  for(const key of ['website','facebook','instagram'])if(input[key]!==undefined){
    let url;try{url=new URL(input[key]);}catch{fail(400,'رابط غير صالح');}
    if(url.protocol!=='https:'||url.username||url.password||url.port||url.search||url.hash)fail(400,'استخدم رابط HTTPS بدون رموز سرية أو معاملات');
    next[key]=url.href.replace(/\/$/,'');
  }
  if(input.intake_user!==undefined){
    if(!db.prepare("SELECT id FROM users WHERE id=? AND active=1 AND role IN('admin','manager','agent')").get(input.intake_user))fail(400,'اختر موظف استقبال نشطًا');
    next.intake_user=input.intake_user;
  }
  if(input.welcome_template!==undefined){
    if(input.welcome_template!==''&&!/^[a-z0-9_]{1,128}$/.test(input.welcome_template))fail(400,'اسم قالب غير صالح');
    next.welcome_template=input.welcome_template;
  }
  if(input.welcome_language!==undefined){if(!/^[a-z]{2,3}(?:_[A-Za-z]{2,4})?$/.test(input.welcome_language))fail(400,'لغة غير صالحة');next.welcome_language=input.welcome_language;}
  if(input.welcome_slots!==undefined){if(!Array.isArray(input.welcome_slots)||input.welcome_slots.length>8||input.welcome_slots.some(v=>!['name','reference','receipt_url'].includes(v)))fail(400,'متغيرات القالب غير صالحة');next.welcome_slots=input.welcome_slots;}
  db.prepare("UPDATE settings SET value=? WHERE key='omni.intake'").run(JSON.stringify(next));
  audit(db,user,'configured','intake','settings');return next;
}
export function intakeOwner(db){
  const chosen=intakeSettings(db).intake_user;
  return db.prepare("SELECT * FROM users WHERE active=1 AND role IN('admin','manager','agent') AND id=?").get(chosen||'') ||
    (!chosen?db.prepare("SELECT * FROM users WHERE active=1 AND role='admin' ORDER BY created_at LIMIT 1").get():null);
}
export function channelConfig(db,channel,key){
  const row=db.prepare('SELECT * FROM channel_accounts WHERE channel=?').get(channel);if(!row)return null;
  return {...row,accessToken:row.token_cipher?decryptSecret(row.token_cipher,key):'',appSecret:row.secret_cipher?decryptSecret(row.secret_cipher,key):'',verifyToken:row.verify_cipher?decryptSecret(row.verify_cipher,key):''};
}
export function channelSummary(db){
  return db.prepare('SELECT channel,account_id,profile_url,version,intake_user,active,verified_at,last_event_at,created_at,token_cipher IS NOT NULL AS token_set,secret_cipher IS NOT NULL AS secret_set,verify_cipher IS NOT NULL AS verify_set FROM channel_accounts ORDER BY channel').all();
}
export function saveChannel(db,user,channel,input,key){
  if(user.role!=='admin')fail(403,'ربط الحسابات للمالك');
  const row=db.prepare('SELECT * FROM channel_accounts WHERE channel=?').get(channel);if(!row)fail(404,'قناة غير متاحة');
  const next={...row};let changed=false;
  for(const name of ['account_id','version','intake_user','profile_url'])if(input[name]!==undefined){
    const v=String(input[name]);
    if(name==='account_id'&&!/^\d{1,40}$/.test(v))fail(400,'معرف الحساب يجب أن يكون أرقامًا');
    if(name==='version'&&!/^v\d+\.\d+$/.test(v))fail(400,'أدخل إصدار Graph المفعّل لتطبيقك');
    if(name==='intake_user'&&!db.prepare("SELECT id FROM users WHERE id=? AND active=1 AND role IN('admin','manager','agent')").get(v))fail(400,'موظف غير صالح');
    if(name==='profile_url'&&!/^https:\/\/(www\.)?(facebook|instagram)\.com\/[A-Za-z0-9._/-]+\/?$/.test(v))fail(400,'رابط صفحة غير صالح');
    next[name]=v;changed ||= row[name]!==v;
  }
  for(const [name,column] of [['accessToken','token_cipher'],['appSecret','secret_cipher'],['verifyToken','verify_cipher']]){
    if(input[name]!==undefined&&input[name]!==''){
      if(typeof input[name]!=='string'||input[name].length>4096||input[name].length<8)fail(400,'قيمة سرية غير صالحة');
      next[column]=encryptSecret(input[name],key);changed=true;
    }
  }
  if(input.active!==undefined){if(typeof input.active!=='boolean')fail(400,'حالة غير صالحة');next.active=input.active?1:0;}
  db.prepare('UPDATE channel_accounts SET account_id=?,version=?,intake_user=?,profile_url=?,token_cipher=?,secret_cipher=?,verify_cipher=?,active=?,verified_at=? WHERE channel=?')
    .run(next.account_id,next.version,next.intake_user,next.profile_url,next.token_cipher,next.secret_cipher,next.verify_cipher,next.active,changed?null:row.verified_at,channel);
  audit(db,user,'configured','channel',channel);return {ok:true};
}
export function issueIntegrationKey(db,user,name){
  if(user.role!=='admin')fail(403,'مفاتيح API للمالك');
  if(typeof name!=='string'||!name.trim()||name.length>100)fail(400,'اسم المفتاح مطلوب');
  const secret='me_live_'+token(),id=uid(),prefix=secret.slice(0,16);
  db.prepare('INSERT INTO integration_keys(id,name,key_hash,prefix,created_by,created_at) VALUES(?,?,?,?,?,?)').run(id,name,hash(secret),prefix,user.id,now());
  audit(db,user,'created','integration_key',id);return {id,key:secret,prefix,scope:'registrations:create'};
}
export function authorizeIntegrationKey(db,value){
  if(typeof value!=='string'||!/^me_live_[a-f0-9]{64}$/.test(value))fail(401,'مفتاح API غير صالح');
  const key=db.prepare('SELECT id FROM integration_keys WHERE key_hash=? AND active=1').get(hash(value));if(!key)fail(401,'مفتاح API غير صالح');
  db.prepare('UPDATE integration_keys SET last_used_at=? WHERE id=?').run(now(),key.id);return key;
}
export function renderReply(body,values){return String(body).replace(/\{\{([a-z_]+)\}\}/g,(_,key)=>String(values[key]||''));}
