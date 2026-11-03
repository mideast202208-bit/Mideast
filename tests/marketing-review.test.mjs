import {renderFixture,fixture as uiFixture} from './ui-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../src/db.mjs';
import {uid,now} from '../src/service.mjs';
import {ensureOmniDefaults,saveChannel} from '../src/omni-config.mjs';
import {saveMarketingPost,marketingData,processMarketingJobs} from '../src/marketing.mjs';
import {marketingReview,marketingReviewRequired,setMarketingReview,setMarketingReviewPolicy,assertMarketingApproved,marketingReadiness} from '../src/marketing-review.mjs';
const checks={facts:true,rights:true,language:true,brand:true,contacts:true};
function setup(){
 const db=openDatabase(':memory:'),key=Buffer.alloc(32,7),users={};
 for(const role of ['admin','manager','agent']){const u={id:uid(),role};users[role]=u;db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?)').run(u.id,'Synthetic '+role,u.id+'@example.test','unused',role,1,now());}
 ensureOmniDefaults(db);saveChannel(db,users.admin,'facebook',{account_id:'100',accessToken:'synthetic-only-token',appSecret:'synthetic-only-secret',version:'v26.0',intake_user:users.admin.id,active:true},key);
 const input={title:'Synthetic university',body:'Synthetic verified draft',accounts:['primary-facebook']};
 const post=saveMarketingPost(db,users.manager,input,key,{},'https://crm.example.com');return {db,key,users,input,post};
}
test('reviews require owner approval and five explicit checks without scheduling or publishing',()=>{
 const {db,users,post}=setup();try{
  assert.equal(marketingReviewRequired(db),false);assert.equal(marketingReview(db,post.id).state,'unreviewed');
  setMarketingReview(db,users.manager,post.id,{action:'request',note:'Review official sources'});assert.equal(marketingReview(db,post.id).state,'pending');
  assert.throws(()=>setMarketingReview(db,users.manager,post.id,{action:'approve',checks}),e=>e.status===403);
  assert.throws(()=>setMarketingReview(db,users.agent,post.id,{action:'request'}),e=>e.status===403);
  assert.throws(()=>setMarketingReview(db,users.admin,post.id,{action:'approve',checks:{facts:true}}),e=>e.status===400);
  setMarketingReview(db,users.admin,post.id,{action:'approve',checks});assert.equal(marketingReview(db,post.id).state,'approved');
  assert.equal(db.prepare('SELECT status FROM marketing_targets WHERE post_id=?').get(post.id).status,'draft');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit WHERE entity='marketing_review'").get().n,2);
 }finally{db.close();}
});
test('changed content, recipient binding and reviewer revocation invalidate an approval',()=>{
 const {db,users,post}=setup();try{
  setMarketingReview(db,users.admin,post.id,{action:'approve',checks});db.prepare('UPDATE marketing_posts SET body=? WHERE id=?').run('Different information',post.id);assert.equal(marketingReview(db,post.id).state,'stale');
  setMarketingReview(db,users.admin,post.id,{action:'approve',checks});db.prepare('UPDATE marketing_targets SET account_id=? WHERE post_id=?').run('999',post.id);assert.equal(marketingReview(db,post.id).state,'stale');
  const asset=uid();db.prepare('INSERT INTO marketing_assets VALUES(?,?,?,?,?,?)').run(asset,'Synthetic image','image/jpeg',Buffer.from([255,216,255,1]),users.admin.id,now());db.prepare('UPDATE marketing_posts SET asset_id=? WHERE id=?').run(asset,post.id);
  setMarketingReview(db,users.admin,post.id,{action:'approve',checks});db.prepare('UPDATE marketing_assets SET content=? WHERE id=?').run(Buffer.from([255,216,255,2]),asset);assert.equal(marketingReview(db,post.id).state,'stale');
  setMarketingReview(db,users.admin,post.id,{action:'approve',checks});db.prepare('UPDATE users SET active=0 WHERE id=?').run(users.admin.id);assert.equal(marketingReview(db,post.id).state,'stale');
 }finally{db.close();}
});
test('opt-in policy cannot be enabled by a manager or without acknowledging the queue impact',async()=>{
 const {db,key,users,post}=setup();try{
  assert.throws(()=>setMarketingReviewPolicy(db,users.manager,{required:true,policy_ack:true}),e=>e.status===403);
  assert.throws(()=>setMarketingReviewPolicy(db,users.admin,{required:true}),e=>e.status===400);
  setMarketingReviewPolicy(db,users.admin,{required:true,policy_ack:true});assert.throws(()=>assertMarketingApproved(db,post.id),e=>e.status===409);
  db.prepare("UPDATE marketing_targets SET status='scheduled',scheduled_at=? WHERE post_id=?").run(new Date(Date.now()-1000).toISOString(),post.id);
  let calls=0;await processMarketingJobs(db,key,{},'https://crm.example.com',async()=>{calls++;throw Error('must not call provider');});
  assert.equal(calls,0);assert.equal(db.prepare('SELECT error_code FROM marketing_targets WHERE post_id=?').get(post.id).error_code,'OWNER_REVIEW_REQUIRED');
  setMarketingReview(db,users.admin,post.id,{action:'approve',checks});assert.doesNotThrow(()=>assertMarketingApproved(db,post.id));
  assert.ok(!JSON.stringify(marketingData(db,users.admin,key,{},'https://crm.example.com')).includes('synthetic-only-token'));
 }finally{db.close();}
});
test('capability matrix describes implemented account access and never invents video, stories or analytics',()=>{
 const rows=marketingReadiness([{id:'y',channel:'youtube',name:'Synthetic channel',marketing:{can_read:false,can_publish:false}},{id:'f',channel:'facebook',name:'Synthetic page',marketing:{can_read:true,can_publish:true}}]);
 assert.equal(rows[0].publish_image,false);assert.equal(rows[1].publish_image,true);for(const r of rows)for(const k of ['publish_video','publish_story','comments','analytics','ads'])assert.equal(r[k],false);
});

test('review and readiness views render real states and escape reviewer notes without claiming unsupported publishing',async()=>{
 const {db,key,users,post}=setup();try{
  setMarketingReview(db,users.manager,post.id,{action:'request',note:'<img src=x onerror=alert(1)>'});const data=structuredClone(uiFixture);data.marketing=marketingData(db,users.admin,key,{},'https://crm.example.com');
  const ui=await renderFixture(data),review=await ui.marketingTab('review'),ready=await ui.marketingTab('readiness');
  assert.match(review,/بانتظار المالك/);assert.match(review,/&lt;img/);assert.ok(!review.includes('<img src=x'));assert.match(ready,/غير متاح في الربط الحالي/);assert.match(ready,/WhatsApp Status/);assert.ok(!ready.includes('undefined'));
 }finally{db.close();}
});
