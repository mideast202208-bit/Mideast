import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../src/db.mjs';
import {uid,now} from '../src/service.mjs';
import {ensureOmniDefaults,saveChannel} from '../src/omni-config.mjs';
import {saveExtraAccount,verifyExtraAccount,accountSummary} from '../src/accounts.mjs';
import {saveProfile} from '../src/profiles.mjs';
import {syncMarketingAccount,marketingData,saveMarketingPost,scheduleMarketingTarget,processMarketingJobs,recoverMarketingJobs,saveMarketingAsset,embeddedVideo,publicMarketingUrl,cairoSchedule} from '../src/marketing.mjs';
import {createApp} from '../src/server.mjs';
import {renderFixture,fixture as uiFixture} from './ui-fixture.mjs';
const permissions=['pages_read_engagement','pages_manage_posts','instagram_basic','instagram_content_publish'];
function fixture(){
 const db=openDatabase(':memory:'),key=Buffer.alloc(32,8),users={};
 for(const role of ['admin','manager','agent','accountant']){const user={id:uid(),role};users[role]=user;db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?)').run(user.id,'Synthetic '+role,user.id+'@example.test','unused',role,1,now());}
 ensureOmniDefaults(db);for(const [channel,id] of [['facebook','100'],['instagram','200']]){saveChannel(db,users.admin,channel,{account_id:id,accessToken:'synthetic-'+channel+'-token',appSecret:'synthetic-meta-secret',version:'v26.0',intake_user:users.admin.id,active:true},key);db.prepare('UPDATE channel_accounts SET verified_at=? WHERE channel=?').run(now(),channel);}
 return {db,key,users,base:{},origin:'https://crm.example.com'};
}
function provider(scopes=permissions,extra){const calls=[];const transport=async(url,options={})=>{calls.push({url,options});if(extra){const result=await extra(url,options);if(result)return result;}if(url.includes('/debug_token?'))return {ok:true,status:200,json:async()=>({data:{is_valid:true,scopes,expires_at:0,data_access_expires_at:0}})};if(url.includes('/app?'))return {ok:true,status:200,json:async()=>({id:'555'})};if(url.includes('/posts?')||url.includes('/media?')&&options.method!=='POST')return {ok:true,status:200,json:async()=>({data:[{id:'100_1',message:'Synthetic public post',caption:'Synthetic caption',created_time:now(),timestamp:now(),permalink_url:'https://facebook.com/100/posts/1',media_url:'https://cdn.example.com/synthetic.jpg'}]})};return {ok:true,status:200,json:async()=>({id:'100_900'})};};return {transport,calls};}
const input=(accounts=['primary-facebook'],extra={})=>({title:'Synthetic campaign post',body:'Synthetic content, never live',campaign:'synthetic-campaign',accounts,...extra});
const targetFor=(db,post,account='primary-facebook')=>db.prepare('SELECT * FROM marketing_targets WHERE post_id=? AND account_key=?').get(post.id,account);
test('reading page content and message verification never imply permission to publish; rotated tokens invalidate checks',async()=>{
 const {db,key,users,base,origin}=fixture(),mock=provider(['pages_messaging','pages_read_engagement']);try{
  const checked=await syncMarketingAccount(db,users.admin,'primary-facebook',key,base,origin,mock.transport);assert.equal(checked.can_read,true);assert.equal(checked.can_publish,false);
  const data=marketingData(db,users.manager,key,base,origin);assert.equal(data.feed.length,1);assert.equal(data.accounts[0].marketing.can_publish,false);assert.ok(!JSON.stringify(data).includes('synthetic-facebook-token'));
  const post=saveMarketingPost(db,users.manager,input(),key,base,origin),target=targetFor(db,post);assert.throws(()=>scheduleMarketingTarget(db,users.admin,target.id,{publish_ack:true},key,base,origin),e=>e.status===409);
  const valid=provider();await syncMarketingAccount(db,users.admin,'primary-facebook',key,base,origin,valid.transport);assert.equal(marketingData(db,users.admin,key,base,origin).accounts.find(a=>a.channel==='facebook').marketing.can_publish,true);
  saveChannel(db,users.admin,'facebook',{accessToken:'synthetic-rotated-facebook-token'},key);assert.equal(marketingData(db,users.admin,key,base,origin).accounts.find(a=>a.channel==='facebook').marketing.can_publish,false);
  for(const user of [users.agent,users.accountant]){assert.throws(()=>marketingData(db,user,key,base,origin),e=>e.status===403);assert.throws(()=>saveMarketingPost(db,user,input(),key,base,origin),e=>e.status===403);}
 }finally{db.close();}
});
test('drafts do not publish; explicit scheduling sends once from the selected page and adds the campaign registration link',async()=>{
 const {db,key,users,base,origin}=fixture(),mock=provider();try{
  await syncMarketingAccount(db,users.admin,'primary-facebook',key,base,origin,mock.transport);
  const post=saveMarketingPost(db,users.admin,input(['primary-facebook'],{include_registration:true}),key,base,origin),target=targetFor(db,post);
  await processMarketingJobs(db,key,base,origin,mock.transport);assert.equal(mock.calls.filter(c=>c.options.method==='POST').length,0);
  assert.throws(()=>scheduleMarketingTarget(db,users.admin,target.id,{},key,base,origin),e=>e.status===400);
  scheduleMarketingTarget(db,users.admin,target.id,{publish_ack:true},key,base,origin);await processMarketingJobs(db,key,base,origin,mock.transport);await processMarketingJobs(db,key,base,origin,mock.transport);
  const writes=mock.calls.filter(c=>c.options.method==='POST');assert.equal(writes.length,1);assert.match(writes[0].url,/\/100\/feed$/);assert.equal(writes[0].options.headers.Authorization,'Bearer synthetic-facebook-token');const form=new URLSearchParams(writes[0].options.body);assert.equal(form.get('message'),'Synthetic content, never live');const link=new URL(form.get('link'));assert.equal(link.searchParams.get('source'),'facebook');assert.equal(link.searchParams.get('utm_campaign'),'synthetic-campaign');
  assert.equal(targetFor(db,post).status,'published');assert.throws(()=>saveMarketingPost(db,users.admin,input(),key,base,origin,post.id),e=>e.status===409);assert.throws(()=>scheduleMarketingTarget(db,users.admin,target.id,{publish_ack:true},key,base,origin),e=>e.status===409);
 }finally{db.close();}
});
test('each additional page publishes with its own credentials and stale scheduled permissions refresh automatically',async()=>{
 const {db,key,users,base,origin}=fixture();try{
  const saved=saveExtraAccount(db,users.admin,{channel:'facebook',account_id:'300',name:'Synthetic branch',intake_user:users.admin.id,accessToken:'synthetic-branch-token',appSecret:'synthetic-meta-secret',verifyToken:'synthetic-verify',version:'v26.0',appId:'555'},key,base);
  await verifyExtraAccount(db,users.admin,saved.id,key,origin,true,async(url,options={})=>({ok:true,json:async()=>options.method==='POST'?{success:true}:{id:'300'}}));
  const mock=provider();await syncMarketingAccount(db,users.admin,saved.id,key,base,origin,mock.transport);const post=saveMarketingPost(db,users.admin,input([saved.id]),key,base,origin),target=targetFor(db,post,saved.id);scheduleMarketingTarget(db,users.admin,target.id,{publish_ack:true},key,base,origin);
  db.prepare('UPDATE marketing_account_state SET checked_at=?').run(new Date(Date.now()-25*3600000).toISOString());await processMarketingJobs(db,key,base,origin,mock.transport);
  const sent=mock.calls.filter(c=>c.options.method==='POST');assert.equal(sent.length,1);assert.match(sent[0].url,/\/300\/feed$/);assert.equal(sent[0].options.headers.Authorization,'Bearer synthetic-branch-token');assert.equal(targetFor(db,post,saved.id).status,'published');
 }finally{db.close();}
});
test('Instagram media preparation persists the container before publication and expired windows never create duplicate sends',async()=>{
 const {db,key,users,base,origin}=fixture();let containers=0,publishes=0;const mock=provider(permissions,(url,options)=>{
  if(options.method==='POST'&&url.endsWith('/200/media')){containers++;assert.equal(new URLSearchParams(options.body).get('image_url'),'https://cdn.example.com/synthetic.jpg');return {ok:true,status:200,json:async()=>({id:'901'})};}
  if(url.includes('/901?'))return {ok:true,status:200,json:async()=>({status_code:'FINISHED'})};
  if(options.method==='POST'&&url.endsWith('/200/media_publish')){publishes++;assert.equal(new URLSearchParams(options.body).get('creation_id'),'901');return {ok:true,status:200,json:async()=>({id:'902'})};}
 });try{
  await syncMarketingAccount(db,users.admin,'primary-instagram',key,base,origin,mock.transport);const post=saveMarketingPost(db,users.admin,input(['primary-instagram'],{media_url:'https://cdn.example.com/synthetic.jpg'}),key,base,origin),target=targetFor(db,post,'primary-instagram');scheduleMarketingTarget(db,users.admin,target.id,{publish_ack:true},key,base,origin);
  await processMarketingJobs(db,key,base,origin,mock.transport);assert.equal(containers,1);assert.equal(publishes,0);assert.equal(targetFor(db,post,'primary-instagram').container_id,'901');assert.equal(targetFor(db,post,'primary-instagram').status,'processing');recoverMarketingJobs(db);
  db.prepare('UPDATE marketing_targets SET updated_at=? WHERE id=?').run(new Date(Date.now()-20000).toISOString(),target.id);await processMarketingJobs(db,key,base,origin,mock.transport);await processMarketingJobs(db,key,base,origin,mock.transport);assert.equal(publishes,1);assert.equal(containers,1);assert.equal(targetFor(db,post,'primary-instagram').status,'published');
 }finally{db.close();}
});
test('uncertain provider responses and process restarts never automatically repeat a public post',async()=>{
 const {db,key,users,base,origin}=fixture(),mock=provider(permissions,(url,options)=>{if(options.method==='POST')throw new Error('Synthetic network loss');});try{
  await syncMarketingAccount(db,users.admin,'primary-facebook',key,base,origin,mock.transport);const post=saveMarketingPost(db,users.admin,input(),key,base,origin),target=targetFor(db,post);scheduleMarketingTarget(db,users.admin,target.id,{publish_ack:true},key,base,origin);
  await processMarketingJobs(db,key,base,origin,mock.transport);assert.equal(targetFor(db,post).status,'unknown');await processMarketingJobs(db,key,base,origin,mock.transport);assert.equal(mock.calls.filter(c=>c.options.method==='POST').length,1);assert.throws(()=>scheduleMarketingTarget(db,users.admin,target.id,{publish_ack:true},key,base,origin),e=>e.status===409);
  db.prepare("UPDATE marketing_targets SET status='publishing' WHERE id=?").run(target.id);recoverMarketingJobs(db);assert.equal(targetFor(db,post).status,'unknown');
 }finally{db.close();}
});
test('Cairo scheduling handles summer/winter offsets and rejects invalid wall times and unsafe video or media URLs',()=>{
 assert.equal(cairoSchedule('2027-01-20T12:00'),'2027-01-20T10:00:00.000Z');assert.equal(cairoSchedule('2027-07-20T12:00'),'2027-07-20T09:00:00.000Z');assert.throws(()=>cairoSchedule('2027-02-30T12:00'),e=>e.status===400);
 assert.equal(embeddedVideo('youtube','https://youtu.be/M7lc1UVf-VE').embed_url,'https://www.youtube.com/embed/M7lc1UVf-VE?rel=0');assert.equal(embeddedVideo('tiktok','https://www.tiktok.com/@synthetic/video/6718335390845095173').embed_url,'https://www.tiktok.com/player/v1/6718335390845095173?autoplay=0&description=1');
 for(const url of ['javascript:alert(1)','https://evil.example/video/6718335390845095173','https://www.youtube.com/embed/not-an-id'])assert.throws(()=>embeddedVideo('youtube',url),e=>e.status===400);
 for(const url of ['http://cdn.example.com/image.jpg','https://127.0.0.1/image.jpg','https://internal/image.jpg','https://cdn.example.com/image?access_token=secret','https://user:secret@example.com/image.jpg'])assert.throws(()=>publicMarketingUrl(url),e=>e.status===400);
});
test('marketing assets are separate public images; private student files and marketing APIs remain authenticated',async()=>{
 const {db,key,users,base,origin}=fixture();try{
  const bytes=Buffer.from([255,216,255,224,1,2,3]);const asset=saveMarketingAsset(db,users.admin,{name:'synthetic.jpg',mime:'image/jpeg',content:bytes.toString('base64')},origin);assert.ok(asset.url.endsWith(asset.id));assert.equal(db.prepare('SELECT COUNT(*) n FROM attachments').get().n,0);
  assert.throws(()=>saveMarketingAsset(db,users.agent,{name:'x'},origin),e=>e.status===403);assert.throws(()=>saveMarketingAsset(db,users.admin,{name:'x.svg',mime:'image/svg+xml',content:Buffer.from('<svg/>').toString('base64')},origin),e=>e.status===400);
  const app=createApp({db,secretKey:key,env:{PUBLIC_ORIGIN:origin}});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const root='http://127.0.0.1:'+app.server.address().port;
  try{const image=await fetch(root+'/social-media/'+asset.id);assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/jpeg');assert.deepEqual(Buffer.from(await image.arrayBuffer()),bytes);assert.equal((await fetch(root+'/api/marketing')).status,401);assert.equal((await fetch(root+'/api/files/'+asset.id)).status,401);for(const path of ['/marketing.js','/marketing.css'])assert.equal((await fetch(root+path)).status,200);}finally{await new Promise(resolve=>app.server.close(resolve));}
 }finally{db.close();}
});
test('marketing frontend renders its real feed safely and contains internal accounts, planner and content controls',async()=>{
 const f=fixture(),{db,key,users,base,origin}=f;try{
  const mock=provider();await syncMarketingAccount(db,users.admin,'primary-facebook',key,base,origin,mock.transport);const data=structuredClone(uiFixture);data.marketing=marketingData(db,users.admin,key,base,origin);data.marketing.feed[0].body='<img src=x onerror=alert(1)>';const ui=await renderFixture(data),html=await ui.pageAsync('marketing');assert.match(html,/تقويم النشر/);assert.match(html,/مكتبة الصور/);assert.match(html,/المحتوى والصفحات/);assert.match(html,/&lt;img/);assert.ok(!html.includes('<img src=x'));assert.ok(!html.includes('undefined'));
 }finally{db.close();}
});
