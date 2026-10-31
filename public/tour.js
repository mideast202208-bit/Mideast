import {createMarketing} from './marketing.js';
import {createWorkspace} from './workspace.js';
import {documentTypes} from './documents.js';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date='2026-10-31T10:00:00Z',key='whatsapp:demo-conversation:1000';
const accounts=[
 {id:'demo-facebook',channel:'facebook',name:'مثال — الصفحة الرئيسية',account_id:'demo-fb',state:'receiving',mode:'messaging',active:true,primary:true},
 {id:'demo-instagram',channel:'instagram',name:'مثال — إنستجرام الشركة',account_id:'demo-ig',state:'verified',mode:'messaging',active:true,primary:true},
 {id:'demo-tiktok',channel:'tiktok',name:'مثال — قناة تيك توك',account_id:'demo-tt',state:'profile_link',mode:'profile',profile_url:'https://www.tiktok.com/'},
 {id:'demo-youtube',channel:'youtube',name:'مثال — قناة يوتيوب',account_id:'demo-yt',state:'profile_link',mode:'profile',profile_url:'https://www.youtube.com/'},
 {id:'demo-whatsapp',channel:'whatsapp',name:'مثال — واتساب الرئيسي',account_id:'1000',state:'receiving',mode:'messaging',active:true,primary:true},
 {id:'demo-whatsapp-branch',channel:'whatsapp',name:'مثال — واتساب الفرع',account_id:'2000',state:'needs_setup',mode:'messaging',active:false}
];
const students=[{id:'demo-student-1',name:'طالب توضيحي — أحمد',reference:'ME-DEMO-2026-001',phone:'+201000000000',nationality:'السودان',contact_id:'demo-contact'},
 {id:'demo-student-2',name:'طالبة توضيحية — سارة',reference:'ME-DEMO-2026-002',phone:'+201000000000',nationality:'السودان',contact_id:'demo-contact'}];
let selected=students[0].id,tourView=new URLSearchParams(location.search).get('view')==='communications'?'communications':'marketing';
function dossier(){const student=students.find(s=>s.id===selected);return {...student,documents:[{id:'demo-doc-1',name:'صورة جواز السفر.pdf',document_type:documentTypes.passport,attachment_id:'demo-passport'}, {id:'demo-doc-2',name:'الشهادة الدراسية.pdf',document_type:documentTypes.certificate,attachment_id:'demo-certificate'}],checklist:Object.entries(documentTypes).filter(([k])=>k!=='other').map(([k,label])=>({key:k,label,count:['passport','certificate'].includes(k)?1:0}))};}
const comm={accounts,threads:[{key,thread_id:'demo-conversation',kind:'whatsapp',channel:'whatsapp',account_id:'1000',account_name:accounts[4].name,contact_id:'demo-contact',name:'ولي أمر توضيحي — طالبان',phone:students[0].phone,student_names:students.map(s=>s.name).join(' '),file_references:students.map(s=>s.reference).join(' '),last_at:date,preview:'أرسلت صورة الجواز، ما المستندات المتبقية؟',unread:1,status:'open'}],totals:{all:1,unread:1,open:1}};
const messages=[{id:'demo-in',direction:'in',body:'السلام عليكم. أرسلت صورة الجواز، ما المستندات المتبقية؟',status:'received',created_at:date},{id:'demo-out',direction:'out',body:'بخصوص ملف ME-DEMO-2026-001 — أحمد\nوصلت صورة الجواز والشهادة. نحتاج شهادة الميلاد وكشف الدرجات لاستكمال المراجعة.',status:'read',created_at:date,student_reference:'ME-DEMO-2026-001'}];
const marketingFixture={plans:[{id:'demo-plan',name:'مثال — حضور مستمر لميدل إيست',state:'active',local_time:'20:00',weekdays:[0,1,2,3,4,5,6],accounts:['demo-facebook','demo-instagram'],templates:['demo-post'],repeat:true,queued:14,published:0,issues:0,next_at:'2026-11-01T18:00:00Z'}],accounts:accounts.filter(a=>a.channel!=='whatsapp').map(a=>({...a,marketing:{can_read:a.mode==='messaging',can_publish:a.mode==='messaging',checked_at:date,error_code:null}})),posts:[{id:'demo-post',title:'حملة توضيحية — الدراسة في مصر',body:'نبدأ رحلتك للدراسة في مصر بخطوة واضحة. جهّز مستنداتك وتابع ملفك مع Middle East.',campaign:'demo-admissions-2026',asset_url:'',asset_id:null,media_url:'',link_url:'',include_registration:1,tracking_url:'رابط التسجيل التوضيحي',registrations:0,targets:[{id:'demo-target-fb',account_key:'demo-facebook',channel:'facebook',status:'draft',scheduled_at:null},{id:'demo-target-ig',account_key:'demo-instagram',channel:'instagram',status:'draft',scheduled_at:null}]}],assets:[],feed:[{account_key:'demo-facebook',provider_id:'demo-feed-1',body:'نساعدك تختار الجامعة، تجهّز أوراقك، وتعرف الخطوة التالية في ملفك.\n\nمنشور توضيحي لعرض شكل محتوى الصفحات داخل المنصة.',media_url:'',permalink:'',published_at:date}],videos:[],totals:{drafts:1,scheduled:0,published:0,registrations:0}};
const toast=message=>{const target=document.querySelector('#tour-toast');target.textContent=message;target.hidden=false;setTimeout(()=>{target.hidden=true;},3500);};
async function api(path,method='GET',body){
 if(path==='/marketing')return marketingFixture;
 if(path==='/communication')return comm;
 if(path.endsWith('/students')&&method==='POST'){selected=body.student_id;return {students,selected:dossier(),requires_choice:false};}
 if(path.endsWith('/students'))return {students,selected:dossier(),requires_choice:false};
 if(path.endsWith('/messages')&&method==='GET')return messages;
 if(path.endsWith('/state'))return {ok:true};
 if(path==='/communication/students/search')return students.filter(s=>(s.name+' '+s.reference+' '+s.phone).toLowerCase().includes(body.query.toLowerCase()));
 throw new Error('هذا عرض توضيحي فقط. الإرسال وإدارة الحسابات متاحان بعد دخول النظام الحقيقي.');
}
const render=()=>{document.querySelector('#tour-app').innerHTML=tourView==='marketing'?marketing.view():workspace.view('communications');};
function tourModal(title,body,label='حفظ'){
 const dialog=document.querySelector('#modal');dialog.innerHTML='<div class="modalhead"><h2>'+title+'</h2><button type="button" data-tour-close class="close">×</button></div><div class="modalbody"><form id="tour-editor">'+body+'<div class="modalfoot"><button class="btn primary" type="submit">'+label+'</button><button class="btn" type="button" data-tour-close>إغلاق</button></div></form></div>';dialog.showModal();return dialog.querySelector('form');
}
const context={api,escape,toast,render,getUser:()=>({role:'admin'}),getData:()=>({users:[],templates:[]}),getPage:()=>null,getSearch:()=>'',navigate:async()=>toast('افتح النظام الحقيقي لإدارة الإعدادات.'),modal:tourModal,bindForm:form=>form.addEventListener('submit',event=>{event.preventDefault();toast('هذه معاينة فقط. الحفظ والنشر الفعليان متاحان داخل حساب الشركة.');})};
const workspace=createWorkspace(context),marketing=createMarketing({...context,initialTab:new URLSearchParams(location.search).get('view')==='publishing'?'plans':'streams'});
document.addEventListener('click',async event=>{
 if(event.target.closest('[data-tour-close]')){document.querySelector('#modal').close();return;}
 if(event.target.closest('[data-tour-marketing]')){tourView='marketing';render();return;}
 const file=event.target.closest('a[href^="/api/files/"]');if(file){event.preventDefault();toast('مستند توضيحي؛ لا توجد ملفات عملاء في العرض.');return;}
 const button=event.target.closest('[data-action]');if(!button)return;
 if(button.dataset.action.startsWith('marketing-')){tourView='marketing';if(['marketing-sync','marketing-refresh'].includes(button.dataset.action)){toast('حالة الحسابات هنا توضيحية. الاختبار الحقيقي من حساب الشركة.');return;}try{await marketing.action(button.dataset.action,button.dataset.id||'');}catch(error){toast(error.message);}return;}
 const allowed=['workspace-tab','workspace-thread','workspace-channel','workspace-account-inbox','workspace-refresh'];
 if(!allowed.includes(button.dataset.action)){toast('هذا عرض توضيحي. إدارة الحسابات والملفات متاحة بعد دخول النظام الحقيقي.');return;}
 tourView='communications';try{await workspace.action(button.dataset.action,button.dataset.id||'');}catch(error){toast(error.message);}
});
await workspace.load('communications');await workspace.action('workspace-thread',key);await marketing.load();render();
