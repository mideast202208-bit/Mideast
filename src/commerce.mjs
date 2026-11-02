import {createHash,timingSafeEqual} from 'node:crypto';
import {transaction} from './db.mjs';
import {encryptSecret,decryptSecret} from './integration-settings.mjs';
import {internationalPhone} from './international.mjs';
import {fail,now,audit} from './service.mjs';

export const RIWAQ_STORE='Store_cmvy9cgt601fk01jre9un4st8';
const digest=value=>createHash('sha256').update(value).digest('hex');
const allowed=new Set(['ORDER_PLACED','ORDER_UPDATED','ORDER_CANCELED','SHIPMENT_UPDATED']);
const stages={OrderShipmentPickedUp:'shipped',OrderShipmentIsOnTheWay:'shipped',OrderShipmentDelivered:'delivered',OrderShipmentReturnedToSeller:'returned',OrderShipmentActionRequired:'action_required'};
const stamp=value=>{const n=Date.parse(value);if(!Number.isFinite(n))fail(400,'INVALID_EVENT_TIMESTAMP');return n;};
const clean=(value,max=200)=>String(value??'').slice(0,max);
const unpack=(row,key)=>row?JSON.parse(decryptSecret(row.snapshot_cipher,key)):{};
export function ensureCommerceSchema(db){
 db.exec(`CREATE TABLE IF NOT EXISTS commerce_customers(store_id TEXT NOT NULL,customer_key TEXT NOT NULL,profile_cipher TEXT NOT NULL,PRIMARY KEY(store_id,customer_key));
 CREATE TABLE IF NOT EXISTS commerce_orders(store_id TEXT NOT NULL,order_id TEXT NOT NULL,serial TEXT NOT NULL DEFAULT '',customer_key TEXT NOT NULL DEFAULT '',snapshot_cipher TEXT NOT NULL,order_at INTEGER NOT NULL DEFAULT 0,shipment_at INTEGER NOT NULL DEFAULT 0,canceled INTEGER NOT NULL DEFAULT 0,shipping_stage TEXT NOT NULL DEFAULT 'pending',updated_at TEXT NOT NULL,PRIMARY KEY(store_id,order_id));
 CREATE TABLE IF NOT EXISTS commerce_events(digest TEXT PRIMARY KEY,store_id TEXT NOT NULL,order_id TEXT NOT NULL,event TEXT NOT NULL,event_at INTEGER NOT NULL,received_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS commerce_outbox(store_id TEXT NOT NULL,order_id TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',provider_id TEXT,error_code TEXT,created_at TEXT NOT NULL,PRIMARY KEY(store_id,order_id,kind));
 CREATE TABLE IF NOT EXISTS commerce_consents(store_id TEXT NOT NULL,phone_hash TEXT NOT NULL,granted INTEGER NOT NULL,evidence_cipher TEXT NOT NULL,recorded_by TEXT NOT NULL,recorded_at TEXT NOT NULL,PRIMARY KEY(store_id,phone_hash));
 CREATE INDEX IF NOT EXISTS commerce_order_updated ON commerce_orders(updated_at);`);
 // A request interrupted after dispatch may already have reached Meta. Never resend it automatically.
 db.prepare("UPDATE commerce_outbox SET status='unknown',error_code='RESTART_DURING_SEND' WHERE status='sending'").run();
}
export function commerceReadiness(env){
 return {store_id:RIWAQ_STORE,webhook_enabled:env.RIWAQ_WUILT_ENABLED==='1'&&/^[a-f0-9]{64}$/.test(env.RIWAQ_WUILT_WEBHOOK_TOKEN||''),
  whatsapp_enabled:env.RIWAQ_WHATSAPP_ENABLED==='1',whatsapp_configured:Boolean(/^\d+$/.test(env.RIWAQ_WHATSAPP_PHONE_ID||'')&&env.RIWAQ_WHATSAPP_ACCESS_TOKEN&&/^v\d+\.\d+$/.test(env.RIWAQ_WHATSAPP_VERSION||'')&&env.RIWAQ_WHATSAPP_TEMPLATES_APPROVED==='1'&&['ORDER','SHIPPED'].every(k=>/^[a-z0-9_]+$/.test(env['RIWAQ_WHATSAPP_TEMPLATE_'+k]||''))),
  consent_required:true,source:'wuilt',outbound_identity:'dedicated_riwaq_only'};
}
export function ingestCommerce(db,key,env,raw){
 let input;try{input=JSON.parse(raw);}catch{fail(400,'INVALID_JSON');}
 if(!input||typeof input!=='object'||Array.isArray(input)||!allowed.has(input.event))fail(400,'UNSUPPORTED_WUILT_EVENT');
 if(input.metadata?.storeId!==RIWAQ_STORE)fail(403,'WRONG_STORE');
 const order=input.payload?.order;
 if(!order||order.storeId!==RIWAQ_STORE)fail(403,'WRONG_STORE');
 const shipment=input.event==='SHIPMENT_UPDATED',id=clean(shipment?order.orderId:order._id,160);
 if(!id)fail(400,'MISSING_ORDER_ID');
 const eventAt=stamp(input.metadata.timestamp),orderAt=shipment?eventAt:stamp(order.updatedAt||order.createdAt||input.metadata.timestamp);
 if(eventAt>Date.now()+300000||orderAt>Date.now()+300000)fail(400,'FUTURE_EVENT');
 const eventDigest=digest(raw);
 return transaction(db,()=>{
  if(db.prepare('SELECT 1 FROM commerce_events WHERE digest=?').get(eventDigest))return {received:true,replayed:true};
  let row=db.prepare('SELECT * FROM commerce_orders WHERE store_id=? AND order_id=?').get(RIWAQ_STORE,id),snapshot=unpack(row,key);
  let orderTime=row?.order_at||0,shipTime=row?.shipment_at||0,canceled=row?.canceled||0,stage=row?.shipping_stage||'pending',customerKey=row?.customer_key||'';
  if(shipment&&eventAt>shipTime){
   if(!Array.isArray(input.payload.events))fail(400,'INVALID_SHIPMENT_EVENTS');
   const known=input.payload.events.map(e=>stages[e]).filter(Boolean);
   if(known.length&&!(stage==='returned'||stage==='delivered'&&!known.includes('returned'))){stage=known.includes('returned')?'returned':known.includes('delivered')?'delivered':known.at(-1);snapshot.shipment={tracking_number:clean(order.trackingNumber),company_name:clean(order.companyName)};shipTime=eventAt;}
  }else if(!shipment&&orderAt>orderTime){
   if(!Array.isArray(order.items)||order.items.length>500)fail(400,'INVALID_ORDER_ITEMS');
   let phone='';try{phone=internationalPhone(order.customer?.phone||order.shippingAddress?.phone,order.shippingAddress?.countryCode2||'EG');}catch{}
   const profile={name:clean(order.customer?.name),phone,email:clean(order.customer?.email,254)};
   customerKey=clean(order.customerId,160)||(phone?digest(phone):'order:'+id);
   db.prepare('INSERT INTO commerce_customers VALUES(?,?,?) ON CONFLICT(store_id,customer_key) DO UPDATE SET profile_cipher=excluded.profile_cipher').run(RIWAQ_STORE,customerKey,encryptSecret(JSON.stringify(profile),key));
   snapshot={...snapshot,customer:profile,shipping_address:order.shippingAddress||{},items:order.items.map(p=>({id:clean(p.productId,160),title:clean(p.title),sku:clean(p.variantSnapshot?.sku),quantity:p.quantity,price:p.price})),total:order.totalPrice,payment_status:clean(order.paymentStatus),payment_method:clean(order.paymentMethod)};
   orderTime=orderAt;canceled=Boolean(canceled||order.isCanceled||input.event==='ORDER_CANCELED')?1:0;
  }
  // Cancellation is terminal even if a late cancellation notification has an older snapshot.
  if(input.event==='ORDER_CANCELED')canceled=1;
  db.prepare(`INSERT INTO commerce_orders VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(store_id,order_id) DO UPDATE SET serial=excluded.serial,customer_key=excluded.customer_key,snapshot_cipher=excluded.snapshot_cipher,order_at=excluded.order_at,shipment_at=excluded.shipment_at,canceled=excluded.canceled,shipping_stage=excluded.shipping_stage,updated_at=excluded.updated_at`).run(RIWAQ_STORE,id,clean(order.orderSerial||row?.serial,100),customerKey,encryptSecret(JSON.stringify(snapshot),key),orderTime,shipTime,canceled,stage,now());
  db.prepare('INSERT INTO commerce_events VALUES(?,?,?,?,?,?)').run(eventDigest,RIWAQ_STORE,id,input.event,eventAt,now());
  const enqueue=kind=>db.prepare('INSERT OR IGNORE INTO commerce_outbox(store_id,order_id,kind,created_at) VALUES(?,?,?,?)').run(RIWAQ_STORE,id,kind,now());
  if(input.event==='ORDER_PLACED')enqueue('order');
  if(stage==='shipped')enqueue('shipped');
  if(canceled||['returned','delivered'].includes(stage))db.prepare("UPDATE commerce_outbox SET status='suppressed',error_code=? WHERE store_id=? AND order_id=? AND status='pending'").run(canceled?'ORDER_CANCELED':'SHIPMENT_ALREADY_FINAL',RIWAQ_STORE,id);
  return {received:true,replayed:false};
 });
}
export async function handleCommercePublic({db,path,method,req,res,env,secretKey,rawBody,sendJson,rateLimit}){
 if(!path.startsWith('/webhooks/wuilt/'))return false;
 if(method!=='POST')fail(405,'METHOD_NOT_ALLOWED');
 rateLimit('wuilt:'+req.socket.remoteAddress,180,60000);
 const supplied=path.slice('/webhooks/wuilt/'.length),expected=env.RIWAQ_WUILT_WEBHOOK_TOKEN||'';
 if(!commerceReadiness(env).webhook_enabled||!timingSafeEqual(Buffer.from(digest(supplied)),Buffer.from(digest(expected))))fail(403,'WEBHOOK_DISABLED_OR_UNAUTHORIZED');
 if(!String(req.headers['content-type']||'').startsWith('application/json'))fail(415,'USE_JSON');
 const result=ingestCommerce(db,secretKey,env,await rawBody(req,2*1024*1024));sendJson(res,200,result);return true;
}
export async function handleCommerce({db,user,path,method,req,res,jsonBody,sendJson,secretKey,env}){
 if(!path.startsWith('/api/commerce'))return false;
 if(user.role!=='admin')fail(403,'طلبات المتجر متاحة للمالك فقط');
 if(path==='/api/commerce'&&method==='GET'){
  const orders=db.prepare('SELECT * FROM commerce_orders WHERE store_id=? ORDER BY updated_at DESC LIMIT 200').all(RIWAQ_STORE).map(row=>({order_id:row.order_id,serial:row.serial,canceled:!!row.canceled,shipping_stage:row.shipping_stage,updated_at:row.updated_at,...unpack(row,secretKey)}));
  sendJson(res,200,{readiness:commerceReadiness(env),orders,outbox:db.prepare('SELECT * FROM commerce_outbox WHERE store_id=? ORDER BY created_at DESC LIMIT 200').all(RIWAQ_STORE)});return true;
 }
 if(path==='/api/commerce/consent'&&method==='POST'){
  const input=await jsonBody(req),phone=internationalPhone(input.phone,input.country||'EG');
  if(typeof input.granted!=='boolean'||typeof input.evidence!=='string'||input.evidence.trim().length<10||input.evidence.length>2000)fail(400,'يلزم توثيق موافقة العميل أو سحبها');
  const exists=db.prepare('SELECT profile_cipher FROM commerce_customers WHERE store_id=?').all(RIWAQ_STORE).some(row=>JSON.parse(decryptSecret(row.profile_cipher,secretKey)).phone===phone);
  if(!exists)fail(404,'العميل غير مسجل في متجر رِواق');
  db.prepare('INSERT INTO commerce_consents VALUES(?,?,?,?,?,?) ON CONFLICT(store_id,phone_hash) DO UPDATE SET granted=excluded.granted,evidence_cipher=excluded.evidence_cipher,recorded_by=excluded.recorded_by,recorded_at=excluded.recorded_at').run(RIWAQ_STORE,digest(phone),Number(input.granted),encryptSecret(input.evidence.trim(),secretKey),user.id,now());
  audit(db,user,'consent_recorded','commerce',RIWAQ_STORE,{granted:input.granted});sendJson(res,200,{ok:true});return true;
 }
 fail(404,'المسار غير موجود');
}
export async function sendCommerceNext(db,key,env,transport=fetch){
 const ready=commerceReadiness(env);if(env.RECOVERY_MODE==='1'||!ready.whatsapp_enabled||!ready.whatsapp_configured)return {blocked:'WHATSAPP_NOT_CONFIGURED'};
 const jobs=db.prepare("SELECT * FROM commerce_outbox WHERE status='pending' AND store_id=? ORDER BY created_at LIMIT 100").all(RIWAQ_STORE);
 for(const job of jobs){
  const row=db.prepare('SELECT * FROM commerce_orders WHERE store_id=? AND order_id=?').get(RIWAQ_STORE,job.order_id),s=unpack(row,key),phone=s.customer?.phone;
  if(!row||row.canceled||job.kind==='shipped'&&row.shipping_stage!=='shipped'){db.prepare("UPDATE commerce_outbox SET status='suppressed',error_code='ORDER_STATE_CHANGED' WHERE store_id=? AND order_id=? AND kind=?").run(RIWAQ_STORE,job.order_id,job.kind);continue;}
  if(!phone||!db.prepare('SELECT 1 FROM commerce_consents WHERE store_id=? AND phone_hash=? AND granted=1').get(RIWAQ_STORE,digest(phone))){db.prepare("UPDATE commerce_outbox SET error_code='CUSTOMER_OPT_IN_REQUIRED' WHERE store_id=? AND order_id=? AND kind=?").run(RIWAQ_STORE,job.order_id,job.kind);continue;}
  const values=job.kind==='order'?[row.serial||row.order_id,clean(s.total?.amount)+' '+clean(s.total?.currencyCode)]:[row.serial||row.order_id,s.shipment?.tracking_number||'غير متاح',s.shipment?.company_name||'شركة الشحن'];
  const claim=db.prepare("UPDATE commerce_outbox SET status='sending',error_code=NULL WHERE store_id=? AND order_id=? AND kind=? AND status='pending'").run(RIWAQ_STORE,job.order_id,job.kind);if(!claim.changes)continue;
  let status='unknown',provider=null,error='AMBIGUOUS_PROVIDER_RESULT';
  try{
   const response=await transport(`https://graph.facebook.com/${env.RIWAQ_WHATSAPP_VERSION}/${env.RIWAQ_WHATSAPP_PHONE_ID}/messages`,{method:'POST',headers:{Authorization:'Bearer '+env.RIWAQ_WHATSAPP_ACCESS_TOKEN,'Content-Type':'application/json'},redirect:'error',signal:AbortSignal.timeout(15000),body:JSON.stringify({messaging_product:'whatsapp',to:phone,type:'template',template:{name:env['RIWAQ_WHATSAPP_TEMPLATE_'+(job.kind==='order'?'ORDER':'SHIPPED')],language:{code:env.RIWAQ_WHATSAPP_LANGUAGE||'ar'},components:[{type:'body',parameters:values.map(text=>({type:'text',text}))}]}})});
   const result=await response.json();if(response.ok&&typeof result.messages?.[0]?.id==='string'){status='accepted';provider=result.messages[0].id;error=null;}else if(response.status>=400&&response.status<500){status='failed';error='META_REJECTED';}
  }catch{}
  db.prepare('UPDATE commerce_outbox SET status=?,provider_id=?,error_code=? WHERE store_id=? AND order_id=? AND kind=?').run(status,provider,error,RIWAQ_STORE,job.order_id,job.kind);
  return {status};
 }
 return {blocked:'NO_ELIGIBLE_MESSAGES'};
}
