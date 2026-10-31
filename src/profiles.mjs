import {uid,now,fail,text,audit} from './service.mjs';
export const profileChannels=['facebook','instagram','tiktok','youtube'];
export function profileUrl(channel,value){
 let url;try{url=new URL(value);}catch{fail(400,'أدخل رابط الصفحة كاملًا');}
 const hosts={facebook:['facebook.com','www.facebook.com','m.facebook.com'],instagram:['instagram.com','www.instagram.com'],tiktok:['tiktok.com','www.tiktok.com'],youtube:['youtube.com','www.youtube.com']};
 if(!hosts[channel]?.includes(url.hostname)||url.protocol!=='https:'||url.port||url.username||url.password||!url.pathname.replaceAll('/','')||url.hash)fail(400,'الرابط لا يطابق قناة الحساب');
 if(url.search&&!(channel==='facebook'&&url.pathname==='/profile.php'&&/^\?id=\d+$/.test(url.search)))fail(400,'استخدم رابط الصفحة المباشر بدون معاملات تتبع أو مفاتيح');
 if(channel==='tiktok'&&!/^\/@[\w.]+\/?$/.test(url.pathname)||channel==='youtube'&&!/^\/(?:@[^/]+|(?:channel|c|user)\/[^/]+)\/?$/.test(url.pathname))fail(400,'استخدم رابط الحساب أو القناة، وليس رابط فيديو');
 url.hostname=channel+'.com';url.pathname=url.pathname.replace(/\/$/,'');return url.href;
}
export function mergeProfiles(db,accounts){
 const profiles=db.prepare('SELECT id,channel,name,url,account_key FROM social_profiles ORDER BY created_at').all();
 return [...accounts.map(a=>{const p=profiles.find(p=>p.account_key===a.id);return {...a,mode:'messaging',...(p?{name:p.name,profile_url:p.url,profile_id:p.id}:{})};}),...profiles.filter(p=>!p.account_key).map(p=>({...p,account_id:p.id,profile_url:p.url,mode:'profile',state:'profile_link'}))];
}
export function saveProfile(db,user,input,accounts,id){
 if(user.role!=='admin')fail(403,'إدارة الصفحات للمالك');
 const current=id?db.prepare('SELECT * FROM social_profiles WHERE id=?').get(id):null;if(id&&!current)fail(404,'الصفحة غير موجودة');
 const channel=current?.channel||input.channel;if(!profileChannels.includes(channel))fail(400,'اختر القناة');
 const name=text(input.name,'اسم الصفحة',100),url=profileUrl(channel,input.url),account_key=input.account_key||null;
 if(account_key&&!accounts.some(a=>a.id===account_key&&a.channel===channel&&a.mode!=='profile'))fail(400,'اختر حساب الرسائل الخاص بنفس القناة');
 const duplicate=db.prepare('SELECT id FROM social_profiles WHERE channel=? AND url=? AND id<>?').get(channel,url,id||'');
 if(duplicate)fail(409,'الصفحة مضافة بالفعل');
 if(account_key&&db.prepare('SELECT id FROM social_profiles WHERE account_key=? AND id<>?').get(account_key,id||''))fail(409,'حساب الرسائل له بطاقة بالفعل');
 const nextCount=accounts.filter(a=>a.channel===channel).length-(current&&!current.account_key?1:0)+(!account_key?1:0);
 if(nextCount>10)fail(409,'وصلت لحد 10 حسابات لهذه القناة');
 const profileId=id||uid();
 if(current)db.prepare('UPDATE social_profiles SET name=?,url=?,account_key=? WHERE id=?').run(name,url,account_key,profileId);
 else db.prepare('INSERT INTO social_profiles VALUES(?,?,?,?,?,?,?)').run(profileId,channel,name,url,account_key,user.id,now());
 audit(db,user,'configured','social_profile',profileId,{channel});return {id:profileId};
}
