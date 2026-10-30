import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../src/db.mjs';
import {uid,now} from '../src/service.mjs';
import {ensureOmniDefaults,saveChannel,channelConfig} from '../src/omni-config.mjs';
import {connectMetaAccounts} from '../src/meta-connect.mjs';

test('Meta connection exchanges tokens, verifies exact assets, registers signed hooks, and returns no secrets',async()=>{
  const db=openDatabase(':memory:'),key=Buffer.alloc(32,7),owner={id:uid(),role:'admin'},secret='synthetic-app-secret-012345678901';
  db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?)').run(owner.id,'Synthetic owner','owner@example.test','unused','admin',1,now());ensureOmniDefaults(db);
  for(const [channel,id] of [['facebook','900001'],['instagram','900002']])saveChannel(db,owner,channel,{account_id:id,version:'v26.0',intake_user:owner.id,appSecret:secret,verifyToken:'synthetic-verify-token'},key);
  const input={app_id:'900003',userToken:'synthetic-short-user-token-0123456789012345'};
  let calls=0,wrong=false,failInstagram=false;
  const transport=async(url,init)=>{
    calls++;assert.equal(init.redirect,'error');const parsed=new URL(url);assert.equal(parsed.origin,'https://graph.facebook.com');
    let body;
    if(parsed.pathname.endsWith('/oauth/access_token')){assert.equal(parsed.searchParams.get('client_secret'),secret);body={access_token:'synthetic-exchanged-token',expires_in:5184000};}
    else if(parsed.pathname.endsWith('/900001')&&parsed.searchParams.get('fields')?.includes('access_token'))body={id:'900001',name:'Synthetic page',access_token:'synthetic-page-token',instagram_business_account:{id:wrong?'900099':'900002',username:'synthetic_ig'}};
    else if(parsed.pathname.endsWith('/900002')&&init.method==='GET')body={id:'900002',username:'synthetic_ig'};
    else{
      const form=new URLSearchParams(init.body);
      if(parsed.pathname.endsWith('/subscriptions')){assert.equal(form.get('fields'),'messages');assert.match(form.get('callback_url'),/^https:\/\/crm\.example\.test\/webhooks\/(facebook|instagram)$/);assert.equal(form.get('verify_token'),'synthetic-verify-token');}
      if(failInstagram&&parsed.pathname.endsWith('/900002/subscribed_apps'))return new Response(JSON.stringify({error:{code:200,message:'Synthetic missing permission'}}),{status:403});
      body={success:true};
    }
    return new Response(JSON.stringify(body));
  };
  try{
    await assert.rejects(connectMetaAccounts(db,{...owner,role:'agent'},input,key,'https://crm.example.test',transport),e=>e.status===403);assert.equal(calls,0);
    const result=await connectMetaAccounts(db,owner,input,key,'https://crm.example.test',transport);assert.ok(result.channels.every(c=>c.webhook&&c.subscribed));
    assert.equal(result.exchanged_user_token_lifetime_seconds,5184000);assert.equal(result.secrets_returned,false);
    const exposed=JSON.stringify(result)+JSON.stringify(db.prepare('SELECT metadata FROM audit').all());assert.ok(!exposed.includes(input.userToken));assert.ok(!exposed.includes(secret));assert.ok(!exposed.includes('synthetic-page-token'));
    for(const channel of ['facebook','instagram']){const row=channelConfig(db,channel,key);assert.equal(row.active,1);assert.equal(row.accessToken,'synthetic-page-token');assert.ok(row.verified_at);}
    const saved=db.prepare("SELECT token_cipher FROM channel_accounts WHERE channel='facebook'").get().token_cipher;assert.notEqual(saved,'synthetic-page-token');
    wrong=true;await assert.rejects(connectMetaAccounts(db,owner,input,key,'https://crm.example.test',transport),e=>e.status===409);assert.equal(db.prepare("SELECT token_cipher FROM channel_accounts WHERE channel='facebook'").get().token_cipher,saved);
    wrong=false;failInstagram=true;const partial=await connectMetaAccounts(db,owner,input,key,'https://crm.example.test',transport);assert.equal(partial.channels[1].subscribed,false);assert.equal(channelConfig(db,'instagram',key).active,0);assert.equal(channelConfig(db,'facebook',key).active,1);
  }finally{db.close();}
});
