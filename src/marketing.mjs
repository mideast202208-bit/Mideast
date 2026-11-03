import {marketingReview,marketingReadiness,marketingReviewRequired,assertMarketingApproved,setMarketingReview,setMarketingReviewPolicy} from './marketing-review.mjs';
import {uid,now,fail,text,audit,manager} from './service.mjs';
import {transaction} from './db.mjs';
import {accountSummary} from './accounts.mjs';
import {channelConfig} from './omni-config.mjs';
import {hash} from './security.mjs';
import {isIP} from 'node:net';

const socialChannels=['facebook','instagram','tiktok','youtube'];
const permissionNames={facebook:['pages_read_engagement','pages_manage_posts'],instagram:['instagram_basic','instagram_content_publish','pages_read_engagement']};
const access=user=>{if(!manager(user))fail(403,'إدارة التسويق للمالك والمدير');};
const identity=cfg=>hash(JSON.stringify([cfg?.account_id,cfg?.accessToken,cfg?.version,cfg?.appSecret,cfg?.active,cfg?.verified_at]));
function account(db,key,base,origin,id){const row=accountSummary(db,base,origin).find(a=>a.id===id&&socialChannels.includes(a.channel));if(!row)fail(404,'حساب التسويق غير موجود');return {...row,config:row.mode==='messaging'?channelConfig(db,row.channel,key,row.account_id):null};}
export function publicMarketingUrl(value,required=false){
 if(!value&&!required)return '';let u;try{u=new URL(value);}catch{fail(400,'أدخل رابط HTTPS عامًا');}
 const host=u.hostname.toLowerCase();
 if(u.protocol!=='https:'||u.username||u.password||u.port||isIP(host.replace(/[\[\]]/g,''))||!host.includes('.')||/(^|\.)(localhost|local|internal|test|invalid)$/.test(host)||/^(10\.|127\.|192\.168\.|169\.254\.)/.test(host)||[...u.searchParams.keys()].some(k=>/access_token|api_key|appsecret|password/i.test(k)))fail(400,'استخدم رابطًا عامًا بدون بيانات سرية أو عناوين داخلية');
 return u.href;
}
export function embeddedVideo(channel,value){
 let u;try{u=new URL(value);}catch{fail(400,'رابط فيديو غير صالح');}if(u.protocol!=='https:'||u.username||u.password||u.port)fail(400,'رابط فيديو غير صالح');
 if(channel==='youtube'&&['youtube.com','www.youtube.com','m.youtube.com','youtu.be'].includes(u.hostname)){
  const id=u.hostname==='youtu.be'?u.pathname.slice(1):u.pathname==='/watch'?u.searchParams.get('v'):u.pathname.match(/^\/(?:shorts|embed)\/([A-Za-z0-9_-]{11})\/?$/)?.[1];
  if(/^[A-Za-z0-9_-]{11}$/.test(id||''))return {url:'https://www.youtube.com/watch?v='+id,embed_url:'https://www.youtube.com/embed/'+id+'?rel=0'};
 }
 if(channel==='tiktok'&&['tiktok.com','www.tiktok.com'].includes(u.hostname)){
  const match=u.pathname.match(/^\/@([\w.]+)\/(?:video|photo)\/(\d{10,30})\/?$/);if(match)return {url:'https://www.tiktok.com/@'+match[1]+'/video/'+match[2],embed_url:'https://www.tiktok.com/player/v1/'+match[2]+'?autoplay=0&description=1'};
 }
 fail(400,'استخدم الرابط الكامل لفيديو يوتيوب أو تيك توك تابع للقناة المختارة');
}
function graphError(value,status){const error=new Error('META_REQUEST_FAILED');error.code=Number.isInteger(value?.error?.code)?'META_'+value.error.code:'HTTP_'+status;error.definite=Boolean(value?.error?.code);return error;}
async function graph(cfg,path,transport=fetch,body,auth){
 const response=await transport('https://graph.facebook.com/'+cfg.version+'/'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+(auth||cfg.accessToken),...(body?{'Content-Type':'application/x-www-form-urlencoded'}:{})},...(body?{body:new URLSearchParams(body).toString()}:{}),redirect:'error',signal:AbortSignal.timeout(20000)});
 let value;try{value=await response.json();}catch{throw graphError(null,response.status);}
 if(!response.ok||value.error)throw graphError(value,response.status);return value;
}
const safeMedia=value=>{try{return value?publicMarketingUrl(value):'';}catch{return '';}};
const safePermalink=(channel,value)=>{try{const u=new URL(value);const hosts=channel==='facebook'?['facebook.com','www.facebook.com']:['instagram.com','www.instagram.com'];return u.protocol==='https:'&&hosts.includes(u.hostname)&&!u.username&&!u.password?u.href:'';}catch{return '';}};
export function cairoSchedule(value){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))fail(400,'موعد القاهرة غير صالح');
 const [year,month,day,hour,minute]=value.split(/\D/).map(Number),wall=Date.UTC(year,month-1,day,hour,minute);
 const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Cairo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
 const parts=stamp=>Object.fromEntries(formatter.formatToParts(new Date(stamp)).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
 let stamp=wall;for(let i=0;i<3;i++){const p=parts(stamp);stamp=wall-(Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute)-stamp);}
 const p=parts(stamp),check=p.year+'-'+p.month+'-'+p.day+'T'+p.hour+':'+p.minute;if(check!==value)fail(400,'الموعد غير موجود بتوقيت القاهرة؛ اختر ساعة أخرى');return new Date(stamp).toISOString();
}
export async function syncMarketingAccount(db,user,id,key,base,origin,transport=fetch){
 access(user);const a=account(db,key,base,origin,id),cfg=a.config;
 if(!cfg?.accessToken||!cfg.active||!cfg.verified_at||!/^v\d+\.\d+$/.test(cfg.version||''))fail(409,'أكمل ربط حساب الرسائل والتحقق من هويته أولًا');
 let can_read=false,can_publish=false,permissions=[],error_code=null,feed=[];
 try{
  const fields=a.channel==='facebook'?'id,message,created_time,permalink_url,full_picture':'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp';
  const response=await graph(cfg,a.account_id+'/'+(a.channel==='facebook'?'posts':'media')+'?fields='+fields+'&limit=25',transport);can_read=Array.isArray(response.data);feed=response.data||[];
 }catch(error){error_code=error.code||'READ_CONNECTION_FAILED';}
 try{
  if(!cfg.appSecret)throw new Error('NO_APP_SECRET');
  const app=await graph(cfg,'app?fields=id',transport);if(!/^\d+$/.test(String(app.id||'')))throw new Error('NO_APP_ID');
  const debug=await graph(cfg,'debug_token?input_token='+encodeURIComponent(cfg.accessToken),transport,undefined,app.id+'|'+cfg.appSecret);
  const info=debug.data||{};permissions=Array.isArray(info.scopes)?info.scopes.filter(s=>typeof s==='string'&&s.length<100):[];
  const valid=info.is_valid===true&&(!info.expires_at||info.expires_at*1000>Date.now())&&(!info.data_access_expires_at||info.data_access_expires_at*1000>Date.now());
  can_publish=can_read&&valid&&permissionNames[a.channel].every(p=>permissions.includes(p));
  if(!can_publish&&!error_code)error_code='PUBLISH_PERMISSION_REQUIRED';
 }catch(error){error_code ||= error.code||'PUBLISH_PERMISSION_UNVERIFIED';}
 transaction(db,()=>{
  db.prepare('INSERT INTO marketing_account_state VALUES(?,?,?,?,?,?,?) ON CONFLICT(account_key) DO UPDATE SET identity_hash=excluded.identity_hash,can_read=excluded.can_read,can_publish=excluded.can_publish,permissions=excluded.permissions,checked_at=excluded.checked_at,error_code=excluded.error_code').run(id,identity(cfg),can_read?1:0,can_publish?1:0,JSON.stringify(permissions),now(),error_code);
  if(can_read){db.prepare('DELETE FROM marketing_feed WHERE account_key=?').run(id);for(const p of feed.slice(0,25)){
   if(!/^[\w-]{1,100}$/.test(String(p.id||'')))continue;
   const date=p.created_time||p.timestamp,stamp=Number.isFinite(Date.parse(date))?new Date(date).toISOString():now();
   db.prepare('INSERT OR REPLACE INTO marketing_feed VALUES(?,?,?,?,?,?,?,?)').run(id,String(p.id),String(p.message||p.caption||'').slice(0,10000),safeMedia(p.thumbnail_url||p.full_picture||p.media_url),safePermalink(a.channel,p.permalink_url||p.permalink),String(p.media_type||'IMAGE').slice(0,40),stamp,now());
  }}
 });
 audit(db,user,'synced','marketing_account',id,{can_read,can_publish,error_code});return {can_read,can_publish,permissions,error_code,posts:feed.length};
}
function capability(db,a,key){
 const state=db.prepare('SELECT * FROM marketing_account_state WHERE account_key=?').get(a.id),cfg=a.mode==='messaging'?channelConfig(db,a.channel,key,a.account_id):null;
 const current=state&&state.identity_hash===identity(cfg)&&Date.now()-Date.parse(state.checked_at)<24*3600000;
 return {can_read:Boolean(current&&state.can_read),can_publish:Boolean(current&&state.can_publish),checked_at:state?.checked_at||null,error_code:current?state.error_code:'PERMISSION_CHECK_REQUIRED',required_permissions:permissionNames[a.channel]||[],connection:a.mode==='messaging'?'meta':a.channel==='tiktok'||a.channel==='youtube'?'video_library':'profile',permissions:current?JSON.parse(state.permissions):[]};
}
export function marketingData(db,user,key,base,origin){
 access(user);const accounts=accountSummary(db,base,origin).filter(a=>socialChannels.includes(a.channel)).map(a=>({...a,marketing:capability(db,a,key)}));
 const posts=db.prepare('SELECT p.*,o.plan_id,o.local_date FROM marketing_posts p LEFT JOIN marketing_occurrences o ON o.post_id=p.id WHERE o.plan_id IS NULL OR p.id IN(SELECT post_id FROM marketing_occurrences ORDER BY rowid DESC LIMIT 500) ORDER BY p.updated_at DESC').all().map(p=>({...p,review:marketingReview(db,p.id),asset_url:p.asset_id?origin+'/social-media/'+p.asset_id:'',targets:db.prepare('SELECT * FROM marketing_targets WHERE post_id=?').all(p.id),registrations:p.campaign?db.prepare('SELECT COUNT(*) n FROM intake_registrations WHERE campaign=?').get(p.campaign).n:0,tracking_url:p.campaign?origin+'/apply?source=website&utm_campaign='+encodeURIComponent(p.campaign):origin+'/apply'}));
 const assets=db.prepare('SELECT id,name,mime,length(content) size,created_at FROM marketing_assets ORDER BY created_at DESC LIMIT 100').all().map(a=>({...a,url:origin+'/social-media/'+a.id}));
 const feed=db.prepare('SELECT * FROM marketing_feed ORDER BY published_at DESC LIMIT 200').all().filter(p=>accounts.some(a=>a.id===p.account_key));
 const videos=db.prepare('SELECT * FROM marketing_saved_videos ORDER BY created_at DESC LIMIT 100').all().filter(p=>accounts.some(a=>a.id===p.account_key));
 return {accounts,posts,assets,feed,videos,review_policy:{required:marketingReviewRequired(db)},readiness:marketingReadiness(accounts),plans:marketingPlans(db),timezone:'Africa/Cairo',supported_publish:['facebook','instagram'],totals:{drafts:db.prepare("SELECT COUNT(DISTINCT post_id) n FROM marketing_targets WHERE status='draft'").get().n,scheduled:db.prepare("SELECT COUNT(*) n FROM marketing_targets WHERE status IN('scheduled','processing','publishing')").get().n,published:db.prepare("SELECT COUNT(*) n FROM marketing_targets WHERE status='published'").get().n,registrations:db.prepare("SELECT COUNT(*) n FROM intake_registrations WHERE campaign<>'' AND campaign IN(SELECT DISTINCT campaign FROM marketing_posts WHERE campaign<>'')").get().n}};
}
export function saveMarketingAsset(db,user,input,origin){
 access(user);if(typeof input.content!=='string'||input.content.length>7*1024*1024||!/^[A-Za-z0-9+/]*={0,2}$/.test(input.content))fail(400,'صورة غير صالحة');
 const bytes=Buffer.from(input.content,'base64');if(!bytes.length||bytes.length>5*1024*1024)fail(413,'حد الصورة 5 ميجابايت');
 if(!(input.mime==='image/jpeg'&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)&&!(input.mime==='image/png'&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))))fail(400,'ارفع صورة JPG أو PNG حقيقية');
 const total=db.prepare('SELECT COALESCE(SUM(length(content)),0) n FROM marketing_assets').get().n;if(total+bytes.length>500*1024*1024)fail(409,'مكتبة التسويق وصلت 500 ميجابايت؛ راجع المساحة مع الإدارة');
 const id=uid();db.prepare('INSERT INTO marketing_assets VALUES(?,?,?,?,?,?)').run(id,text(input.name,'اسم الصورة',160),input.mime,bytes,user.id,now());audit(db,user,'uploaded','marketing_asset',id);return {id,url:origin+'/social-media/'+id};
}
export function saveMarketingPost(db,user,input,key,base,origin,id){
 access(user);const current=id?db.prepare('SELECT * FROM marketing_posts WHERE id=?').get(id):null;if(id&&!current)fail(404,'المنشور غير موجود');
 if(current&&db.prepare("SELECT 1 FROM marketing_targets WHERE post_id=? AND status NOT IN('draft','cancelled','blocked','failed')").get(id))fail(409,'المنشور مجدول أو تم نشره؛ انسخه كمسودة جديدة للتعديل');
 const title=text(input.title,'عنوان المنشور',160),body=text(input.body,'المحتوى',5000),campaign=text(input.campaign||'','الحملة',150,false);
 const asset_id=input.asset_id||null;if(asset_id&&!db.prepare('SELECT 1 FROM marketing_assets WHERE id=?').get(asset_id))fail(404,'صورة التسويق غير موجودة');
 const media_url=publicMarketingUrl(input.media_url),link_url=publicMarketingUrl(input.link_url),include_registration=input.include_registration===true?1:0;
 if(!Array.isArray(input.accounts)||!input.accounts.length||input.accounts.length>40||new Set(input.accounts).size!==input.accounts.length)fail(400,'اختر حسابًا واحدًا على الأقل دون تكرار');
 const accounts=input.accounts.map(id=>account(db,key,base,origin,id));
 const postId=id||uid();transaction(db,()=>{
  if(current){db.prepare('UPDATE marketing_posts SET title=?,body=?,campaign=?,asset_id=?,media_url=?,link_url=?,include_registration=?,updated_at=? WHERE id=?').run(title,body,campaign,asset_id,media_url,link_url,include_registration,now(),postId);db.prepare('DELETE FROM marketing_targets WHERE post_id=?').run(postId);}
  else db.prepare('INSERT INTO marketing_posts VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(postId,title,body,campaign,asset_id,media_url,link_url,include_registration,user.id,now(),now());
  for(const a of accounts)db.prepare('INSERT INTO marketing_targets(id,post_id,account_key,channel,account_id,updated_at) VALUES(?,?,?,?,?,?)').run(uid(),postId,a.id,a.channel,a.account_id,now());
  audit(db,user,'saved','marketing_post',postId,{accounts:accounts.length});
 });return {id:postId};
}
export function scheduleMarketingTarget(db,user,id,input,key,base,origin){
 access(user);const target=db.prepare('SELECT * FROM marketing_targets WHERE id=?').get(id);if(!target)fail(404,'هدف النشر غير موجود');
 if(!['draft','cancelled','blocked','failed'].includes(target.status))fail(409,'هذا الهدف مجدول أو سبق إرساله؛ النتيجة غير المؤكدة لا تُعاد تلقائيًا');
 const a=account(db,key,base,origin,target.account_key),cfg=a.config;
 if(a.account_id!==target.account_id||a.channel!==target.channel)fail(409,'تغير الحساب؛ احفظ مسودة جديدة');
 if(!['facebook','instagram'].includes(a.channel)||a.mode!=='messaging')fail(409,'النشر المباشر غير متصل لهذه القناة؛ التخطيط ومكتبة الفيديو متاحان');
 if(!capability(db,a,key).can_publish||!cfg?.active||!cfg.verified_at)fail(409,'اختبر صلاحيات النشر لهذا الحساب وأكمل التفويض أولًا');
 assertMarketingApproved(db,target.post_id);
 const post=db.prepare('SELECT * FROM marketing_posts WHERE id=?').get(target.post_id),asset=post.asset_id?db.prepare('SELECT mime FROM marketing_assets WHERE id=?').get(post.asset_id):null;
 if(a.channel==='instagram'&&(!post.asset_id&&!post.media_url))fail(400,'إنستجرام يحتاج صورة JPG عامة؛ النص وحده غير كافٍ');
 if(a.channel==='instagram'&&(asset&&asset.mime!=='image/jpeg'))fail(400,'استخدم صورة JPG للنشر على إنستجرام');
 if(a.channel==='instagram'&&post.body.length+post.link_url.length+250>2200)fail(400,'اختصر نص إنستجرام ليبقى مع الرابط ضمن 2200 حرف');
 if(input.publish_ack!==true)fail(400,'راجع الحساب والمحتوى وأكد النشر');
 const scheduled_at=input.scheduled_local?new Date(cairoSchedule(input.scheduled_local)):input.scheduled_at?new Date(input.scheduled_at):new Date();if(!Number.isFinite(scheduled_at.valueOf())||scheduled_at.valueOf()<Date.now()-60000||scheduled_at.valueOf()>Date.now()+366*86400000)fail(400,'اختر موعدًا صحيحًا خلال السنة القادمة');
 db.prepare("UPDATE marketing_targets SET status='scheduled',scheduled_at=?,container_id=NULL,error_code=NULL,updated_at=? WHERE id=?").run(scheduled_at.toISOString(),now(),id);audit(db,user,'scheduled','marketing_target',id,{scheduled_at:scheduled_at.toISOString()});return {id,status:'scheduled'};
}
export function recoverMarketingJobs(db){db.prepare("UPDATE marketing_targets SET status='unknown',error_code='RESTART_DURING_PUBLICATION',updated_at=? WHERE status='publishing'").run(now());}
export async function processMarketingJobs(db,key,base,origin,transport=fetch){
 const target=db.prepare("SELECT * FROM marketing_targets WHERE (status='scheduled' AND scheduled_at<=?) OR (status='processing' AND updated_at<?) ORDER BY COALESCE(scheduled_at,updated_at) LIMIT 1").get(now(),new Date(Date.now()-15000).toISOString());if(!target)return;
 const previous=target.status,claimed=db.prepare("UPDATE marketing_targets SET status='publishing',attempted_at=?,updated_at=? WHERE id=? AND status=?").run(now(),now(),target.id,previous);if(!claimed.changes)return;
 const update=(status,error=null,providerId=null,containerId=target.container_id)=>db.prepare('UPDATE marketing_targets SET status=?,error_code=?,provider_id=COALESCE(?,provider_id),container_id=?,updated_at=? WHERE id=?').run(status,error,providerId,containerId,now(),target.id);
 let writeStarted=false;
 try{
  const post=db.prepare('SELECT * FROM marketing_posts WHERE id=?').get(target.post_id),creator=db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(post.created_by);
  if(!creator||!manager(creator)){update('blocked','PUBLISHER_ACCESS_REVOKED');return;}
  if(marketingReviewRequired(db)&&marketingReview(db,post.id).state!=='approved'){update('blocked','OWNER_REVIEW_REQUIRED');return;}
  const a=account(db,key,base,origin,target.account_key),cfg=a.config;
  if(a.mode==='messaging'&&cfg?.active&&cfg.verified_at&&!capability(db,a,key).can_publish)await syncMarketingAccount(db,creator,a.id,key,base,origin,transport);
  if(a.account_id!==target.account_id||a.channel!==target.channel||!cfg?.active||!cfg.verified_at||!capability(db,a,key).can_publish){update('blocked','PUBLISH_PERMISSION_REQUIRED');return;}
  const registration=new URL(origin+'/apply');registration.searchParams.set('source',target.channel);if(post.campaign)registration.searchParams.set('utm_campaign',post.campaign);
  const link=post.include_registration?registration.href:post.link_url,caption=post.body+(link?'\n'+link:''),image=post.asset_id?origin+'/social-media/'+post.asset_id:post.media_url;
  if(target.channel==='facebook'){
   writeStarted=true;const result=await graph(cfg,target.account_id+'/'+(image?'photos':'feed'),transport,image?{url:image,caption,published:'true'}:{message:post.body,...(link?{link}:{}),published:'true'});
   const id=String(result.post_id||result.id||'');if(!/^[\w-]{1,100}$/.test(id))throw new Error('MISSING_PUBLICATION_ID');update('published',null,id);
  }else if(target.channel==='instagram'){
   if(!target.container_id){writeStarted=true;const result=await graph(cfg,target.account_id+'/media',transport,{image_url:image,caption});if(!/^\d+$/.test(String(result.id||'')))throw new Error('MISSING_CONTAINER_ID');update('processing',null,null,String(result.id));return;}
   const result=await graph(cfg,target.container_id+'?fields=status_code',transport);
   if(['ERROR','EXPIRED'].includes(result.status_code)){update('failed','INSTAGRAM_'+result.status_code);return;}
   if(result.status_code!=='FINISHED'){if(Date.now()-Date.parse(target.scheduled_at)>24*3600000)update('failed','INSTAGRAM_CONTAINER_TIMEOUT');else update('processing');return;}
   writeStarted=true;const published=await graph(cfg,target.account_id+'/media_publish',transport,{creation_id:target.container_id});if(!/^\d+$/.test(String(published.id||'')))throw new Error('MISSING_PUBLICATION_ID');update('published',null,String(published.id));
  }else{update('blocked','CHANNEL_NOT_CONNECTED');return;}
  audit(db,null,'published','marketing_target',target.id,{channel:target.channel});
 }catch(error){update(writeStarted&&!error.definite?'unknown':writeStarted?'failed':previous==='processing'?'processing':'blocked',error.code||'PROVIDER_CONNECTION_FAILED');}
}
const cairoDay=stamp=>new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Cairo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(stamp));
const addDay=day=>new Date(Date.parse(day+'T12:00:00Z')+86400000).toISOString().slice(0,10);
function publicationReady(db,a,post,key,checkPermission=true){
 if(!['facebook','instagram'].includes(a.channel)||a.mode!=='messaging'||!a.config?.active||!a.config.verified_at||checkPermission&&!capability(db,a,key).can_publish)fail(409,'اختر حسابات جاهزة للنشر بعد اختبار صلاحياتها');
 if(a.channel==='instagram'){
  const asset=post.asset_id?db.prepare('SELECT mime FROM marketing_assets WHERE id=?').get(post.asset_id):null;
  if(!post.asset_id&&!post.media_url||asset&&asset.mime!=='image/jpeg')fail(400,'كل محتوى إنستجرام يحتاج صورة JPG عامة');
  if(post.body.length+post.link_url.length+250>2200)fail(400,'اختصر نصوص إنستجرام إلى أقل من 1950 حرفًا مع الروابط');
 }
}
export function marketingPlans(db){
 return db.prepare('SELECT * FROM marketing_plans ORDER BY created_at DESC').all().map(p=>({...p,accounts:JSON.parse(p.accounts).map(a=>typeof a==='string'?a:a.key),templates:JSON.parse(p.templates),weekdays:JSON.parse(p.weekdays),repeat:Boolean(p.repeat),queued:db.prepare("SELECT COUNT(DISTINCT o.post_id) n FROM marketing_occurrences o JOIN marketing_targets t ON t.post_id=o.post_id WHERE o.plan_id=? AND t.status IN('scheduled','processing','publishing')").get(p.id).n,next_at:db.prepare("SELECT MIN(t.scheduled_at) stamp FROM marketing_occurrences o JOIN marketing_targets t ON t.post_id=o.post_id WHERE o.plan_id=? AND t.status='scheduled'").get(p.id).stamp,published:db.prepare("SELECT COUNT(*) n FROM marketing_occurrences o JOIN marketing_targets t ON t.post_id=o.post_id WHERE o.plan_id=? AND t.status='published'").get(p.id).n,issues:db.prepare("SELECT COUNT(*) n FROM marketing_occurrences o JOIN marketing_targets t ON t.post_id=o.post_id WHERE o.plan_id=? AND t.status IN('blocked','failed','unknown')").get(p.id).n}));
}
function boundPlanAccount(db,key,base,origin,binding){
 if(!binding||typeof binding!=='object')fail(409,'احفظ الخطة مجددًا لتأكيد هويات حساباتها');
 const a=account(db,key,base,origin,binding.key);if(a.account_id!==binding.account_id||a.channel!==binding.channel)fail(409,'تغيّرت هوية حساب في الخطة؛ راجع الحسابات واحفظها مجددًا');return a;
}
function cancelPlanQueue(db,id){
 db.prepare("UPDATE marketing_targets SET status='cancelled',updated_at=? WHERE post_id IN(SELECT post_id FROM marketing_occurrences WHERE plan_id=?) AND status IN('scheduled','draft','blocked','failed','processing')").run(now(),id);
}
export function saveMarketingPlan(db,user,input,key,base,origin,id){
 access(user);const current=id?db.prepare('SELECT * FROM marketing_plans WHERE id=?').get(id):null;if(id&&!current)fail(404,'خطة النشر غير موجودة');
 if(!current&&db.prepare('SELECT COUNT(*) n FROM marketing_plans').get().n>=10)fail(409,'حد المنصة 10 خطط نشر مستمرة');
 const name=text(input.name,'اسم الخطة',100),local_time=String(input.local_time||'');if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(local_time))fail(400,'اختر موعدًا صحيحًا بتوقيت القاهرة');
 const weekdays=input.weekdays;if(!Array.isArray(weekdays)||!weekdays.length||weekdays.length>7||new Set(weekdays).size!==weekdays.length||weekdays.some(d=>!Number.isInteger(d)||d<0||d>6))fail(400,'اختر أيام النشر');
 if(!Array.isArray(input.accounts)||!input.accounts.length||input.accounts.length>40||new Set(input.accounts).size!==input.accounts.length)fail(400,'اختر حسابات النشر دون تكرار');
 if(!Array.isArray(input.templates)||!input.templates.length||input.templates.length>60||new Set(input.templates).size!==input.templates.length)fail(400,'اختر من 1 إلى 60 منشورًا لبنك المحتوى');
 const templates=input.templates.map(id=>{const p=db.prepare('SELECT * FROM marketing_posts WHERE id=?').get(id);if(!p||db.prepare('SELECT 1 FROM marketing_occurrences WHERE post_id=?').get(id))fail(400,'اختر مسودات أصلية لبنك المحتوى');return p;});
 const bindings=input.accounts.map(id=>{const a=account(db,key,base,origin,id);for(const p of templates)publicationReady(db,a,p,key);return {key:a.id,account_id:a.account_id,channel:a.channel};});
 const active=input.active===true;if(active&&input.publish_ack!==true)fail(400,'أكد تشغيل النشر المستمر للمحتوى والحسابات المختارة');
 const today=cairoDay(Date.now()),next_date=input.start_date||today;
 if(!/^\d{4}-\d{2}-\d{2}$/.test(next_date)||next_date<today||next_date>cairoDay(Date.now()+366*86400000)||!Number.isFinite(Date.parse(next_date+'T12:00:00Z'))||new Date(next_date+'T12:00:00Z').toISOString().slice(0,10)!==next_date)fail(400,'اختر تاريخ بداية صحيحًا خلال السنة القادمة');
 const planId=id||uid();transaction(db,()=>{
  if(current){cancelPlanQueue(db,id);db.prepare('UPDATE marketing_plans SET name=?,state=?,local_time=?,weekdays=?,accounts=?,templates=?,repeat=?,cursor=0,next_date=?,revision=revision+1,last_error=NULL,created_by=?,updated_at=? WHERE id=?').run(name,active?'active':'paused',local_time,JSON.stringify(weekdays),JSON.stringify(bindings),JSON.stringify(input.templates),input.repeat===true?1:0,next_date,user.id,now(),id);}
  else db.prepare('INSERT INTO marketing_plans(id,name,state,local_time,weekdays,accounts,templates,repeat,next_date,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(planId,name,active?'active':'paused',local_time,JSON.stringify(weekdays),JSON.stringify(bindings),JSON.stringify(input.templates),input.repeat===true?1:0,next_date,user.id,now(),now());
  audit(db,user,'configured','marketing_plan',planId,{active,templates:templates.length,accounts:input.accounts.length});
 });
 processMarketingPlans(db,key,base,origin);return {id:planId,state:active?'active':'paused'};
}
export function setMarketingPlanState(db,user,id,input,key,base,origin){
 access(user);const plan=db.prepare('SELECT * FROM marketing_plans WHERE id=?').get(id);if(!plan)fail(404,'خطة النشر غير موجودة');
 if(typeof input.active!=='boolean')fail(400,'اختر تشغيل أو إيقاف الخطة');
 if(input.active){
  if(plan.state==='active')return {ok:true};if(input.publish_ack!==true)fail(400,'أكد استئناف النشر');
  const templates=JSON.parse(plan.templates).map(id=>db.prepare('SELECT * FROM marketing_posts WHERE id=?').get(id));if(templates.some(p=>!p))fail(409,'راجع محتوى الخطة');
  for(const binding of JSON.parse(plan.accounts)){const a=boundPlanAccount(db,key,base,origin,binding);for(const p of templates)publicationReady(db,a,p,key);}
  db.prepare("UPDATE marketing_plans SET state='active',next_date=?,revision=revision+1,last_error=NULL,created_by=?,updated_at=? WHERE id=?").run(cairoDay(Date.now()),user.id,now(),id);
 }else transaction(db,()=>{
  const first=db.prepare("SELECT MIN(o.position) n FROM marketing_occurrences o JOIN marketing_targets t ON t.post_id=o.post_id WHERE o.plan_id=? AND o.revision=? AND t.status='scheduled' AND NOT EXISTS(SELECT 1 FROM marketing_targets s WHERE s.post_id=o.post_id AND s.status IN('published','publishing','processing','unknown'))").get(id,plan.revision).n;
  cancelPlanQueue(db,id);db.prepare("UPDATE marketing_plans SET state='paused',cursor=?,updated_at=? WHERE id=?").run(first??plan.cursor,now(),id);
 });
 audit(db,user,input.active?'resumed':'paused','marketing_plan',id);processMarketingPlans(db,key,base,origin);return {ok:true};
}
export function processMarketingPlans(db,key,base,origin,stamp=Date.now()){
 // Old recurring slots are skipped after downtime; never burst-publish a backlog.
 db.prepare("UPDATE marketing_targets SET status='blocked',error_code='MISSED_RECURRING_SLOT',updated_at=? WHERE status='scheduled' AND scheduled_at<? AND post_id IN(SELECT post_id FROM marketing_occurrences)").run(new Date(stamp).toISOString(),new Date(stamp-2*3600000).toISOString());
 const today=cairoDay(stamp),horizon=cairoDay(stamp+14*86400000);
 for(const plan of db.prepare("SELECT * FROM marketing_plans WHERE state='active'").all()){
  const creator=db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(plan.created_by);
  if(!creator||!manager(creator)){transaction(db,()=>{cancelPlanQueue(db,plan.id);db.prepare("UPDATE marketing_plans SET state='paused',last_error='PUBLISHER_ACCESS_REVOKED' WHERE id=?").run(plan.id);});continue;}
  const templates=JSON.parse(plan.templates),accounts=JSON.parse(plan.accounts),weekdays=JSON.parse(plan.weekdays);
  let day=plan.next_date<today?today:plan.next_date,cursor=plan.cursor,last_error=null;
  transaction(db,()=>{
   for(;day<=horizon;day=addDay(day)){
    if(!weekdays.includes(new Date(day+'T12:00:00Z').getUTCDay()))continue;
    let scheduled;try{scheduled=cairoSchedule(day+'T'+plan.local_time);}catch{last_error='INVALID_LOCAL_SLOT';continue;}
    if(Date.parse(scheduled)<stamp+60000)continue;
    if(!plan.repeat&&cursor>=templates.length)break;
    if(db.prepare('SELECT 1 FROM marketing_occurrences WHERE plan_id=? AND revision=? AND local_date=?').get(plan.id,plan.revision,day))continue;
    const source=db.prepare('SELECT * FROM marketing_posts WHERE id=?').get(templates[cursor%templates.length]);if(!source){last_error='PLAN_CONTENT_MISSING';break;}
    let selected;try{selected=accounts.map(binding=>boundPlanAccount(db,key,base,origin,binding));for(const a of selected)publicationReady(db,a,source,key,false);}catch{last_error='PLAN_CONTENT_OR_ACCOUNT_INVALID';break;}
    const postId=uid();db.prepare('INSERT INTO marketing_posts VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(postId,source.title,source.body,source.campaign,source.asset_id,source.media_url,source.link_url,source.include_registration,plan.created_by,new Date(stamp).toISOString(),new Date(stamp).toISOString());
    db.prepare('INSERT INTO marketing_occurrences VALUES(?,?,?,?,?)').run(plan.id,plan.revision,day,cursor,postId);
    for(const a of selected)db.prepare("INSERT INTO marketing_targets(id,post_id,account_key,channel,account_id,status,scheduled_at,updated_at) VALUES(?,?,?,?,?,'scheduled',?,?)").run(uid(),postId,a.id,a.channel,a.account_id,scheduled,new Date(stamp).toISOString());
    cursor++;
   }
   db.prepare('UPDATE marketing_plans SET cursor=?,next_date=?,last_error=? WHERE id=?').run(cursor,day,last_error,plan.id);
  });
 }
}
export async function handleMarketing(ctx){
 const {db,user,path,method,req,res,jsonBody,sendJson,secretKey,origin,config,transport}=ctx;
 const send=(status,value)=>{sendJson(res,status,value);return true;};if(!path.startsWith('/api/marketing'))return false;access(user);
 if(path==='/api/marketing'&&method==='GET')return send(200,marketingData(db,user,secretKey,config,origin));
 if(path==='/api/marketing/review-policy'&&method==='POST')return send(200,setMarketingReviewPolicy(db,user,await jsonBody(req)));
 const review=path.match(/^\/api\/marketing\/posts\/([^/]+)\/review$/);if(review&&method==='POST')return send(200,setMarketingReview(db,user,review[1],await jsonBody(req)));
 if(path==='/api/marketing/assets'&&method==='POST')return send(201,saveMarketingAsset(db,user,await jsonBody(req,8*1024*1024),origin));
 if(path==='/api/marketing/posts'&&method==='POST')return send(201,saveMarketingPost(db,user,await jsonBody(req),secretKey,config,origin));
 if(path==='/api/marketing/plans'&&method==='POST')return send(201,saveMarketingPlan(db,user,await jsonBody(req),secretKey,config,origin));
 const plan=path.match(/^\/api\/marketing\/plans\/([^/]+)(?:\/(state))?$/);
 if(plan&&method==='PATCH'&&!plan[2])return send(200,saveMarketingPlan(db,user,await jsonBody(req),secretKey,config,origin,plan[1]));
 if(plan&&method==='POST'&&plan[2])return send(200,setMarketingPlanState(db,user,plan[1],await jsonBody(req),secretKey,config,origin));
 const post=path.match(/^\/api\/marketing\/posts\/([^/]+)$/);if(post&&method==='PATCH')return send(200,saveMarketingPost(db,user,await jsonBody(req),secretKey,config,origin,post[1]));
 const sync=path.match(/^\/api\/marketing\/accounts\/([^/]+)\/sync$/);if(sync&&method==='POST')return send(200,await syncMarketingAccount(db,user,sync[1],secretKey,config,origin,transport));
 const target=path.match(/^\/api\/marketing\/targets\/([^/]+)\/(schedule|cancel)$/);
 if(target&&method==='POST'){
  if(target[2]==='schedule')return send(200,scheduleMarketingTarget(db,user,target[1],await jsonBody(req),secretKey,config,origin));
  const changed=db.prepare("UPDATE marketing_targets SET status='cancelled',updated_at=? WHERE id=? AND status IN('draft','scheduled','blocked','failed')").run(now(),target[1]);if(!changed.changes)fail(409,'الهدف غير موجود أو دخل مرحلة الإرسال ولا يمكن إلغاؤه');audit(db,user,'cancelled','marketing_target',target[1]);return send(200,{ok:true});
 }
 if(path==='/api/marketing/videos'&&method==='POST'){
  const input=await jsonBody(req),a=account(db,secretKey,config,origin,input.account_key),video=embeddedVideo(a.channel,input.url),id=uid();
  if(db.prepare('SELECT 1 FROM marketing_saved_videos WHERE account_key=? AND url=?').get(a.id,video.url))fail(409,'الفيديو محفوظ بالفعل');
  db.prepare('INSERT INTO marketing_saved_videos VALUES(?,?,?,?,?,?,?)').run(id,a.id,text(input.title,'عنوان الفيديو',160),video.url,video.embed_url,user.id,now());audit(db,user,'saved','marketing_video',id);return send(201,{id});
 }
 return false;
}
