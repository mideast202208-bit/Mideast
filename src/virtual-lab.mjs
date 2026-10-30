import { createHmac } from 'node:crypto';
import { openDatabase } from './db.mjs';
import { uid,now } from './service.mjs';
import { ensureOmniDefaults,saveChannel } from './omni-config.mjs';
import { installEducationWorkspace } from './education.mjs';
import { createRegistration,processIntakeDelivery,receiptByToken } from './intake.mjs';
import { acceptSocialWebhook,processSocialEvents,sendSocialNext } from './social.mjs';
import { acceptWebhook,processWebhookQueue,sendNext } from './whatsapp.mjs';
import { validSignature } from './security.mjs';

export async function runVirtualLab(){
  const db=openDatabase(':memory:'),key=Buffer.alloc(32,17),owner={id:uid(),role:'admin'},checks=[],events=[];
  const check=(name,passed,detail)=>checks.push({name,passed:Boolean(passed),detail});
  let mockCalls=0;
  const transport=async url=>{mockCalls++;return {ok:true,json:async()=>url.includes('/1111/')?{messages:[{id:'simulated-wa-'+mockCalls}]}:{message_id:'simulated-social-'+mockCalls}};};
  try{
    db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?)').run(owner.id,'مالك افتراضي','lab@example.invalid','not-a-login','admin',1,now());
    ensureOmniDefaults(db);installEducationWorkspace(db,owner);
    const registration={name:'طالب التجربة الافتراضية',phone:'+201000000099',email:'student@example.invalid',certificate:'ثانوي سوداني',academic_year:'2026',nationality:'السودان',university:'جامعة تجريبية',faculty:'تخصص تجريبي',source:'facebook',campaign:'virtual-lab',consent:true,whatsapp_opt_in:true,request_key:'virtual-registration-0001'};
    const result=createRegistration(db,registration,key,'https://lab.invalid');
    events.push({step:'تسجيل من رابط فيسبوك',status:'simulated',detail:result.reference});
    const row=db.prepare('SELECT * FROM intake_registrations').get();
    check('إنشاء عميل وفرصة وملف طالب وطلب قبول ومهمة',db.prepare('SELECT COUNT(*) n FROM contacts').get().n===1&&db.prepare('SELECT COUNT(*) n FROM leads').get().n===1&&db.prepare('SELECT COUNT(*) n FROM app_records').get().n===3&&db.prepare('SELECT COUNT(*) n FROM tasks').get().n===1);
    const file=receiptByToken(db,result.receipt_url.split('/').at(-1));
    check('توليد ملف التسجيل التلقائي القابل للطباعة',file.content.length>100&&file.file_id===row.file_id,'ملف HTML حقيقي، ويمكن حفظه PDF بالطباعة');
    const again=createRegistration(db,registration,key,'https://lab.invalid');
    check('إعادة إرسال نفس الطلب لا تكرر العميل أو التسجيل',again.replayed&&db.prepare('SELECT COUNT(*) n FROM intake_registrations').get().n===1);
    await processIntakeDelivery(db,{},key,'https://lab.invalid');
    check('حجب الإرسال عند غياب ربط واتساب',db.prepare('SELECT delivery_reason FROM intake_registrations').get().delivery_reason==='WHATSAPP_NOT_CONFIGURED');
    const wa={phoneId:'1111',accessToken:'synthetic-only',appSecret:'synthetic-whatsapp-secret',verifyToken:'synthetic-verify-token',version:'v99.0',intakeUser:owner.id};
    db.prepare("UPDATE settings SET value=json_set(value,'$.welcome_template','lab_welcome') WHERE key='omni.intake'").run();
    db.prepare('INSERT INTO wa_templates VALUES(?,?,?,?,?,?,?)').run('lab-template','lab_welcome','ar','UTILITY','APPROVED',JSON.stringify([{type:'BODY',text:'أهلًا {{1}}، طلبك {{2}}. ملفك {{3}}'}]),now());
    db.prepare("UPDATE intake_registrations SET delivery_status='pending'").run();
    await processIntakeDelivery(db,wa,key,'https://lab.invalid');await sendNext(db,wa,transport);
    check('تجهيز قالب تأكيد مع رابط الملف وقبوله في المحاكاة',db.prepare("SELECT status FROM messages WHERE direction='out'").get()?.status==='accepted','الموافقة والتسليم هنا افتراضيان؛ لم تُرسل رسالة حقيقية');
    const inbound={object:'whatsapp_business_account',entry:[{changes:[{value:{metadata:{phone_number_id:'1111'},contacts:[{wa_id:'201000000099',profile:{name:'اسم افتراضي'}}],messages:[{id:'lab-inbound-1',from:'201000000099',timestamp:String(Math.floor(Date.now()/1000)),type:'text',text:{body:'عايز أتابع الطلب'}}]}}]}]};
    acceptWebhook(db,Buffer.from(JSON.stringify(inbound)));processWebhookQueue(db,wa);
    check('رسالة واتساب ترتبط بالرقم الموجود دون عميل جديد',db.prepare('SELECT COUNT(*) n FROM contacts').get().n===1&&db.prepare("SELECT COUNT(*) n FROM messages WHERE direction='in'").get().n===1);
    for(const [channel,id,sender] of [['facebook','2222','4444'],['instagram','3333','5555']]){
      saveChannel(db,owner,channel,{account_id:id,version:'v99.0',intake_user:owner.id,accessToken:'synthetic-channel-token',appSecret:'synthetic-channel-secret',verifyToken:'synthetic-verify-token',active:true},key);
      db.prepare('UPDATE channel_accounts SET verified_at=? WHERE channel=?').run(now(),channel);
      const payload={object:channel==='facebook'?'page':'instagram',entry:[{id,messaging:[{sender:{id:sender},recipient:{id},timestamp:Date.now(),message:{mid:'lab-'+channel,text:'أريد الدراسة في مصر'}}]}]};
      const raw=Buffer.from(JSON.stringify(payload)),signature='sha256='+createHmac('sha256','synthetic-channel-secret').update(raw).digest('hex');
      acceptSocialWebhook(db,channel,raw,signature,key);acceptSocialWebhook(db,channel,raw,signature,key);
      processSocialEvents(db,key,'https://lab.invalid');await sendSocialNext(db,key,transport);
      check('استقبال '+(channel==='facebook'?'فيسبوك':'إنستجرام')+' ورد آلي بلا تكرار',db.prepare('SELECT COUNT(*) n FROM social_threads WHERE channel=?').get(channel).n===1&&db.prepare("SELECT COUNT(*) n FROM social_messages m JOIN social_threads t ON t.id=m.thread_id WHERE t.channel=? AND m.direction='out' AND m.status='accepted'").get(channel).n===1);
      events.push({step:channel==='facebook'?'فيسبوك ← CRM ← ترحيب':'إنستجرام ← CRM ← ترحيب',status:'simulated',detail:'عميل وفرصة ومحادثة في قاعدة معزولة'});
    }
    check('رفض توقيع webhook المزور',!validSignature(Buffer.from('{}'),'sha256=bad','synthetic-channel-secret'));
    check('بقاء بيانات التجربة داخل قاعدة معزولة',db.prepare('PRAGMA database_list').all()[0].file==='');
    events.push({step:'تأكيد التسجيل على واتساب',status:'simulated',detail:'القالب ورابط الملف جُرّبا بناقل محلي وهمي'});
    return {mode:'simulation',passed:checks.every(c=>c.passed),checks,events,counts:{contacts:db.prepare('SELECT COUNT(*) n FROM contacts').get().n,leads:db.prepare('SELECT COUNT(*) n FROM leads').get().n,registrations:1,files:db.prepare('SELECT COUNT(*) n FROM attachments').get().n},external_network_calls:0,mock_transport_calls:mockCalls,live_channels_verified:false,checked_at:now()};
  }finally{db.close();}
}
