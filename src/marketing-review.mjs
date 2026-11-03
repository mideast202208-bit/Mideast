import {createHash} from 'node:crypto';
import {fail,manager,now,text,audit} from './service.mjs';

const key=id=>'marketing.review.'+id;
const read=(db,id)=>{try{return JSON.parse(db.prepare('SELECT value FROM settings WHERE key=?').get(key(id))?.value||'null');}catch{return null;}};
export const marketingReviewRequired=db=>db.prepare("SELECT value FROM settings WHERE key='marketing.require_approval'").get()?.value==='true';
export function marketingFingerprint(db,id){
 const p=db.prepare('SELECT * FROM marketing_posts WHERE id=?').get(id);if(!p)fail(404,'المنشور غير موجود');
 const targets=db.prepare('SELECT account_key,channel,account_id FROM marketing_targets WHERE post_id=? ORDER BY account_key').all(id);
 const image=p.asset_id?db.prepare('SELECT content FROM marketing_assets WHERE id=?').get(p.asset_id)?.content:null;
 return createHash('sha256').update(JSON.stringify([p.title,p.body,p.campaign,p.asset_id,p.media_url,p.link_url,p.include_registration,targets,image?createHash('sha256').update(image).digest('hex'):null])).digest('hex');
}
export function marketingReview(db,id){
 let row=read(db,id);
 if(!row){const o=db.prepare('SELECT * FROM marketing_occurrences WHERE post_id=?').get(id);if(o){const plan=db.prepare('SELECT templates FROM marketing_plans WHERE id=?').get(o.plan_id);const templates=plan?JSON.parse(plan.templates):[];if(templates.length)row=read(db,templates[o.position%templates.length]);}}
 if(!row)return {state:'unreviewed'};
 const current=marketingFingerprint(db,id)===row.fingerprint;
 const reviewer=row.reviewed_by?db.prepare("SELECT id FROM users WHERE id=? AND role='admin' AND active=1").get(row.reviewed_by):null;
 return {...row,state:!current?'stale':row.state==='approved'&&!reviewer?'stale':row.state};
}
export function assertMarketingApproved(db,id){if(marketingReviewRequired(db)&&marketingReview(db,id).state!=='approved')fail(409,'اعتماد المالك للمحتوى والحسابات الحالية مطلوب قبل النشر');}
export function setMarketingReview(db,user,id,input){
 if(!manager(user))fail(403,'مراجعة التسويق للإدارة');
 const action=input.action;if(!['request','approve','reject'].includes(action))fail(400,'إجراء مراجعة غير صالح');
 if(action!=='request'&&user.role!=='admin')fail(403,'اعتماد أو رفض المحتوى للمالك');
 if(action==='approve'&&(!input.checks||!['facts','rights','language','brand','contacts'].every(k=>input.checks[k]===true)))fail(400,'أكد مراجعة الحقائق والحقوق واللغة والهوية والتواصل');
 if(db.prepare("SELECT 1 FROM marketing_targets WHERE post_id=? AND status IN('publishing','processing','unknown','published')").get(id))fail(409,'المحتوى دخل النشر؛ انسخه لمسودة جديدة للمراجعة');
 const record={state:action==='request'?'pending':action==='approve'?'approved':'rejected',fingerprint:marketingFingerprint(db,id),note:text(input.note||'','ملاحظات المراجعة',2000,false),updated_at:now(),requested_by:user.id,...(action!=='request'?{reviewed_by:user.id}:{}),checks:action==='approve'?{facts:true,rights:true,language:true,brand:true,contacts:true}:null};
 db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key(id),JSON.stringify(record));audit(db,user,action,'marketing_review',id,{state:record.state});return record;
}
export function setMarketingReviewPolicy(db,user,input){
 if(user.role!=='admin')fail(403,'سياسة الاعتماد للمالك');
 if(typeof input.required!=='boolean'||input.policy_ack!==true)fail(400,'أكد أثر السياسة على كل المنشورات والخطط المجدولة قبل الحفظ');
 db.prepare("INSERT INTO settings VALUES('marketing.require_approval',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(input.required));audit(db,user,'configured','marketing_review_policy','required',{required:input.required});return {required:input.required};
}
export function marketingReadiness(accounts){
 return accounts.map(a=>({account_key:a.id,channel:a.channel,name:a.name,read_posts:a.marketing.can_read,publish_image:a.marketing.can_publish&&['facebook','instagram'].includes(a.channel),publish_video:false,publish_story:false,comments:false,analytics:false,ads:false,note:['tiktok','youtube'].includes(a.channel)?'مكتبة روابط فقط؛ لا يوجد تفويض API للنشر أو الرسائل في هذا الربط.':'الربط الحالي يدعم المنشورات والصور عند تحقق الصلاحيات؛ الفيديو والقصص والإحصاءات والإعلانات غير منفذة في هذا الإصدار.'}));
}
