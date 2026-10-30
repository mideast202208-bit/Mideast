import {transaction} from './db.mjs';
import {fail,audit,now} from './service.mjs';
import {channelConfig,saveChannel} from './omni-config.mjs';

export async function connectMetaAccounts(db,user,input,key,origin,transport=fetch){
  if(user.role!=='admin')fail(403,'ربط Meta للمالك فقط');
  if(!/^\d{5,25}$/.test(input.app_id||'')||typeof input.userToken!=='string'||input.userToken.length<30||input.userToken.length>4096)fail(400,'بيانات تفويض Meta غير صالحة');
  const configs=Object.fromEntries(['facebook','instagram'].map(c=>[c,channelConfig(db,c,key)]));
  const version=configs.facebook.version,secret=configs.facebook.appSecret;
  if(!/^v\d+\.\d+$/.test(version)||!secret||Object.values(configs).some(c=>!c?.account_id||!c.verifyToken||c.appSecret!==secret||!c.intake_user))fail(409,'أكمل معرفات الحسابات وسر التطبيق وموظف الاستقبال أولًا');
  const request=async(path,token,fields)=>{
    const response=await transport('https://graph.facebook.com/'+version+'/'+path,{method:fields?'POST':'GET',headers:{Authorization:'Bearer '+token,...(fields?{'Content-Type':'application/x-www-form-urlencoded'}:{})},...(fields?{body:new URLSearchParams(fields).toString()}:{}),redirect:'error',signal:AbortSignal.timeout(25000)});
    const value=await response.json();
    if(!response.ok||value.error){
      const err=new Error('Meta rejected request');err.http=response.status;err.code=value.error?.code;
      err.safeMessage=String(value.error?.message||'Meta request failed').replaceAll(secret,'[REDACTED]').replace(/EA[A-Za-z0-9_-]{30,}/g,'[REDACTED]').replace(/[a-fA-F0-9]{32,}/g,'[REDACTED]').slice(0,400);throw err;
    }
    return value;
  };
  let oauth,page;
  try{
    const query=new URLSearchParams({grant_type:'fb_exchange_token',client_id:input.app_id,client_secret:secret,fb_exchange_token:input.userToken});
    oauth=await request('oauth/access_token?'+query.toString(),input.userToken);
    if(typeof oauth.access_token!=='string')throw new Error('Missing exchanged token');
    page=await request(configs.facebook.account_id+'?fields=id,name,access_token,instagram_business_account{id,username}',oauth.access_token);
    if(String(page.id)!==configs.facebook.account_id||!page.access_token||String(page.instagram_business_account?.id)!==configs.instagram.account_id)fail(409,'الحسابات المفوضة لا تطابق صفحة Middle East وحساب إنستجرام المحددين');
    const instagram=await request(configs.instagram.account_id+'?fields=id,username',page.access_token);
    if(String(instagram.id)!==configs.instagram.account_id)fail(409,'تعذر مطابقة هوية إنستجرام');
  }catch(error){if(error.status)throw error;fail(502,'تعذر تجديد التفويض أو مطابقة الحسابات: '+(error.safeMessage||'META_IDENTITY_FAILED'));}
  transaction(db,()=>{for(const channel of ['facebook','instagram']){
    saveChannel(db,user,channel,{accessToken:page.access_token,active:true},key);
    db.prepare('UPDATE channel_accounts SET verified_at=? WHERE channel=?').run(now(),channel);
  }});
  const results=[];
  for(const channel of ['facebook','instagram']){
    let webhook=false,subscribed=false,error;
    try{
      const result=await request(input.app_id+'/subscriptions',input.app_id+'|'+secret,{object:channel==='facebook'?'page':'instagram',fields:'messages',callback_url:origin+'/webhooks/'+channel,verify_token:configs[channel].verifyToken});
      if(result.success!==true)throw new Error('Subscription not confirmed');webhook=true;
      const account=await request(configs[channel].account_id+'/subscribed_apps',page.access_token,{subscribed_fields:'messages'});
      if(account.success!==true)throw new Error('Account subscription not confirmed');subscribed=true;
    }catch(e){error={http:e.http||null,code:e.code||null,message:e.safeMessage||'META_SUBSCRIPTION_NOT_CONFIRMED'};db.prepare('UPDATE channel_accounts SET active=0 WHERE channel=?').run(channel);}
    results.push({channel,identity_verified:true,webhook,subscribed,...(error?{error}:{})});
  }
  audit(db,user,'connected','meta',input.app_id,{results:results.map(r=>({channel:r.channel,subscribed:r.subscribed,error_code:r.error?.code||null}))});
  return {page:{id:page.id,name:page.name},instagram:page.instagram_business_account,channels:results,exchanged_user_token_lifetime_seconds:oauth.expires_in||null,secrets_returned:false};
}
