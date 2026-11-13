import {cairoDay} from './chat-ui.js';
import {createCustomerAgent} from './customer-agent.js';
import {createStudentRecords,filterRecordsBySearch,sectionSearch,updateSectionSearch} from './student-records.js';
import {createRecordViews} from './record-views.js';
import {createMarketing} from './marketing.js';
import {createWorkspace} from './workspace.js';
import {brandIcon} from './brand-icons.js';
import {createRecordMessenger} from './record-messenger.js';
import {customerChannelButtons,customerTimeline,customerMailHistory} from './customer-panel.js';
let customerWorkspaceState=null;
import {countries} from './countries.js';
const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, x => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
const date = value => value ? new Date(value).toLocaleDateString('ar-EG',{month:'short',day:'numeric'}) : 'بدون موعد';
const money = (value,currency='EGP') => new Intl.NumberFormat('ar-EG',{style:'currency',currency}).format((value || 0)/100);
let stages = {new:'جديد',contacted:'تم التواصل',qualified:'مؤهل',proposal:'عرض سعر',won:'تم التعاقد',lost:'لم يكتمل'};
const roles = {admin:'مالك النظام',manager:'مدير',agent:'خدمة العملاء',accountant:'محاسب'};
const triggers = {'contact.created':'عند إضافة عميل','lead.created':'عند إضافة فرصة','lead.stage_changed':'عند تغيير مرحلة الفرصة','whatsapp.received':'عند وصول رسالة واتساب','ticket.created':'عند فتح تذكرة'};
const statusLabels = {queued:'في الطابور',accepted:'قبلتها Meta',sent:'أُرسلت',delivered:'تم التسليم',read:'مقروءة',received:'واردة',unknown:'نتيجة غير مؤكدة',failed:'تعذر الإرسال'};
let user, csrf, data, page='dashboard', search='', selectedConversation=null, chatMessages=[], integration=null;
let refreshTimer, refreshing=false, crmInbox=null, crmUnread=0, crmRevision='', refreshCrmPending=false;
let navigationOpen=false, serviceTab='new', serviceOrder='newest', datedInbox=null;
const defaultRecordDates={contacts:'today',leads:'',tickets:''};
const recordDates={...defaultRecordDates};
let hubState=null,selectedSocial=null,socialMessages=[];
let studioEntity='contact',factorState=null,dragField=null;
const workspace=createWorkspace({api,escape,modal,bindForm,toast,render,getUser:()=>user,getData:()=>data,getPage:()=>page,getSearch:()=>search,navigate:async target=>{page=target;search='';await load();}});
const marketing=createMarketing({api,escape,modal,bindForm,toast,render,getUser:()=>user,getData:()=>data,getPage:()=>page,getSearch:()=>search,navigate:async target=>{page=target;search='';await load();}});
const recordMessenger=createRecordMessenger({api,getUser:()=>user,toast,getTemplates:()=>data?.templates||[],onUpdate:async id=>{const area=$('[data-agent-contact]');if(area)customerAgent.mount(area,id).catch(()=>{});const w=await api('/contacts/'+id+'/workspace');const timeline=$('#customer-timeline-panel');if(timeline)timeline.innerHTML='<div class="actions"><button type="button" class="linkbutton" data-action="customer-refresh" data-id="'+id+'">تحديث سجل المتابعة</button></div>'+customerMailHistory(w)+customerTimeline(w);}});
const customerAgent=createCustomerAgent({api,escape,modal,bindForm,toast,render,getUser:()=>user,openLead:showLead,openContact:showContact,
  openWhatsApp:async accountId=>{
    const channel=customerWorkspaceState?.channels.find(item=>item.channel==='whatsapp'&&item.account_id===accountId&&item.available);
    if(channel)await recordMessenger.open(channel);
  }});
const recordDate=value=>value?new Date(value).toLocaleDateString('ar-EG',{timeZone:'Africa/Cairo',day:'numeric',month:'short',year:'numeric'}):'—';
const serviceTimestamp=value=>value?new Date(value).toLocaleString('ar-EG',{timeZone:'Africa/Cairo',dateStyle:'medium',timeStyle:'short'}):'—';
const recordViews=createRecordViews({getUser:()=>user,getData:()=>data,getStages:()=>stages,formatMoney:money,formatDate:recordDate,sourceName,personName:id=>personName(id)});
const studentRecords=createStudentRecords({getData:()=>data,getUser:()=>user,getPage:()=>page,api,render,modal,bindForm,toast,navigate:async target=>{page=target;search='';await load();}});
const isManager = () => ['admin','manager'].includes(user?.role);
const canFinance = () => ['admin','manager','accountant'].includes(user?.role);
const getContact = id => data.contacts.find(c=>c.id===id);
const personName = id => data.users.find(u=>u.id===id)?.name || 'موظف مختص';
const filtered = list => filterRecordsBySearch(list,search);
const selectedRecordDate=entity=>recordDates[entity]==='today'?cairoDay():recordDates[entity];
function recordsOnDate(rows,entity){
  const day=selectedRecordDate(entity);
  return day?rows.filter(row=>cairoDay(row.created_at)===day):rows;
}
const visibleContacts=()=>filtered(recordsOnDate(data.contacts,'contacts'));
function recordDateFilter(entity){
  const value=recordDates[entity],allLabel={contacts:'كل العملاء',leads:'كل الفرص',tickets:'كل التواريخ'}[entity];
  const button=(choice,label)=>`<button type="button" class="btn small ${value===choice?'primary':''}" aria-pressed="${value===choice}" data-action="record-date" data-id="${choice}">${label}</button>`;
  return `<div class="panel record-date-filter" role="group" aria-label="فلترة بتاريخ الإضافة">
    ${button('today','الجدد اليوم')}
    <label>تاريخ الإضافة<input type="date" data-record-date value="${escape(selectedRecordDate(entity))}"></label>
    ${button('',allLabel)}
    ${entity==='tickets'?'<label>الترتيب<select data-service-order>'+selectOptions({newest:'الأحدث أولًا',oldest:'الأقدم أولًا'},serviceOrder)+'</select></label>':''}
  </div>`;
}
function applyPageSearch(value,source){search=value;updateSectionSearch(document,search,view,source);}
function studentSearchTerms(student){
  const admissionApp=data.apps.find(a=>a.app_key==='me_admissions')?.id;
  const requests=data.appRecords.filter(r=>r.app_id===admissionApp&&JSON.parse(r.data).student===student.id);
  const guardian=getContact(JSON.parse(student.data).guardian);
  return [guardian?.name||'','ST-'+student.id.replaceAll('-','').slice(0,12).toUpperCase(),...requests.map(r=>JSON.parse(r.data).reference||'')];
}
function toast(message,error=false){const el=typeof document==='undefined'?null:$('#toast');if(!el)return;el.textContent=message;el.className='show'+(error?' error':'');setTimeout(()=>el.className='',5000);}
async function api(path,method='GET',body){
  const result=await fetch('/api'+path,{method,credentials:'same-origin',headers:{'Content-Type':'application/json',...(csrf?{'X-CSRF-Token':csrf}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const value=await result.json();if(!result.ok){if(result.status===401&&path!=='/login'){user=null;login();}throw new Error(value.error || 'تعذر تنفيذ العملية');}return value;
}
function empty(title,detail='أضف أول سجل للبدء',icon='◇'){return `<div class="empty"><div class="empty-icon">${icon}</div><b>${escape(title)}</b>${escape(detail)}</div>`;}
function heading(title,subtitle,button='',action=''){return `<div class="pagehead"><div><div class="eyebrow">MID EAST · مساحة العمل</div><h1>${title}</h1><p class="sub">${subtitle}</p></div>${button?`<button class="btn primary" data-action="${action}">＋ ${button}</button>`:''}</div>`;}
function badge(label,style=''){return `<span class="badge ${style}">${escape(label)}</span>`;}
function contactOptions(includeEmpty=false){return `${includeEmpty?'<option value="">بدون ربط</option>':''}`+[...data.contacts,...(data.invoiceContacts||[])].map(c=>`<option value="${c.id}">${escape(c.name)}</option>`).join('');}
function selectOptions(map,value){return Object.entries(map).map(([key,label])=>`<option value="${escape(key)}" ${key===value?'selected':''}>${escape(label)}</option>`).join('');}
function fieldsFor(entity){return ['contact','lead'].includes(entity)?data.fields.filter(f=>f.entity===entity):data.appFields.filter(f=>f.app_id===entity);}
function relationOptions(target){return target==='contact'?data.contacts:target==='lead'?data.leads.map(r=>({...r,name:r.title})):data.appRecords.filter(r=>r.app_id===target);}
function customInputs(entity,values={}){
  return fieldsFor(entity).map(field=>{
    const id='custom_'+field.field_key,value=values[field.field_key];let input;if(!isManager()&&/(?:phone|email|mobile|telephone)/i.test(field.field_key))return `<div><label>${escape(field.label)}</label><p class="sub">حقل اتصال محمي للإدارة</p></div>`;
    const studentApp=data.apps.find(a=>a.id===entity)?.app_key==='me_students';
    if(studentApp&&field.field_key==='nationality_code')return `<input type="hidden" name="${id}" value="${escape(value||'')}">`;
    if(studentApp&&field.field_key==='nationality')input=`<select name="${id}" data-student-nationality="true"><option value="">اختر الجنسية</option>${value&&!countries.some(c=>c.name===value)?`<option selected>${escape(value)}</option>`:''}${countries.map(c=>`<option value="${escape(c.name)}" ${c.name===value?'selected':''}>${escape(c.name)}</option>`).join('')}</select>`;
    else if(studentApp&&field.field_key==='phone_country')input=`<select name="${id}"><option value="">غير مسجل</option>${countries.filter(c=>c.dial).map(c=>`<option value="${c.code}" ${c.code===value?'selected':''}>${escape(c.name)} (${c.dial})</option>`).join('')}</select>`;
    else if(field.type==='relation')input=`<select name="${id}" ${field.required?'required':''}><option value="">اختر سجلًا</option>${relationOptions(field.relation_target).map(r=>`<option value="${r.id}" ${value===r.id?'selected':''}>${escape(r.name)}</option>`).join('')}</select>`;
    else if(field.type==='select')input=`<select name="${id}" ${field.required?'required':''}><option value="">اختر</option>${JSON.parse(field.options).map(v=>`<option ${value===v?'selected':''}>${escape(v)}</option>`).join('')}</select>`;
    else if(field.type==='boolean')input=`<input type="checkbox" name="${id}" ${value?'checked':''}>`;
    else input=`<input name="${id}" type="${field.type==='number'?'number':field.type==='date'?'date':'text'}" value="${escape(value ?? '')}" ${field.required?'required':''} ${field.type==='number'?'step="any"':''} maxlength="2000">`;
    return `<div><label>${escape(field.label)} ${field.required?'*':''}</label>${input}</div>`;
  }).join('');
}
function customValues(form,entity){const result={};for(const field of fieldsFor(entity)){const control=form.elements['custom_'+field.field_key];if(!control)continue;if(field.type==='boolean')result[field.field_key]=control.checked;else if(control.value!=='')result[field.field_key]=field.type==='number'?Number(control.value):control.value;}if(data.apps.find(a=>a.id===entity)?.app_key==='me_students'&&result.nationality){const country=countries.find(c=>c.name===result.nationality);if(country)result.nationality_code=country.code;}return result;}
const currentPasswordField='<label>كلمة مرور حسابك الحالية<input name="current_password" type="password" autocomplete="current-password" dir="ltr" maxlength="256" required></label>';
const factorField='<label>رمز جديد من تطبيق المصادقة<input name="code" inputmode="numeric" pattern="[0-9]{6}" autocomplete="one-time-code" dir="ltr" required></label>';
async function accountVerificationFields(){
  factorState=await api('/security/mfa');
  return currentPasswordField+(factorState.enabled?factorField:'');
}
function modal(title,body,submitLabel='حفظ'){
  $('#modal').className='';
  $('#modal').innerHTML=`<div class="modalhead"><h2>${title}</h2><button class="close" type="button" data-close>×</button></div><div class="modalbody"><form id="editor">${body}<div class="formerror" id="modalerror"></div><div class="modalfoot"><button class="btn primary" type="submit">${submitLabel}</button><button class="btn" type="button" data-close>إلغاء</button></div></form></div>`;
  $('#modal').showModal();return $('#editor');
}
function bindForm(form,handler){form.addEventListener('submit',async event=>{event.preventDefault();const btn=form.querySelector('[type=submit]');btn.disabled=true;try{await handler(new FormData(form),form);if(!user)return;$('#modal').close();await load();toast('تم الحفظ');}catch(error){if($('#modalerror'))$('#modalerror').textContent=error.message;else toast(error.message,true);}finally{btn.disabled=false;}});}
function login(){
  setNavigation(false);
  recordMessenger.reset();
  customerAgent.reset();
  clearInterval(refreshTimer);Object.assign(recordDates,defaultRecordDates);datedInbox=null;serviceOrder='newest';factorState=null;crmInbox=null;crmUnread=0;crmRevision='';refreshCrmPending=false;$('#app').innerHTML=`<main class="login"><div class="loginart"><div class="brand"><div class="brandmark">م</div><div><b>ميد إيست</b><small>BUSINESS WORKSPACE</small></div></div><h1>كل محادثة،<br>فرصة لبداية جديدة.</h1><p>مساحة واحدة لفريقك، من أول رسالة إلى إتمام الخدمة ومتابعة العميل.</p><div class="badge">الإصدار 0.10</div></div><div class="loginform"><form id="loginform"><h2>أهلًا برجوعك</h2><p class="sub">ادخل حسابك لفتح مساحة عمل ميد إيست.</p><label>البريد الإلكتروني</label><input name="email" type="email" dir="ltr" required autocomplete="username"><label>كلمة المرور</label><input name="password" type="password" dir="ltr" required autocomplete="current-password"><label>رمز تطبيق المصادقة — لو مفعل</label><input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code"><div class="formerror" id="loginerror"></div><button class="btn primary" type="submit">دخول مساحة العمل ←</button><p class="footnote">حساب المدير يُنشأ عند تجهيز السيرفر. لو نسيت كلمة المرور تواصل مع مالك النظام.</p></form></div></main>`;
  $('#loginform').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget,btn=form.querySelector('button');btn.disabled=true;try{const result=await api('/login','POST',Object.fromEntries(new FormData(form)));user=result.user;csrf=result.csrf;page=user.role==='accountant'?'finance':'dashboard';await load();startRefresh();}catch(error){$('#loginerror').textContent=error.message;}finally{btn.disabled=false;}});
}
async function load(){data=await api('/data');if(user.role!=='accountant'&&(!crmInbox||page==='tickets')){try{await syncCrmInbox();}catch{}if(!user)return;}if(page==='tickets')await loadDatedInbox();if(!user)return;await studentRecords.load();await workspace.load(page);if(page==='marketing')await marketing.load();if(page==='customer-agent'&&user.role==='admin')await customerAgent.load();if(user.role!=='accountant'&&['dashboard','hub','registrations','social','templates','lab'].includes(page))hubState=await api('/hub');if(page==='integrations')integration=await api('/integrations');if(page==='security')factorState=await api('/security/mfa');render();}
function inboxRevision(value){
  return JSON.stringify([value.activity.map(e=>e.seq),value.waiting.map(e=>e.lead_id),value.waiting_count,value.enabled,value.failures?.map(e=>e.id)]);
}
function seenKey(){return 'mideast.crmSeen.'+user.id;}
function lastSeen(){try{return Number(localStorage.getItem(seenKey()))||0;}catch{return 0;}}
function markCrmSeen(){
  try{localStorage.setItem(seenKey(),String(Math.max(lastSeen(),crmInbox?.activity?.[0]?.seq||0)));}catch{}
  crmUnread=0;
}
async function syncCrmInbox({notify=false}={}){
  if(!user||user.role==='accountant')return;
  const account=user.id, next=await api('/crm-inbox');
  if(user?.id!==account||!Array.isArray(next.activity)||!Array.isArray(next.waiting))return;
  const revision=inboxRevision(next);
  const newItems=next.activity.filter(e=>e.seq>lastSeen());
  const arriving=crmInbox&&newItems.filter(e=>e.seq>(crmInbox.activity[0]?.seq||0));
  if(notify&&arriving?.length)toast(arriving.some(e=>e.kind==='agent_documents')?'وصلت مستندات تحتاج مراجعتك':arriving.some(e=>e.kind==='agent_finance')?'الوكيل حوّل لك سؤالًا عن أتعاب المكتب أو الدفع':'وصل نشاط جديد في الـCRM');
  if(crmInbox&&crmRevision!==revision)refreshCrmPending=true;
  crmInbox=next;crmRevision=revision;crmUnread=newItems.length;
  if(page==='tickets'&&serviceTab==='new'&&!selectedRecordDate('tickets'))markCrmSeen();
}
async function loadDatedInbox(){
  const day=selectedRecordDate('tickets');
  if(!day||!user)return;
  const account=user.id;
  const request={day,loading:true};
  datedInbox=request;
  try{
    const inbox=await api('/crm-inbox?date='+encodeURIComponent(day));
    if(datedInbox===request&&user?.id===account)datedInbox={day,inbox};
  }catch{
    if(datedInbox===request&&user?.id===account)datedInbox={day,error:true};
  }
}
async function changeRecordDate(value,focus){
  const entity=page;
  if(!Object.hasOwn(recordDates,entity))return;
  recordDates[entity]=value;
  const pending=entity==='tickets'&&selectedRecordDate('tickets')?loadDatedInbox():null;
  if(entity==='tickets'&&!pending){
    datedInbox=null;
    if(serviceTab==='new')markCrmSeen();
  }
  render();
  $(focus)?.focus?.();
  if(pending){
    await pending;
    if(!user||page!==entity||recordDates[entity]!==value||$('#modal')?.open)return;
    const restoreFocus=document.activeElement?.matches(focus);
    render();
    if(restoreFocus)$(focus)?.focus?.();
  }
}
const serviceSorted=rows=>[...rows].sort((a,b)=>serviceOrder==='oldest'
  ?String(a.created_at).localeCompare(String(b.created_at))
  :String(b.created_at).localeCompare(String(a.created_at)));
function startRefresh(){
  clearInterval(refreshTimer);
  refreshTimer=setInterval(async()=>{
    if(!user||user.role==='accountant'||refreshing||document.hidden)return;
    refreshing=true;
    try{
      await syncCrmInbox({notify:true});
      if(!user)return;
      const active=document.activeElement;
      const editing=$('#modal')?.open||active?.matches('input,textarea,select,[contenteditable=true]');
      const notice=$('#crm-notice-count');
      if(notice)notice.textContent=crmUnread?String(crmUnread):'';
      const dayChanged=recordDates[page]==='today'&&$('[data-record-date]')?.value!==cairoDay();
      const refreshPage=refreshCrmPending&&['dashboard','tickets','contacts','leads','registrations','tasks'].includes(page);
      if(!editing&&(page==='inbox'||refreshPage||dayChanged)){
        const refreshRevision=crmRevision;
        if(page==='inbox'&&selectedConversation)chatMessages=await api('/conversations/'+selectedConversation+'/messages');
        await load();
        if(crmRevision===refreshRevision)refreshCrmPending=false;
      }
    }catch{}finally{refreshing=false;}
  },8000);
}
function crmInboxView(inbox){
  const day=selectedRecordDate('tickets');
  if(day&&!inbox)return '<section class="panel" role="status">'+(datedInbox?.error?'تعذر تحميل سجلات التاريخ المختار. <button type="button" class="btn small" data-action="retry-record-date">إعادة المحاولة</button>':'جارٍ تحميل سجلات التاريخ المختار…')+'</section>';
  inbox??={waiting:[],activity:[],failures:[],waiting_count:0};
  const emptyForDate=(title,detail='')=>empty(day?'لا توجد سجلات في التاريخ المختار':title,day?'اختر تاريخًا آخر أو اعرض كل التواريخ.':detail);

  const assignButton=id=>'<button class="btn small" data-action="crm-assign" data-id="'+escape(id)+'">تعيين موظف</button>';
  const rows=serviceSorted(inbox.waiting).map(q=>'<article class="fieldcard"><div><b>'+escape(q.title||'فرصة واردة')+'</b><p class="sub">'+escape(q.contact_name||'')+' · '+escape(sourceName(q.source)||q.source)+' · '+escape(serviceTimestamp(q.created_at))+'</p>'+(q.due_at&&Date.parse(q.due_at)<Date.now()?badge('متأخرة','red'):'')+'</div><div class="actions"><button class="btn primary small" data-action="crm-claim" data-id="'+escape(q.lead_id)+'">استلام وفتح الفرصة</button>'+(isManager()?assignButton(q.lead_id):'')+'</div></article>').join('');
  const metrics=(crmInbox?.metrics||[]).map(u=>'<div class="fieldcard"><b>'+escape(u.name)+'</b><span class="sub">'+u.open+' فرص نشطة · '+u.overdue+' مهام متأخرة · '+u.completed+' مهام مكتملة</span></div>').join('');
  const kinds={agent_finance:'سؤال عن أتعاب المكتب أو الدفع',agent_documents:'مستندات واردة تحتاج مراجعتك',agent_handoff:'حالة تحتاج تدخلًا بشريًا',registration:'تسجيل جديد',enquiry:'استفسار جديد',whatsapp:'رسالة واتساب',facebook:'رسالة فيسبوك',instagram:'رسالة إنستجرام',assignment:'تغيير مسؤول المتابعة'};
  const events=serviceSorted(inbox.activity).map(e=>{
    const contact=day&&e.contact_id?getContact(e.contact_id):null;
    const leadLink=e.lead_id&&(day||['agent_documents','agent_finance'].includes(e.kind));
    return '<div class="fieldcard"><div><b>'+escape(kinds[e.kind]||e.kind)+'</b>'+(contact?'<p class="sub">'+escape(contact.name)+'</p>':'')+
      '<small>'+escape(sourceName(e.source)||e.source)+' · '+escape(serviceTimestamp(e.created_at))+'</small></div>'+
      (leadLink?'<button type="button" class="btn small" data-action="crm-activity-open" data-id="'+escape(e.lead_id)+'">فتح الفرصة</button>':
      contact?'<button type="button" class="btn small" data-action="edit-contact" data-id="'+escape(contact.id)+'">فتح العميل</button>':'')+'</div>';
  }).join('');
  return '<section class="panel"><div class="panelhead"><h2>بانتظار الاستلام · '+inbox.waiting_count+'</h2>'+(user.role==='admin'?'<button class="btn small" data-action="crm-toggle">'+(crmInbox?.enabled?'إيقاف إدخال فرص جديدة للصندوق':'تفعيل استقبال الفرص في الصندوق')+'</button>':'')+'</div>'+(rows||emptyForDate('لا توجد فرص بانتظار الاستلام','أي استفسار جديد من قناة مربوطة يظهر هنا تلقائيًا.'))+'</section>'+
    (isManager()?'<section class="panel"><h2>متابعة الفريق الآن</h2>'+metrics+'</section>':'')+
    (isManager()?'<section class="panel"><h2>أحداث واردة تعذر معالجتها</h2>'+(serviceSorted(inbox.failures||[]).map(e=>'<div class="fieldcard"><div><b>'+escape(sourceName(e.source))+'</b><small>'+escape(serviceTimestamp(e.created_at))+' · '+escape(e.code||'PROCESSING_FAILED')+'</small></div>'+(user.role==='admin'?'<button class="btn small" data-action="crm-retry" data-id="'+escape(e.source+'/'+e.id)+'">إعادة المحاولة</button>':'')+'</div>').join('')||emptyForDate('لا توجد أحداث فاشلة'))+'</section>':'')+
    '<section class="panel"><h2>'+(day?'تنبيهات التاريخ المختار':'آخر التنبيهات الداخلية')+'</h2>'+(events||emptyForDate('لا توجد تنبيهات'))+'</section>';
}

const navigation=[['dashboard','◈','نظرة عامة'],['assistant','◇','مساعد الإدارة'],['customer-agent','◇','وكيل خدمة العملاء الذكي'],['communications','◉','مركز التواصل'],['marketing','◉','التسويق الاجتماعي'],['hub','⊞','مركز القنوات'],['registrations','↗','التسجيلات والملفات'],['social','◉','محادثات السوشيال'],['templates','▧','الردود والقوالب'],['lab','⚡','المختبر الافتراضي'],['contacts','♧','العملاء'],['leads','▦','فرص البيع'],['inbox','◉','صندوق المحادثات'],['tickets','▤','خدمة العملاء'],['tasks','☑','المهام والمتابعة'],['quotes','▧','عروض الأسعار'],['finance','↗','الفواتير والتحصيل'],['studio','◇','الاستوديو'],['automations','⚡','الأتمتة'],['users','◎','الفريق والصلاحيات'],['integrations','⊞','الربط والإعدادات'],['audit','≡','سجل العمليات'],['security','◇','أمان الحساب'],['operations','⊙','جاهزية التشغيل']];
function renderNavigation(allowed){
 const groups=[['يوم العمل والتواصل',['dashboard','assistant','communications','marketing','registrations','contacts','tasks','leads','tickets','customer-agent','templates']],['المبيعات والحسابات',['quotes','finance']],['ملفات الخدمات',allowed.filter(n=>n[0].startsWith('app:')).map(n=>n[0])],['أدوات القنوات',['hub','social','inbox']],['الإدارة والأمان',['studio','automations','users','integrations','audit','security','operations','lab']]];
 return groups.map(([title,keys],i)=>{const items=allowed.filter(n=>keys.includes(n[0]));if(!items.length)return '';const buttons=items.map(([key,_,label])=>'<button class="nav '+(page===key?'active':'')+'" data-page="'+key+'" '+(page===key?'aria-current="page"':'')+'><span class="icon">'+brandIcon(key.startsWith('app:')?'services':key)+'</span>'+escape(label)+'</button>').join('');return i<3?'<div class="navlabel">'+title+'</div>'+buttons:'<details class="nav-group" '+(items.some(n=>n[0]===page)?'open':'')+'><summary>'+title+'</summary>'+buttons+'</details>';}).join('');
}
function mobileNavigation(){return typeof window!=='undefined'&&(window.matchMedia?.('(max-width:800px)')?.matches||(window.innerWidth>0&&window.innerWidth<=800));}
function syncNavigation(){
 const mobile=mobileNavigation(),sidebar=$('#primary-navigation-sidebar'),main=$('#workspace-main'),toggle=$('[data-navigation-toggle]'),overlay=$('[data-navigation-overlay]');
 $('.shell')?.classList?.toggle('navigation-open',navigationOpen);document.body?.classList?.toggle('navigation-is-open',mobile&&navigationOpen);
 toggle?.setAttribute?.('aria-expanded',String(navigationOpen));if(overlay)overlay.hidden=!navigationOpen;
 if(sidebar){sidebar.inert=mobile&&!navigationOpen;sidebar.setAttribute?.('aria-hidden',String(mobile&&!navigationOpen));sidebar.setAttribute?.('role',mobile?'dialog':'complementary');if(mobile&&navigationOpen)sidebar.setAttribute?.('aria-modal','true');else sidebar.removeAttribute?.('aria-modal');}
 if(main)main.inert=mobile&&navigationOpen;
}
function setNavigation(open,{restoreFocus=false}={}){
 navigationOpen=Boolean(open);syncNavigation();
 if(navigationOpen&&mobileNavigation())$('[data-navigation-close]')?.focus?.();
 else if(restoreFocus)$('[data-navigation-toggle]')?.focus?.();
}
function focusCurrentPage(){const title=$('#content h1');title?.setAttribute?.('tabindex','-1');title?.focus?.();}
function render(){
  stages=Object.fromEntries(data.pipeline.map(s=>[s.stage_key,s.label]));
  const allNav=[...navigation,...data.apps.map(a=>['app:'+a.id,'▣',a.app_key==='me_documents'?'مستندات الطلاب':a.name])];
  const allowed=allNav.filter(([key])=>!(['studio','automations','integrations','audit','operations','hub','templates','lab','assistant','marketing'].includes(key)&&!isManager()) && !(['users','customer-agent'].includes(key)&&user.role!=='admin') && !(key==='finance'&&!canFinance()) && !(user.role==='accountant'&&!['finance','security','quotes'].includes(key)));
  if(!allowed.some(([key])=>key===page))page=allowed[0][0];
  $('#app').innerHTML=`<div class="shell${navigationOpen?' navigation-open':''}"><button class="navigation-overlay" type="button" data-navigation-overlay aria-label="إغلاق القائمة الرئيسية" tabindex="-1" ${navigationOpen?'':'hidden'}></button><aside class="sidebar" id="primary-navigation-sidebar" aria-label="القائمة الرئيسية"><div class="sidebar-heading"><div class="brand"><div class="brandmark">م</div><div><b>ميد إيست</b><small>BUSINESS WORKSPACE</small></div></div><button class="navigation-close" type="button" data-navigation-close aria-label="إغلاق القائمة الرئيسية">×</button></div><div class="sidebar-search"><label for="search">بحث في الصفحة الحالية</label><div>${brandIcon('search',17)}<input class="search" id="search" placeholder="بحث في الصفحة…" value="${escape(search)}" aria-label="بحث في الصفحة"></div></div><nav class="primary-navigation" aria-label="صفحات المنصة">${renderNavigation(allowed)}</nav><div class="sidebar-bottom"><div class="userline"><span class="avatar">${escape(user.name.slice(0,1))}</span><div>${escape(user.name)}<small>${roles[user.role]}</small></div></div><button class="nav" data-action="logout">خروج من الحساب</button><div class="statusnote">مساحة عمل مستقلة<br>مساحة العمل · 0.10</div></div></aside><main class="main" id="workspace-main"><header class="topbar"><button type="button" class="navigation-toggle" data-navigation-toggle aria-controls="primary-navigation-sidebar" aria-expanded="${navigationOpen}">${brandIcon('list',21)}<span>القائمة الرئيسية</span></button><div class="breadcrumb"><span>${escape(data.settings.company_name || 'ميد إيست')}</span><b>${escape(allNav.find(n=>n[0]===page)?.[2])}</b></div>${user.role==='accountant'?'':'<button type="button" class="btn small" data-action="crm-notifications">تنبيهات الـCRM <span id="crm-notice-count" aria-live="polite">'+(crmUnread||'')+'</span></button>'}</header><section id="content">${view()}</section></main></div>`;
  syncNavigation();
  $('#search').addEventListener('input',event=>{if(!event.isComposing)applyPageSearch(event.target.value,event.target);});
}
function view(){
  if(page==='marketing')return marketing.view();
  if(page==='customer-agent')return customerAgent.view();
  const workspacePage=workspace.view(page);if(workspacePage!==null)return workspacePage;
  const omni=omniView();if(omni!==null)return omni;
  const extra=advancedView();if(extra!==null)return extra;
  if(page==='dashboard'){
    const openTasks=data.tasks.filter(t=>t.status==='open'),active=data.leads.filter(l=>!['won','lost'].includes(l.stage)),openTickets=data.tickets.filter(t=>t.status!=='resolved');
    return heading(`صباح العمل، ${escape(user.name.split(' ')[0])} ☀`,'صورة واضحة للعملاء والمتابعة، من مكان واحد.')+`<div class="metrics">${[['♧',data.contacts.length,'إجمالي العملاء','جهات اتصال مسجلة'],['▦',active.length,'فرص قيد المتابعة','عبر مراحل البيع'],['◉',data.conversations.length,'محادثات واتساب','المحادثات المسجلة'],['☑',openTasks.length,'مهام مفتوحة','متابعة تحتاج تنفيذ']].map(([icon,count,label,note])=>`<article class="metric"><div class="metric-icon">${icon}</div><span>${escape(label)}</span><strong>${count.toLocaleString('ar-EG')}</strong><small>${note}</small></article>`).join('')}</div><div class="grid2"><div class="panel"><div class="panelhead"><h2>مسار فرص البيع</h2><button class="linkbutton" data-page="leads">عرض المسار ←</button></div>${Object.entries(stages).map(([key,label])=>{const count=data.leads.filter(l=>l.stage===key).length;return `<div class="progressrow"><span>${escape(label)}</span><div class="bar"><div style="width:${data.leads.length?count/data.leads.length*100:0}%"></div></div><b>${count.toLocaleString('ar-EG')}</b></div>`;}).join('')}</div><div class="panel"><div class="panelhead"><h2>المتابعة القادمة</h2><button class="linkbutton" data-page="tasks">كل المهام ←</button></div>${openTasks.length?openTasks.slice(0,4).map(taskRow).join(''):empty('كل شيء جاهز للبدء','أضف عميلًا، ثم حدد أول متابعة','☑')}<div class="setup-card"><b>${openTickets.length.toLocaleString('ar-EG')} تذاكر تحتاج متابعة</b><p>تابع طلبات العملاء، وأغلق التذكرة بعد حل المشكلة.</p></div></div></div>${!data.contacts.length?`<div class="panel"><h2>ابدأ مساحة عملك</h2><p class="sub">البيانات تبدأ فارغة. أضف فريقك وحقول عملك، ثم سجّل أول عميل.</p><div class="actions" style="margin-top:18px"><button class="btn primary" data-action="contact">＋ أول عميل</button>${isManager()?'<button class="btn" data-page="studio">افتح الاستوديو</button><button class="btn" data-page="integrations">إعداد واتساب</button>':''}</div></div>`:''}`;
  }
  if(page==='contacts')return heading('العملاء','اعرض العملاء حسب تاريخ إضافتهم بتوقيت القاهرة.','إضافة عميل','contact')+recordDateFilter('contacts')+sectionSearch('العملاء',isManager()?'اسم العميل أو رقم الهاتف أو البريد':'اسم العميل أو بياناته المتاحة',search,recordViews.view('contacts',visibleContacts()));
  if(page==='leads')return heading('فرص البيع','اعرض الفرص حسب تاريخ إنشائها بتوقيت القاهرة.','فرصة جديدة','lead')+recordDateFilter('leads')+sectionSearch('الفرص','عنوان الفرصة أو اسم العميل',search,recordViews.view('leads',filterRecordsBySearch(recordsOnDate(data.leads,'leads'),search,r=>[getContact(r.contact_id)?.name||''])));
  if(page==='tasks')return heading('المهام والمتابعة','خطوة واضحة لكل موعد، حتى لا تفوت متابعة أي عميل.','مهمة جديدة','task')+`<div class="panel">${data.tasks.length?filtered(data.tasks).map(taskRow).join(''):empty('لا توجد مهام','أضف مهمة أو أنشئ قاعدة متابعة من الأتمتة','☑')}</div>`;
  if(page==='tickets')return customerServiceView();
  if(page==='inbox'){
    const conversation=data.conversations.find(c=>c.id===selectedConversation);
    return heading('صندوق المحادثات','المحادثة مرتبطة بملف العميل وصلاحيات موظفه.','بدء محادثة','conversation')+`<div class="notebox">الإرسال الفعلي يحتاج إعداد Meta على السيرفر. خارج نافذة الرد استخدم قالبًا معتمدًا. وصول الرسائل وتكاليفها يخضعان لإعدادات وسياسة Meta.</div><div class="panel inbox"><div class="conversationlist"><h3>المحادثات ${badge(data.conversations.length)}</h3>${filtered(data.conversations).map(c=>`<button class="conv ${selectedConversation===c.id?'active':''}" data-conversation="${c.id}"><span class="avatar">${escape(c.name.slice(0,1))}</span><span class="info"><b>${escape(c.name)}</b><small>${escape(c.preview || 'لم تبدأ المحادثة')}</small></span></button>`).join('')}${!data.conversations.length?empty('الصندوق فارغ','ستظهر المحادثات هنا'):''}</div><div class="chat">${conversation?`<div class="chatheader"><div class="person"><span class="avatar">${escape(conversation.name.slice(0,1))}</span><div><b>${escape(conversation.name)}</b><small class="mono">${escape(conversation.phone)}</small></div></div><div class="actions"><button class="btn small" data-action="send-file">إرسال مرفق</button><button class="btn small" data-action="template">قالب معتمد</button></div></div><div class="messages">${chatMessages.length?chatMessages.map(m=>`<div class="bubble ${m.direction==='out'?'out':''}">${escape(m.body || '['+m.kind+']')}${m.attachment_id?`<a class="btn small" href="/api/files/${m.attachment_id}">تنزيل المرفق</a>`:m.media_id?`<button class="btn small" data-action="download-media" data-id="${m.id}">حفظ المرفق من واتساب</button>`:''}<small>${new Date(m.created_at).toLocaleString('ar-EG')} · ${escape(statusLabels[m.status]||m.status)}${m.error_code?' · '+escape(m.error_code):''}</small></div>`).join(''):empty('محادثة جديدة','أرسل قالبًا معتمدًا لبدء التواصل')}</div><form class="composer" id="composer"><textarea name="body" placeholder="اكتب ردك هنا…" maxlength="4096" required></textarea><button class="btn primary" type="submit">إرسال ←</button></form>`:empty('اختار محادثة للبدء','كل محادثة في مكانها، مع الموظف المسؤول','◉')}</div></div>`;
  }
  if(page==='users')return heading('الفريق والصلاحيات','لكل موظف حسابه ودوره، والعملاء المسندون إليه.','إضافة موظف','user')+`<div class="panel"><div class="tablewrap"><table><thead><tr><th>الموظف</th><th>البريد</th><th>الدور</th><th>الحالة</th><th></th></tr></thead><tbody>${data.users.map(u=>`<tr><td><div class="person"><span class="avatar">${escape(u.name.slice(0,1))}</span><b>${escape(u.name)}</b></div></td><td>${escape(u.email)}</td><td>${roles[u.role]}</td><td>${badge(u.active?'نشط':'موقوف',u.active?'green':'')}</td><td><div class="actions"><button class="linkbutton" data-action="edit-user" data-id="${u.id}">الصلاحية وكلمة المرور</button>${u.id!==user.id?`<button class="linkbutton" data-action="toggle-user" data-id="${u.id}">${u.active?'إيقاف':'تفعيل'}</button>`:''}</div></td></tr>`).join('')}</tbody></table></div></div><div class="notebox">موظف خدمة العملاء يرى السجلات المسندة إليه. المدير يدير الفريق والعملاء. المحاسب يرى الفواتير والدفعات وأسماء العملاء اللازمة لها. المالك يدير المستخدمين والتصدير. إعادة إسناد العميل تنقل معه فرصه ومهامه وتذاكره وصلاحية المحادثة والملفات.</div>`;
  if(page==='finance')return heading('الفواتير والتحصيل','فواتير داخلية بسيطة ودفعات مرتبطة بالعميل.','فاتورة جديدة','invoice')+`<div class="notebox">هذه وحدة متابعة مالية أولية. لا تنفذ دفعًا بنكيًا، وليست فاتورة ضريبية إلكترونية أو دفتر أستاذ محاسبي.</div><div class="panel">${data.invoices.length?`<div class="tablewrap"><table><thead><tr><th>رقم الفاتورة</th><th>العميل / البيان</th><th>الإجمالي</th><th>المحصل</th><th>المتبقي</th><th>الحالة</th><th></th></tr></thead><tbody>${filtered(data.invoices).map(i=>`<tr><td class="mono">${escape(i.number)}</td><td><b>${escape(i.contact_name)}</b><div class="sub">${escape(i.description)}</div></td><td>${money(i.amount_minor,i.currency)}</td><td>${money(i.paid_minor,i.currency)}</td><td>${money(i.amount_minor-i.paid_minor,i.currency)}</td><td>${badge({draft:'مسودة',issued:'صادرة',void:'ملغاة'}[i.status],i.paid_minor===i.amount_minor?'green':'')}</td><td>${isManager()?`<a class="btn small" href="/api/print/invoice/${i.id}" target="_blank" rel="noopener">طباعة</a>`:'<span class="muted">الطباعة للإدارة</span>'} ${i.status==='draft'?`<button class="btn small" data-action="issue-invoice" data-id="${i.id}">إصدار داخلي</button>`:i.status==='issued'&&i.amount_minor>i.paid_minor?`<button class="btn small" data-action="payment" data-id="${i.id}">إثبات دفعة</button>`:''}</td></tr>`).join('')}</tbody></table></div>`:empty('لم تُسجل فواتير بعد','أضف العميل ثم أنشئ أول فاتورة','↗')}</div>`;
  if(page==='audit')return heading('سجل العمليات','تعرف مين نفذ الإجراء ووقته، دون إظهار كلمات المرور أو أسرار الربط.')+`<div class="panel" id="auditpanel">${empty('تحميل سجل العمليات…','')}</div>`;
  return '';
}
function customerServiceTickets(tickets){return `<div class="panel">${tickets.length?`<div class="tablewrap"><table><thead><tr><th>التذكرة</th><th>العميل</th><th>الأولوية</th><th>المسؤول</th><th>تاريخ الفتح</th><th>الحالة</th></tr></thead><tbody>${tickets.map(t=>`<tr><td><b>${escape(t.title)}</b><div class="sub">${escape(t.description)}</div></td><td>${escape(getContact(t.contact_id)?.name)}</td><td>${badge({low:'منخفضة',normal:'عادية',high:'عاجلة'}[t.priority],t.priority==='high'?'red':'')}</td><td>${escape(personName(t.owner_id))}</td><td>${escape(recordDate(t.created_at))}</td><td><select data-ticket="${t.id}">${selectOptions({open:'مفتوحة',pending:'قيد المتابعة',resolved:'تم الحل'},t.status)}</select></td></tr>`).join('')}</tbody></table></div>`:empty('لا توجد تذاكر مطابقة',selectedRecordDate('tickets')?'اختر تاريخًا آخر أو اعرض كل التواريخ.':'سجّل طلب العميل وحدد أولويته والمسؤول عنه','▤')}</div>`;}
function customerServiceView(){
 const day=selectedRecordDate('tickets');
 const inbox=day?(datedInbox?.day===day?datedInbox.inbox:null):crmInbox;
 const mine=serviceSorted(recordsOnDate(data.leads,'tickets').filter(lead=>lead.owner_id===user.id&&!['won','lost'].includes(lead.stage)));
 const tickets=serviceSorted(filtered(recordsOnDate(data.tickets,'tickets')));
 const tabs={new:'فرص جديدة ('+(inbox?.waiting_count??(day?'…':0))+')',mine:'فرصي ('+mine.length+')',tickets:'التذاكر ('+tickets.length+')'};
 const menu='<div class="service-tabs" role="group" aria-label="أقسام خدمة العملاء">'+Object.entries(tabs).map(([key,label])=>'<button type="button" class="btn '+(serviceTab===key?'primary':'')+'" aria-pressed="'+(serviceTab===key)+'" data-action="service-tab" data-id="'+key+'">'+escape(label)+'</button>').join('')+'</div>';
 let content=crmInboxView(inbox);
 if(serviceTab==='mine')content='<section class="panel"><h2>فرصي قيد المتابعة</h2>'+(mine.map(l=>'<article class="fieldcard"><div><b>'+escape(getContact(l.contact_id)?.name||l.title)+'</b><p class="sub">'+escape(l.title)+' · '+escape(stages[l.stage]||l.stage)+' · '+escape(recordDate(l.created_at))+'</p></div><button class="btn primary small" data-action="edit-lead" data-id="'+escape(l.id)+'">فتح الفرصة والرد</button></article>').join('')||empty(day?'لا توجد فرص متابعة في التاريخ المختار':'لا توجد فرص مسندة إليك',day?'اختر تاريخًا آخر أو اعرض كل التواريخ.':'استلم فرصة من تبويب الفرص الجديدة للبدء.'))+'</section>';
 if(serviceTab==='tickets')content=customerServiceTickets(tickets);
 return heading('خدمة العملاء','استلم الفرصة، راجع سجلها ورد على العميل من نفس المكان.',serviceTab==='tickets'?'فتح تذكرة':'','ticket')+recordDateFilter('tickets')+menu+content;
}
function taskRow(t){return `<div class="taskrow ${t.status==='done'?'done':''}"><button class="check" data-task="${t.id}" aria-label="تغيير حالة المهمة">${t.status==='done'?'✓':''}</button><div class="detail"><b>${escape(t.title)}</b><small>${escape(getContact(t.contact_id)?.name || 'مهمة فريق')} · ${escape(personName(t.owner_id))}</small></div>${badge(date(t.due_at),t.status==='open'&&t.due_at&&Date.parse(t.due_at)<Date.now()?'red':'')}</div>`;}
async function showContact(id){
  const current=id?getContact(id):null,visible=isManager();
  const details=visible?`<div><label>دولة رقم الهاتف</label><select name="phone_country">${countries.filter(c=>c.dial).map(c=>`<option value="${c.code}" ${c.code==='EG'?'selected':''}>${escape(c.name)} (${c.dial})</option>`).join('')}</select></div><div><label>رقم الهاتف</label><input name="phone" dir="ltr" placeholder="رقم محلي أو + كود الدولة" value="${escape(current?.phone||'')}"></div><div><label>البريد الإلكتروني</label><input name="email" type="email" dir="ltr" value="${escape(current?.email||'')}"></div>`:`<div class="full customer-privacy">${brandIcon('shield',22)}<span>بيانات الاتصال محمية للإدارة. يمكنك التواصل من أزرار العميل دون رؤية الرقم أو البريد. إضافة بيانات الاتصال وتعديلها للإدارة.</span></div>`;
  const form=modal(current?'ملف العميل والمتابعة':'إضافة عميل',`<div class="formgrid"><div><label>اسم العميل *</label><input name="name" required value="${escape(current?.name||'')}"></div>${details}${visible?`<div><label>الموظف المسؤول</label><select name="owner_id">${data.users.filter(u=>u.active&&u.role!=='accountant').map(u=>`<option value="${u.id}" ${(current?.owner_id||user.id)===u.id?'selected':''}>${escape(u.name)}</option>`).join('')}</select></div>`:''}${customInputs('contact',current?JSON.parse(current.custom):{})}</div>${current?'<section class="customer-workspace"><h3>التواصل من ملف العميل</h3><div id="customer-channel-panel">جارٍ تحميل القنوات…</div><div id="record-messenger" class="record-messenger"></div></section><section class="files"><b>المستندات</b><div id="filelist">جارٍ التحميل…</div><label>إرفاق ملف (بحد أقصى 10 ميجابايت)</label><input type="file" id="uploadfile"><button type="button" class="btn small" data-action="upload" data-id="'+current.id+'">رفع الملف</button><p class="footnote">الأصول متاحة للإدارة لحماية بيانات الاتصال داخل الصور والإيصالات. فحص البرمجيات الضارة غير مفعل في هذا الإصدار.</p></section>':''}`);
  bindForm(form,async(values,el)=>{const payload={...Object.fromEntries(values),custom:customValues(el,'contact')};await api(id?'/contacts/'+id:'/contacts',id?'PATCH':'POST',payload);});
  if(current){
    await api('/contacts/'+current.id+'/viewed','POST',{});await loadFiles(current.id);
    const block=document.createElement('section');block.className='customer-followup';block.innerHTML='<h3>سجل المتابعة</h3><label for="note-body">ملاحظة داخلية للفريق</label><textarea id="note-body" rows="3" maxlength="4000" placeholder="ما الذي تم؟ وما خطوة المتابعة التالية؟"></textarea><button class="btn small" type="button" data-action="add-note" data-id="'+current.id+'">حفظ الملاحظة باسمك ووقتها</button><div id="customer-timeline-panel"></div><label><input type="checkbox" id="wa-consent" '+(current.whatsapp_opt_in?'checked':'')+'> موافقة العميل على بدء التواصل عبر واتساب</label><button class="btn small" type="button" data-action="save-consent" data-id="'+current.id+'">حفظ حالة الموافقة</button>';form.querySelector('.modalfoot').before(block);arrangeRecord(form);await loadCustomerWorkspace(current.id);
  }
}
async function loadFiles(id){const files=await api('/contacts/'+id+'/files'),el=$('#filelist');if(el)el.innerHTML=files.map(f=>`<div class="fileline">${isManager()?`<a href="/api/files/${f.id}">${escape(f.name)}</a>`:`<span>${brandIcon('document',18)} ${escape(f.name)} · الأصل للإدارة</span>`}<span class="muted">${Math.ceil(f.size/1024)} KB</span></div>`).join('')||'<p class="sub">لا توجد ملفات بعد</p>';}
async function loadCustomerWorkspace(id){
  customerWorkspaceState=await api('/contacts/'+id+'/workspace');const channel=$('#customer-channel-panel'),timeline=$('#customer-timeline-panel');
  if(channel)channel.innerHTML=customerChannelButtons(customerWorkspaceState)+(user.role==='admin'?'<button type="button" class="linkbutton" data-action="customer-mail-settings">إعداد واختبار بريد الشركة</button>':'');
  const messenger=$('#record-messenger');
  if(messenger){
    recordMessenger.mount(messenger,customerWorkspaceState);
    const area=messenger.previousElementSibling?.matches('[data-agent-contact]')?messenger.previousElementSibling:document.createElement('div');
    if(!area.isConnected)messenger.before(area);
    customerAgent.mount(area,id,messenger.closest('[data-agent-lead]')?.dataset.agentLead).catch(()=>area.remove());
  }
  if(timeline)timeline.innerHTML='<div class="actions"><button type="button" class="linkbutton" data-action="customer-refresh" data-id="'+id+'">تحديث سجل المتابعة</button></div>'+customerMailHistory(customerWorkspaceState)+customerTimeline(customerWorkspaceState);
}
async function openCustomerChannel(id,index){
  if(customerWorkspaceState?.contact.id!==id)await loadCustomerWorkspace(id);const c=customerWorkspaceState.channels[index];if(!c?.available)throw new Error(c?.reason||'القناة غير متاحة');
  if(c.channel==='email'){
    const name=customerWorkspaceState.contact.name,requestKey=crypto.randomUUID();const form=modal('بريد إلى '+name,'<p class="customer-privacy">سيحدد الخادم بريد العميل المسجل. لا تُدخل عنوانًا أو تنسخ بيانات اتصال.</p><label>عنوان الرسالة</label><input name="subject" required maxlength="200"><label>نص الرسالة</label><textarea name="body" required rows="7" maxlength="12000"></textarea><p class="footnote">تُحفظ الرسالة باسم الموظف وحالتها في ملف العميل. قبول مزود البريد لا يثبت القراءة.</p>','تجهيز البريد للإرسال');
    bindForm(form,async values=>{await api('/contacts/'+id+'/send-email','POST',{subject:values.get('subject'),body:values.get('body'),request_key:requestKey});});return;
  }
  await recordMessenger.open(c);
}
async function showCustomerMailSettings(){
  const s=await api('/customer-mail/settings'),names={'smtp.gmail.com':'Gmail','smtp.office365.com':'Microsoft 365','smtp-mail.outlook.com':'Outlook','smtp.zoho.com':'Zoho','smtp.zoho.eu':'Zoho Europe','smtp-relay.brevo.com':'Brevo'};
  const form=modal('بريد الشركة','<p class="sub">استخدم حساب الشركة الحالي. لا تنشئ هذه الخطوة اشتراكًا ولا ترسل رسالة لعميل. ستُحفظ بيانات الربط مشفرة ثم يُختبر الاتصال.</p><label>مزود البريد</label><select name="host">'+s.allowed_hosts.map(h=>'<option value="'+escape(h)+'" '+(h===s.host?'selected':'')+'>'+escape(names[h]||h)+'</option>').join('')+'</select><label>منفذ الاتصال الآمن</label><select name="port"><option value="465" '+(s.port===465?'selected':'')+'>465 — TLS</option><option value="587" '+(s.port===587?'selected':'')+'>587 — STARTTLS</option></select><label>حساب البريد</label><input name="user" autocomplete="off" dir="ltr" required value="'+escape(s.user)+'"><label>بريد الإرسال</label><input name="from" type="email" dir="ltr" required value="'+escape(s.from)+'"><label>كلمة مرور التطبيق من مزود البريد</label><input name="password" type="password" autocomplete="new-password" maxlength="500" '+(s.password_set?'':'required')+'><p class="footnote">لا تُعاد كلمة المرور للمتصفح بعد الحفظ. اتركها فارغة للاحتفاظ بالمحفوظة. لا ترسلها في المحادثة.</p>','حفظ واختبار الاتصال');
  bindForm(form,async values=>{await api('/customer-mail/settings','PATCH',{...Object.fromEntries(values),port:Number(values.get('port'))});await api('/customer-mail/verify','POST',{});});
}

async function showLead(id){
  const current=id?data.leads.find(l=>l.id===id):null;
  if(id&&!current)throw new Error('الفرصة لم تعد متاحة لك');
  const contact=current?getContact(current.contact_id):null;
  const summary=current?'<div class="opportunity-summary"><b>'+escape(contact?.name||current.title)+'</b>'+badge(stages[current.stage]||current.stage,'green')+'<span class="sub">'+escape(current.owner_id?personName(current.owner_id):'بانتظار الاستلام')+'</span></div>':'';
  const form=modal(current?'تفاصيل الفرصة':'فرصة بيع جديدة',`${summary}${current?'<button type="button" class="btn" data-action="edit-contact" data-id="'+current.contact_id+'">ملف العميل والتواصل وسجل المتابعة</button>'+(isManager()?'<button type="button" class="btn" data-action="crm-assign" data-id="'+escape(current.id)+'">تعيين مسؤول</button>':''):''}<div class="formgrid"><div class="full"><label>عنوان الفرصة *</label><input name="title" value="${escape(current?.title||'')}" required></div>${current?`<div><label>مرحلة الفرصة<select name="stage">${selectOptions(stages,current.stage)}</select></label></div>`:''}${!current?`<div><label>العميل *</label><select name="contact_id" required>${contactOptions()}</select></div><div><label>القيمة بالجنيه المصري</label><input name="value" type="number" step="0.01" min="0" value="0"></div>`:''}${customInputs('lead',current?JSON.parse(current.custom):{})}</div>`);
  bindForm(form,async(values,el)=>{const body={...Object.fromEntries(values),custom:customValues(el,'lead')};if(!current)body.value_minor=Math.round(Number(values.get('value'))*100);delete body.value;await api(current?'/leads/'+id:'/leads',current?'PATCH':'POST',body);});
  if(current){
   const section=document.createElement('section');section.className='customer-workspace';section.dataset.agentLead=current.id;section.innerHTML='<h3>المحادثة من داخل الفرصة</h3><div data-request-wa-files></div><div id="customer-channel-panel"></div><div id="record-messenger" class="record-messenger"></div>';
   const followup=document.createElement('section');followup.className='customer-followup';followup.innerHTML='<h3>ملاحظات الفريق والمتابعة</h3><label for="note-body">ملاحظة داخلية — لا تُرسل للعميل</label><textarea id="note-body" rows="3" maxlength="4000" placeholder="آخر إجراء وخطوة المتابعة التالية"></textarea><button type="button" class="btn small" data-action="add-note" data-id="'+current.contact_id+'">حفظ الملاحظة</button><div id="customer-timeline-panel"></div>';
   form.querySelector('.modalfoot').before(section,followup);arrangeRecord(form);
   await Promise.all([loadCustomerWorkspace(current.contact_id),loadRequestWhatsAppFiles(section,current.id)]);
  }
}
async function loadRequestWhatsAppFiles(section,leadId){
 const area=section.querySelector('[data-request-wa-files]');
 try{
  const files=await api('/customer-agent/leads/'+encodeURIComponent(leadId)+'/documents');
  if(files.length)area.innerHTML='<h4>ملفات واتساب لهذا الطلب</h4>'+files.map(file=>'<div class="fileline">'+(isManager()?'<a href="/api/files/'+escape(file.id)+'">'+escape(file.name)+'</a>':'<span>'+escape(file.name)+'</span>')+'</div>').join('');
 }catch{area.textContent='تعذر تحميل ملفات واتساب لهذا الطلب.';}
}
function arrangeRecord(form){
 $('#modal').classList.add('record-modal');
 const layout=document.createElement('div');layout.className='record-layout';
 const details=document.createElement('section');details.className='record-details';details.setAttribute('aria-label','بيانات الملف');
 const side=document.createElement('section');side.className='record-conversation';side.setAttribute('aria-label','التواصل والمتابعة');
 const fields=form.querySelector('.formgrid'),files=form.querySelector('.files'),chat=form.querySelector('.customer-workspace'),followup=form.querySelector('.customer-followup');
 if(fields)details.append(fields);if(files)details.append(files);if(chat)side.append(chat);if(followup)side.append(followup);layout.append(details,side);form.prepend(layout);
}
async function action(name,id){
  if(name==='crm-notifications'){page='tickets';serviceTab='new';recordDates.tickets='';datedInbox=null;search='';await load();return;}
  if(name==='crm-activity-open'){await showLead(id);return;}
  if(name==='service-tab'){serviceTab=id;if(id==='new'&&!selectedRecordDate('tickets'))markCrmSeen();render();return;}
  if(name==='crm-retry'){await api('/crm-inbox/retry/'+id,'POST',{});await load();toast('تمت إضافة الحدث إلى طابور المعالجة');return;}
  if(name==='crm-claim'){
    try{const claimed=await api('/crm-inbox/'+encodeURIComponent(id)+'/claim','POST',{});page='tickets';serviceTab='mine';search='';await load();toast('الفرصة بقت ضمن فرصك');await showLead(claimed.lead_id);}
    catch(error){await load();throw error;}
    return;
  }
  if(name==='crm-toggle'){await api('/crm-inbox/settings','PATCH',{enabled:!crmInbox?.enabled});await load();return;}
  if(name==='crm-assign'){
    const choices=data.users.filter(u=>u.active&&u.role!=='accountant').map(u=>'<option value="'+escape(u.id)+'">'+escape(u.name)+'</option>').join('');
    const form=modal('تعيين مسؤول المتابعة','<p class="sub">ينتقل ملف العميل المرتبط بالمحادثات والمستندات والمهام إلى الموظف المختار.</p><label>الموظف<select name="owner_id" required>'+choices+'</select></label><label>السبب<input name="reason" maxlength="500" required></label>','تعيين');
    bindForm(form,async v=>api('/crm-inbox/'+encodeURIComponent(id)+'/assign','POST',Object.fromEntries(v)));return;
  }
  if(name==='export-customers'){
    if(user.role!=='admin')throw new Error('تصدير بيانات العملاء للمالك');
    const query=search,createdOn=selectedRecordDate('contacts'),visible=visibleContacts().length,hasFilters=Boolean(query.trim()||createdOn);
    const form=modal('تصدير العملاء إلى Excel',`<label>نطاق التصدير<select name="scope"><option value="all" ${hasFilters?'':'selected'}>كل العملاء (${data.contacts.length})</option><option value="filtered" ${hasFilters?'selected':''}>النتائج المعروضة (${visible})</option></select></label><p class="sub">يشمل حالة أحدث فرصة لكل عميل، وجميع حالات الفرص وملفات الطلاب المرتبطة، والخدمات المطلوبة وبيانات التواصل والمسؤول.</p><p class="sub">الملف بصيغة XLSX، مع فلترة الأعمدة وتثبيت العناوين.</p>`,'تنزيل Excel');
    form.addEventListener('submit',async event=>{
      event.preventDefault();const button=form.querySelector('[type=submit]');button.disabled=true;
      try{
        const response=await fetch('/api/contacts/export.xlsx',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({scope:form.elements.scope.value,query:form.elements.scope.value==='filtered'?query:'',created_on:form.elements.scope.value==='filtered'?createdOn:''})});
        if(!response.ok){let message='تعذر تصدير العملاء';try{message=(await response.json()).error||message;}catch{}throw new Error(message);}
        const blob=await response.blob(),url=URL.createObjectURL(blob),link=document.createElement('a');
        link.href=url;link.download=response.headers.get('content-disposition')?.match(/filename="([A-Za-z0-9-]+\.xlsx)"/)?.[1]||'Middle-East-Customers.xlsx';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
        $('#modal').close();toast('تم تجهيز ملف Excel لعدد '+response.headers.get('x-export-count')+' عميل');
      }catch(error){$('#modalerror').textContent=error.message;}finally{button.disabled=false;}
    });return;
  }
  if(name==='record-date'){await changeRecordDate(id||'','[data-action=record-date][aria-pressed=true]');return;}
  if(name==='retry-record-date'){await changeRecordDate(recordDates.tickets,'[data-record-date]');return;}
  if(name==='clear-page-search'){applyPageSearch('',null);$('[data-page-search]')?.focus();return;}
  if(await studentRecords.action(name,id))return;
  if(await marketing.action(name,id))return;
  if(await customerAgent.action(name,id))return;
  if(await workspace.action(name,id))return;
  if(recordViews.action(name,id)){render();return;}
  if(await advancedAction(name,id))return;
  if(name==='logout'){recordMessenger.reset();await api('/logout','POST',{});user=null;login();return;}
  if(name==='customer-refresh'){await loadCustomerWorkspace(id);return;}
  if(name==='customer-channel'){const parts=id.split('|');await openCustomerChannel(parts[0],Number(parts[1]));return;}
  if(name==='customer-mail-settings'){await showCustomerMailSettings();return;}
  if(name==='contact'||name==='edit-contact'){await showContact(id);return;}
  if(name==='lead'||name==='edit-lead'){if(!data.contacts.length){toast('أضف عميلًا أولًا',true);return;}await showLead(id);return;}
  if(name==='enquiry-registration-link'){
    const result=await api('/enquiries/'+encodeURIComponent(id)+'/registration-link','POST',{});
    const form=modal('رابط استكمال التقديم','<p>شارك الرابط مع صاحب الاستفسار بعد التحقق من جهة الاتصال. الرابط صالح لمدة ٧ أيام ويُستخدم لاستكمال طلب واحد.</p><label>رابط التقديم<input name="link" dir="ltr" readonly value="'+escape(result.registration_url)+'"></label>','نسخ الرابط');
    bindForm(form,async()=>{await navigator.clipboard.writeText(result.registration_url);toast('تم نسخ رابط الاستكمال');});return;
  }
  if(name==='task'){
    const form=modal('مهمة متابعة',`<label>عنوان المهمة *</label><input name="title" required><div class="formgrid"><div><label>العميل</label><select name="contact_id">${contactOptions(true)}</select></div><div><label>الموعد</label><input name="due_at" type="datetime-local"></div></div>`);
    bindForm(form,async(values)=>api('/tasks','POST',Object.fromEntries(values)));return;
  }
  if(name==='ticket'){
    if(!data.contacts.length){toast('أضف عميلًا أولًا',true);return;}
    const form=modal('تذكرة خدمة عميل',`<label>عنوان الطلب *</label><input name="title" required><div class="formgrid"><div><label>العميل</label><select name="contact_id">${contactOptions()}</select></div><div><label>الأولوية</label><select name="priority">${selectOptions({low:'منخفضة',normal:'عادية',high:'عاجلة'},'normal')}</select></div></div><label>التفاصيل</label><textarea name="description" rows="4"></textarea>`);
    bindForm(form,async(values)=>api('/tickets','POST',Object.fromEntries(values)));return;
  }
  if(name==='conversation'){
    if(!data.contacts.length){toast('أضف عميلًا برقم دولي أولًا',true);return;}
    const form=modal('فتح محادثة عميل',`<label>العميل</label><select name="contact_id">${contactOptions()}</select><p class="footnote">فتح المحادثة لا يرسل رسالة تلقائيًا. بدء التواصل يحتاج قالب Meta معتمدًا.</p>`,'فتح المحادثة');
    bindForm(form,async(values)=>{const result=await api('/conversations','POST',Object.fromEntries(values));selectedConversation=result.id;chatMessages=await api(`/conversations/${result.id}/messages`);});return;
  }
  if(name==='toggle-rule'){const rule=data.automations.find(r=>r.id===id);await api('/automations/'+id,'PATCH',{active:!rule.active});await load();return;}
  if(name==='user'){
    const verification=await accountVerificationFields();
    const form=modal('حساب موظف جديد',`<label>اسم الموظف *</label><input name="name" required><label>البريد الإلكتروني *</label><input name="email" type="email" dir="ltr" required><label>الدور</label><select name="role">${selectOptions(roles,'agent')}</select><label>كلمة مرور الموظف — 12 حرفًا على الأقل</label><input name="password" type="password" minlength="12" maxlength="256" autocomplete="new-password" required>${verification}`);
    bindForm(form,values=>api('/users','POST',Object.fromEntries(values)));return;
  }
  if(name==='toggle-user'){
    const target=data.users.find(u=>u.id===id),verification=await accountVerificationFields();
    const form=modal((target.active?'إيقاف ':'تفعيل ')+escape(target.name),verification,'تأكيد');
    bindForm(form,values=>api('/users/'+id,'PATCH',{...Object.fromEntries(values),active:!target.active}));return;
  }
  if(name==='edit-user'){
    if(id===user.id){await advancedAction('change-password');return;}
    const target=data.users.find(u=>u.id===id),verification=await accountVerificationFields();
    const form=modal('صلاحيات '+escape(target.name),`<label>الدور</label><select name="role">${selectOptions(roles,target.role)}</select><label>كلمة مرور جديدة للموظف<input name="password" type="password" minlength="12" maxlength="256" autocomplete="new-password"></label><p class="footnote">اترك كلمة مرور الموظف فارغة للاحتفاظ بها. عند تغيير الصلاحيات أو كلمة المرور، تنتهي جلسات الموظف.</p>${verification}`);
    bindForm(form,values=>{const body=Object.fromEntries(values);if(!body.password)delete body.password;return api('/users/'+id,'PATCH',body);});return;
  }
  if(name==='invoice'){
    if(!data.contacts.length&&!data.invoiceContacts?.length){toast('يلزم وجود عميل أولًا',true);return;}
    const form=modal('فاتورة داخلية جديدة',`<div class="formgrid"><div><label>رقم الفاتورة *</label><input name="number" required placeholder="ME-2026-001"></div><div><label>العميل</label><select name="contact_id">${contactOptions()}</select></div><div><label>الإجمالي *</label><input name="amount" type="number" step="0.01" min="0.01" required></div><div><label>العملة</label><select name="currency">${selectOptions({EGP:'جنيه مصري',USD:'دولار أمريكي',SAR:'ريال سعودي'})}</select></div><div class="full"><label>بيان الخدمة *</label><textarea name="description" required></textarea></div><div><label>تاريخ الاستحقاق</label><input name="due_at" type="date"></div></div>`);
    bindForm(form,async(values)=>{const body=Object.fromEntries(values);body.amount_minor=Math.round(Number(body.amount)*100);delete body.amount;await api('/invoices','POST',body);});return;
  }
  if(name==='issue-invoice'){await api('/invoices/'+id,'PATCH',{status:'issued'});await load();toast('تم الإصدار الداخلي');return;}
  if(name==='payment'){
    const invoice=data.invoices.find(i=>i.id===id);const form=modal('إثبات دفعة مستلمة',`<p class="sub">المتبقي ${money(invoice.amount_minor-invoice.paid_minor,invoice.currency)}</p><label>المبلغ المستلم *</label><input name="amount" type="number" min="0.01" step="0.01" max="${(invoice.amount_minor-invoice.paid_minor)/100}" required><label>مرجع أو وسيلة التحصيل *</label><input name="reference" required placeholder="إيصال نقدي رقم…"><p class="footnote">هذا يسجل دفعة سبق استلامها؛ لا يسحب أموالًا من بنك أو بطاقة.</p>`);
    bindForm(form,async(values)=>api('/invoices/'+id+'/payments','POST',{amount_minor:Math.round(Number(values.get('amount'))*100),reference:values.get('reference')}));return;
  }
  if(name==='upload'){
    const file=$('#uploadfile')?.files?.[0];if(!file)throw new Error('اختر ملفًا أولًا');if(file.size>10*1024*1024)throw new Error('الملف أكبر من 10 ميجابايت');
    const content=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=reject;reader.readAsDataURL(file);});
    await api('/contacts/'+id+'/files','POST',{name:file.name,mime:file.type||'application/octet-stream',content});await loadFiles(id);toast('تم إرفاق الملف');return;
  }
}
document.addEventListener('click',async event=>{
  if(event.target.closest('[data-navigation-toggle]')){setNavigation(!navigationOpen);return;}
  if(event.target.closest('[data-navigation-close],[data-navigation-overlay]')){setNavigation(false,{restoreFocus:true});return;}
  const close=event.target.closest('[data-close]');if(close){$('#modal').close();return;}
  const target=event.target.closest('[data-page],[data-action],[data-task],[data-conversation]');if(!target)return;
  try{
    if(target.dataset.page){const fromDrawer=navigationOpen&&mobileNavigation();setNavigation(false);page=target.dataset.page;search='';await load();if(fromDrawer)focusCurrentPage();if(page==='audit'){const rows=await api('/audit');$('#auditpanel').innerHTML=rows.length?`<div class="tablewrap"><table><thead><tr><th>الوقت</th><th>المستخدم</th><th>الإجراء</th><th>السجل</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${new Date(r.created_at).toLocaleString('ar-EG')}</td><td>${escape(r.user_name||'النظام')}</td><td>${escape(r.action)}</td><td>${escape(r.entity)} <small class="mono">${escape(r.entity_id.slice(0,8))}</small></td></tr>`).join('')}</tbody></table></div>`:empty('لا توجد عمليات');}return;}
    if(target.dataset.action)await action(target.dataset.action,target.dataset.id);
    if(target.dataset.task){const t=data.tasks.find(t=>t.id===target.dataset.task);await api('/tasks/'+t.id,'PATCH',{status:t.status==='done'?'open':'done'});await load();}
    if(target.dataset.conversation){selectedConversation=target.dataset.conversation;chatMessages=await api(`/conversations/${selectedConversation}/messages`);render();}
  }catch(error){toast(error.message,true);}
});
document.addEventListener('keydown',event=>{
 if(!navigationOpen||!mobileNavigation()||$('#modal')?.open)return;
 if(event.key==='Escape'){event.preventDefault();setNavigation(false,{restoreFocus:true});return;}
 if(event.key!=='Tab')return;
 const items=[...$('#primary-navigation-sidebar').querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],summary,[tabindex]:not([tabindex="-1"])')].filter(el=>el.getClientRects().length&&!el.hidden),first=items[0],last=items.at(-1);if(!first)return;
 if(event.shiftKey&&(document.activeElement===first||!$('#primary-navigation-sidebar').contains(document.activeElement))){event.preventDefault();last.focus();}
 else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
});
if(typeof window!=='undefined')window.addEventListener('resize',()=>{if(!mobileNavigation())navigationOpen=false;syncNavigation();});
document.addEventListener('input',event=>{if(event.target.matches?.('[data-page-search]')&&!event.isComposing)applyPageSearch(event.target.value,event.target);});
document.addEventListener('compositionend',event=>{if(event.target.matches?.('[data-page-search],#search'))applyPageSearch(event.target.value,event.target);});
document.addEventListener('change',async event=>{
  try{if(event.target.matches?.('[data-record-date]')){await changeRecordDate(event.target.value,'[data-record-date]');return;}if(event.target.matches?.('[data-service-order]')){serviceOrder=event.target.value;render();$('[data-service-order]')?.focus();return;}if(event.target.dataset.studentFilter){studentRecords.change(event.target.dataset.studentFilter,event.target.value);return;}if(event.target.dataset.recordOrder){recordViews.order(event.target.dataset.recordOrder,event.target.value);render();return;}if(event.target.dataset.stage){await api('/leads/'+event.target.dataset.stage,'PATCH',{stage:event.target.value});await load();toast('تم تحديث المرحلة');}
    if(event.target.dataset.ticket){await api('/tickets/'+event.target.dataset.ticket,'PATCH',{status:event.target.value});await load();toast('تم تحديث التذكرة');}}
  catch(error){toast(error.message,true);await load();}
});
document.addEventListener('submit',async event=>{
  if(event.target.id==='composer'){
    event.preventDefault();const form=event.target,body=form.elements.body.value,button=form.querySelector('button');button.disabled=true;
    try{await api(`/conversations/${selectedConversation}/messages`,'POST',{kind:'text',body});chatMessages=await api(`/conversations/${selectedConversation}/messages`);render();toast('أضيفت إلى طابور الإرسال؛ راقب حالة التسليم');}catch(error){toast(error.message,true);}finally{button.disabled=false;}
  }
  if(event.target.id==='settingsform'){event.preventDefault();try{await api('/settings','PATCH',Object.fromEntries(new FormData(event.target)));await load();toast('تم حفظ الإعدادات');}catch(error){toast(error.message,true);}}
});
try{const setup=await api('/setup/status');if(setup.required&&setup.browser_setup)showSetup();else{const session=await api('/me');user=session.user;csrf=session.csrf;page=user.role==='accountant'?'finance':'dashboard';await load();startRefresh();}}catch{login();}

function appLabel(entity){return entity==='contact'?'ملف العميل':entity==='lead'?'فرصة البيع':data.apps.find(a=>a.id===entity)?.name || 'التطبيق';}
function entityOptions(value){return `<option value="contact" ${value==='contact'?'selected':''}>ملف العميل</option><option value="lead" ${value==='lead'?'selected':''}>فرصة البيع</option>`+data.apps.map(a=>`<option value="${a.id}" ${value===a.id?'selected':''}>${escape(a.name)}</option>`).join('');}
function advancedView(){
  const business=businessView();if(business!==null)return business;
  if(page==='studio'){
    const fields=fieldsFor(studioEntity);
    return heading('استوديو ميد إيست','ابنِ تطبيقاتك وحقولك والعلاقات بينها، ورتّب النماذج بنفسك.','تطبيق جديد','new-app')+
      `<div class="pillnav"><button class="${studioEntity==='contact'?'active':''}" data-action="studio-entity" data-id="contact">العملاء</button><button class="${studioEntity==='lead'?'active':''}" data-action="studio-entity" data-id="lead">الفرص</button>${data.apps.map(a=>`<button class="${studioEntity===a.id?'active':''}" data-action="studio-entity" data-id="${a.id}">${escape(a.name)}</button>`).join('')}</div>
      <div class="grid2"><div class="panel"><div class="panelhead"><h2>نموذج ${escape(appLabel(studioEntity))}</h2><button class="btn primary small" data-action="field">＋ إضافة حقل</button></div><p class="sub">اسحب الحقول لتغيير ترتيبها، أو استخدم الأسهم. الاسم والعنوان الأساسيان ثابتان في بداية النموذج.</p><div class="designer" data-entity="${studioEntity}">${fields.map((f,index)=>`<div class="fieldcard" draggable="true" data-field-id="${f.id}"><div><b>⠿ ${escape(f.label)}</b><small>${escape(f.field_key)} · ${escape(f.type)} ${f.type==='relation'?'← '+escape(appLabel(f.relation_target)):''}</small></div><div class="actions">${badge(f.required?'مطلوب':'اختياري',f.required?'amber':'')}<button class="btn small" data-action="field-up" data-id="${f.id}" aria-label="تحريك الحقل لأعلى" ${index===0?'disabled':''}>↑</button><button class="btn small" data-action="field-down" data-id="${f.id}" aria-label="تحريك الحقل لأسفل" ${index===fields.length-1?'disabled':''}>↓</button><button class="btn small" data-action="edit-field" data-id="${f.id}">تعديل</button></div></div>`).join('')||empty('أضف أول حقل','كل حقل يظهر فورًا في نموذج الإدخال')}</div>${!['contact','lead'].includes(studioEntity)?`<button class="btn" data-page="app:${studioEntity}">فتح سجلات التطبيق ←</button>`:''}</div><div class="panel"><h2>معاينة النموذج</h2><div class="fieldpreview"><label>عنوان السجل</label><input placeholder="العنوان الأساسي" disabled><div class="formgrid">${customInputs(studioEntity)}</div></div><p class="footnote">هذه معاينة شكلية. الحفظ الفعلي من صفحة التطبيق، مع التحقق من الحقول والصلاحيات على السيرفر.</p><button class="btn" data-action="pipeline">تسمية وترتيب مراحل البيع</button></div></div>`;
  }
  if(page.startsWith('app:')){
    const appId=page.slice(4),app=data.apps.find(a=>a.id===appId);if(!app)return empty('التطبيق غير متاح');
    if(app.app_key==='me_documents')return heading('مستندات الطلاب','فولدر مستقل لكل طالب، باسم الطالب ورقم ملفه.','إضافة سجل مستند','new-record')+sectionSearch('المستندات','اسم الطالب أو رقم الملف أو اسم المستند',search,studentRecords.documents(search));
    const all=data.appRecords.filter(r=>r.app_id===appId),admissions=app.app_key==='me_admissions',students=app.app_key==='me_students';
    const fields=fieldsFor(appId).slice(0,5),serviceField=fieldsFor(appId).find(f=>f.field_key==='requested_service');
    if(admissions&&serviceField&&!fields.includes(serviceField))fields.push(serviceField);
    const records=admissions?studentRecords.requests('admissions',all,search):students?filterRecordsBySearch(all,search,studentSearchTerms):filtered(all);
    const body=`<div class="panel">${admissions||students?`<p class="sub" role="status">${records.length} من ${all.length} ${students?'طالب':'طلب'}</p>`:''}${records.length?`<div class="tablewrap"><table><thead><tr><th>عنوان السجل</th>${fields.map(f=>`<th>${escape(f.label)}</th>`).join('')}<th>المسؤول</th><th></th></tr></thead><tbody>${records.map(r=>{const values=JSON.parse(r.data);return `<tr><td><b>${escape(r.name)}</b></td>${fields.map(f=>`<td>${escape(f.type==='relation'?(relationOptions(f.relation_target).find(v=>v.id===values[f.field_key])?.name||'غير متاح'):f.type==='boolean'?(values[f.field_key]?'نعم':'لا'):(values[f.field_key]??'—'))}</td>`).join('')}<td>${escape(personName(r.owner_id))}</td><td>${app.app_key==='me_students'?`<button type="button" class="btn small" data-action="student-folder" data-id="${escape(r.id)}">المستندات</button>`:''}<button class="linkbutton" data-action="edit-record" data-id="${r.id}">فتح السجل ←</button></td></tr>`;}).join('')}</tbody></table></div>`:empty(all.length?'لا توجد نتائج مطابقة':'التطبيق جاهز لأول سجل',all.length?'غيّر البحث أو امسح الفلاتر':'أضف حقوله من الاستوديو، ثم ابدأ التسجيل')}${isManager()?`<button class="btn small" data-action="design-app" data-id="${appId}">تصميم نموذج التطبيق</button>`:''}</div>`;
    return heading(escape(app.name),escape(app.description || 'سجلات تطبيقك المخصص، محفوظة بصلاحيات الموظفين.'),'سجل جديد','new-record')+(students?sectionSearch('الطلاب','اسم الطالب أو رقم الملف',search,body):(admissions?studentRecords.requestFilters('admissions',all):'')+body);
  }
  if(page==='integrations'){
    const wa=integration?.whatsapp;
    return heading('الربط والإعدادات','البيانات الحساسة تُحفظ مشفّرة على السيرفر، ولا تظهر بعد حفظها.')+`<div class="panel"><div class="panelhead"><h2>WhatsApp Cloud API</h2>${badge(wa?.configured?'الإعداد موجود — يلزم اختبار حي':'الإعداد غير مكتمل',wa?.configured?'amber':'')}</div>${user.role==='admin'?`<form id="wa-settings"><div class="formgrid"><div><label>معرف الرقم Phone Number ID</label><input name="phoneId" dir="ltr" value="${escape(wa?.phone_id||'')}"></div><div><label>حساب WhatsApp — WABA ID</label><input name="wabaId" dir="ltr" value="${escape(wa?.waba_id||'')}"></div><div><label>إصدار Graph المدعوم</label><input name="version" dir="ltr" placeholder="vNN.0" value="${escape(wa?.version||'')}"></div><div><label>موظف استقبال العملاء الجدد</label><select name="intakeUser"><option value="">اختر موظفًا</option>${data.users.filter(u=>u.active&&u.role!=='accountant').map(u=>`<option value="${u.id}" ${wa?.intake_user===u.id?'selected':''}>${escape(u.name)}</option>`).join('')}</select></div><div><label>Access Token ${wa?.token_set?'· محفوظ، اتركه فارغًا للاحتفاظ به':''}</label><input name="accessToken" type="password" autocomplete="new-password" dir="ltr"></div><div><label>App Secret ${wa?.app_secret_set?'· محفوظ':''}</label><input name="appSecret" type="password" autocomplete="new-password" dir="ltr"></div><div><label>Verify Token ${wa?.verify_token_set?'· محفوظ':''}</label><input name="verifyToken" type="password" autocomplete="new-password" dir="ltr"></div></div><label><input name="autoMedia" type="checkbox" ${wa?.auto_media?'checked':''}> تنزيل المرفقات الواردة تلقائيًا إلى ملف العميل (حتى 10 ميجابايت)</label><p class="footnote">اكتب أسرار الربط داخل نسختك المنشورة عبر HTTPS. الحقول السرية الفارغة تحتفظ بالقيمة السابقة. قد تتطلب Meta تحقق الحساب وصلاحيات وتفعيل وسيلة الدفع.</p><div class="actions"><button class="btn primary" type="submit">حفظ إعداد الربط</button><button class="btn" type="button" data-action="test-whatsapp">اختبار الاتصال</button></div></form>`:'<p class="sub">إدارة الأسرار متاحة لمالك النظام.</p>'}<div class="notebox" style="margin-top:20px">عنوان Webhook على نطاقك: <span class="mono">/webhooks/whatsapp</span><br>تسجيله والاشتراك في أحداث Meta خطوة خارجية تحتاج تفويض الحساب.</div></div><div class="panel"><div class="panelhead"><h2>قوالب واتساب</h2><button class="btn" data-action="sync-templates">مزامنة مع Meta</button></div>${data.templates.length?`<div class="tablewrap"><table><thead><tr><th>القالب</th><th>اللغة</th><th>التصنيف</th><th>الحالة</th></tr></thead><tbody>${data.templates.map(t=>`<tr><td class="mono">${escape(t.name)}</td><td>${escape(t.language)}</td><td>${escape(t.category)}</td><td>${badge(t.status,t.status==='APPROVED'?'green':'amber')}</td></tr>`).join('')}</tbody></table></div>`:empty('لم تُزامن القوالب','تُعرض هنا حالة اعتماد القالب بعد الربط والمزامنة')}</div>${user.role==='admin'?`<div class="panel"><h2>هوية الشركة</h2><form id="settingsform"><label>اسم الشركة</label><input name="company_name" value="${escape(data.settings.company_name||'ميد إيست')}"><button class="btn primary" style="margin-top:15px">حفظ الاسم</button></form></div><div class="panel"><h2>تصدير السجلات</h2><p class="sub">يشمل العملاء والفرص والتطبيقات المخصصة. الرسائل والملفات والأسرار المشفرة ضمن النسخة الكاملة للسيرفر.</p><a class="btn" href="/api/export">تنزيل JSON</a></div>`:''}`;
  }
  if(page==='security')return heading('أمان حسابك','غيّر كلمة مرورك وراجع المصادقة بخطوتين.')+`<section class="panel"><h2>كلمة المرور</h2><button type="button" class="btn primary" data-action="change-password">تغيير كلمة المرور</button></section><div class="panel"><h2>المصادقة بخطوتين</h2><p class="sub">${factorState?.enabled?'مفعّلة على حسابك.':'تحقق من الحالة، ثم فعّلها باستخدام تطبيق مصادقة على هاتفك.'}</p><div class="actions" style="margin-top:20px"><button class="btn" data-action="mfa-status">تحديث الحالة</button>${factorState?.enabled?'<button class="btn danger" data-action="mfa-disable">إيقاف المصادقة</button>':'<button class="btn primary" data-action="mfa-enroll">تفعيل المصادقة</button>'}</div><p class="footnote">احتفظ بمفتاح المصادقة في مكان آمن. استعادة فقدان الهاتف في هذا الإصدار تحتاج مسؤول السيرفر؛ لا توجد أكواد استرداد ذاتية بعد.</p></div>`;
  return null;
}
async function advancedAction(name,id){
  if(await omniAction(name,id))return true;
  if(await businessAction(name,id))return true;
  if(name==='studio-entity'){studioEntity=id;render();return true;}
  if(name==='design-app'){studioEntity=id;page='studio';render();return true;}
  if(name==='new-app'){
    const form=modal('تطبيق جديد',`<label>اسم التطبيق *</label><input name="name" required placeholder="ملفات الطلاب"><label>المعرف الإنجليزي *</label><input name="app_key" dir="ltr" pattern="[a-z][a-z0-9_]{1,49}" required placeholder="students"><label>وصف التطبيق</label><textarea name="description"></textarea>`);
    bindForm(form,async(values)=>{const app=await api('/studio/apps','POST',Object.fromEntries(values));studioEntity=app.id;});return true;
  }
  if(name==='new-record'||name==='edit-record'){
    const appId=page.slice(4),record=id?data.appRecords.find(r=>r.id===id):null;
    const form=modal(record?'تعديل السجل':'سجل جديد',`<label>عنوان السجل *</label><input name="name" value="${escape(record?.name||'')}" required>${isManager()?`<label>الموظف المسؤول</label><select name="owner_id">${data.users.filter(u=>u.active&&u.role!=='accountant').map(u=>`<option value="${u.id}" ${(record?.owner_id||user.id)===u.id?'selected':''}>${escape(u.name)}</option>`).join('')}</select>`:''}<div class="formgrid">${customInputs(appId,record?JSON.parse(record.data):(data.apps.find(a=>a.id===appId)?.app_key==='me_documents'?studentRecords.newDocumentValues():{}))}</div>`);
    bindForm(form,async(values,el)=>api('/apps/'+appId+'/records'+(record?'/'+record.id:''),record?'PATCH':'POST',{...Object.fromEntries(values),data:customValues(el,appId),...(record?{expected_updated_at:record.updated_at}:{})}));return true;
  }
  if(name==='field'){
    const form=modal('إضافة حقل للنموذج',`<div class="formgrid"><div><label>النموذج</label><select name="entity">${entityOptions(studioEntity)}</select></div><div><label>النوع</label><select name="type">${selectOptions({text:'نص',number:'رقم',date:'تاريخ',select:'قائمة',boolean:'نعم / لا',relation:'علاقة بسجل'})}</select></div><div><label>اسم الحقل *</label><input name="label" required></div><div><label>المعرف الإنجليزي *</label><input name="field_key" dir="ltr" pattern="[a-z][a-z0-9_]{1,49}" required></div><div class="full"><label>خيارات القائمة — سطر لكل اختيار</label><textarea name="options" rows="3"></textarea></div><div class="full"><label>التطبيق المرتبط — لحقل العلاقة فقط</label><select name="relation_target">${entityOptions('contact')}</select></div></div><label><input name="required" type="checkbox"> مطلوب عند حفظ السجل</label><p class="footnote">حقول العلاقات متاحة في التطبيقات التي تنشئها من الاستوديو.</p>`);
    bindForm(form,async(values,el)=>{const body=Object.fromEntries(values);body.options=body.options.split('\n').map(v=>v.trim()).filter(Boolean);body.required=el.elements.required.checked;const entity=body.entity;delete body.entity;if(['contact','lead'].includes(entity)){if(body.type==='relation')throw new Error('اختر تطبيقًا مخصصًا لإضافة حقل علاقة');body.entity=entity;await api('/studio/fields','POST',body);}else await api('/studio/apps/'+entity+'/fields','POST',body);studioEntity=entity;});return true;
  }
  if(name==='edit-field'){
    const field=fieldsFor(studioEntity).find(f=>f.id===id),form=modal('تعديل الحقل',`<label>الاسم</label><input name="label" value="${escape(field.label)}" required><label><input name="required" type="checkbox" ${field.required?'checked':''}> مطلوب</label><p class="footnote">نوع الحقل ومعرّفه ثابتان للحفاظ على البيانات المسجلة.</p>`);
    bindForm(form,async(values,el)=>api('/studio/fields/'+id,'PATCH',{label:values.get('label'),required:el.elements.required.checked,...(!['contact','lead'].includes(studioEntity)?{app_id:studioEntity}:{})}));return true;
  }
  if(name==='field-up'||name==='field-down'){
    const ids=fieldsFor(studioEntity).map(f=>f.id),index=ids.indexOf(id),target=index+(name==='field-up'?-1:1);if(target<0||target>=ids.length)return true;
    [ids[index],ids[target]]=[ids[target],ids[index]];await api('/studio/reorder','POST',{entity:studioEntity,ids});await load();return true;
  }
  if(name==='pipeline'){
    const form=modal('تسمية مراحل البيع وترتيبها',`<p class="sub">عدّل أسماء المراحل وترتيب عرضها. معرفات المراحل محفوظة لضمان سلامة السجلات.</p>${data.pipeline.map(p=>`<div class="formgrid"><div><label>${escape(p.stage_key)}</label><input name="label_${p.stage_key}" value="${escape(p.label)}" required></div><div><label>الترتيب</label><input name="position_${p.stage_key}" type="number" min="0" max="100" value="${p.position}" required></div></div>`).join('')}`);
    bindForm(form,async(values)=>api('/pipeline','PATCH',{stages:data.pipeline.map(p=>({stage_key:p.stage_key,label:values.get('label_'+p.stage_key),position:Number(values.get('position_'+p.stage_key))})).sort((a,b)=>a.position-b.position)}));return true;
  }
  if(name==='automation'){
    const form=modal('قاعدة متعددة الإجراءات',`<label>اسم القاعدة *</label><input name="name" required><div class="formgrid"><div><label>عند الحدث</label><select name="trigger">${selectOptions(triggers)}</select></div><div><label>تأخير التنفيذ بالدقائق</label><input name="delay_minutes" type="number" min="0" max="525600" value="0"></div><div><label>بشرط مرحلة فرصة — اختياري</label><select name="condition_stage"><option value="">أي مرحلة</option>${selectOptions(stages)}</select></div><div><label>بشرط مصدر العميل — اختياري</label><select name="source_condition"><option value="">أي مصدر</option><option value="whatsapp">واتساب</option><option value="manual">إضافة مباشرة</option></select></div></div><label><input name="do_assign" type="checkbox"> إسناد العميل أولًا إلى</label><select name="assign_user">${data.users.filter(u=>u.active&&u.role!=='accountant').map(u=>`<option value="${u.id}">${escape(u.name)}</option>`).join('')}</select><label><input name="do_task" type="checkbox" checked> إنشاء مهمة متابعة</label><input name="task_title" placeholder="عنوان المهمة" value="متابعة العميل"><label>موعد المهمة بعد كام ساعة من التنفيذ؟</label><input name="due_hours" type="number" min="0" max="8760" value="1"><label><input name="do_stage" type="checkbox"> تغيير مرحلة الفرصة</label><select name="new_stage">${selectOptions(stages)}</select>`);
    bindForm(form,async(values,el)=>{const actions=[];if(el.elements.do_assign.checked)actions.push({type:'assign',user_id:values.get('assign_user')});if(el.elements.do_task.checked)actions.push({type:'task',title:values.get('task_title'),due_hours:Number(values.get('due_hours'))});if(el.elements.do_stage.checked)actions.push({type:'stage',stage:values.get('new_stage')});if(!actions.length)throw new Error('اختر إجراءً واحدًا على الأقل');const conditions=values.get('source_condition')?[{field:'source',op:'eq',value:values.get('source_condition')}]:[];await api('/automations','POST',{name:values.get('name'),trigger:values.get('trigger'),condition_stage:values.get('condition_stage'),delay_minutes:Number(values.get('delay_minutes')),actions,conditions});});return true;
  }
  if(name==='workflow-jobs'){
    const jobs=await api('/automation-jobs');modal('سجل تنفيذ الأتمتة',jobs.length?jobs.map(j=>`<div class="fieldcard"><div><b>${escape(j.name)}</b><small>${new Date(j.due_at).toLocaleString('ar-EG')}</small></div>${badge(j.status,j.status==='done'?'green':j.status==='error'?'red':'')}</div>`).join(''):empty('لا توجد وظائف مجدولة'));
    $('#editor [type=submit]').remove();return true;
  }
  if(name==='test-whatsapp'){const result=await api('/integrations/whatsapp/test','POST',{});toast('نجح اتصال الحساب: '+(result.verified_name || result.display_phone_number || 'تم التحقق'));return true;}
  if(name==='sync-templates'){const result=await api('/whatsapp/templates/sync','POST',{});await load();toast('تمت مزامنة '+result.count+' قالب'+(result.has_more?'، توجد صفحات إضافية':'') );return true;}
  if(name==='download-media'){
    await api('/messages/'+id+'/media','POST',{});chatMessages=await api(`/conversations/${selectedConversation}/messages`);render();toast('حُفظ المرفق في ملف العميل');return true;
  }
  if(name==='send-file'){
    const conv=data.conversations.find(c=>c.id===selectedConversation),files=await api('/contacts/'+conv.contact_id+'/files');if(!files.length)throw new Error('ارفع الملف في ملف العميل أولًا');
    const form=modal('إرسال ملف من ملفات العميل',`<label>المرفق</label><select name="file_id">${files.map(f=>`<option value="${f.id}">${escape(f.name)}</option>`).join('')}</select><label>وصف اختياري</label><input name="caption" maxlength="1024"><p class="footnote">الإرسال يتطلب نافذة رد مفتوحة. حد الملفات في النظام 10 ميجابايت، وقد تفرض Meta حدودًا أقل على نوع معين.</p>`,'إرسال المرفق');
    bindForm(form,async(values)=>{await api(`/conversations/${selectedConversation}/files`,'POST',Object.fromEntries(values));chatMessages=await api(`/conversations/${selectedConversation}/messages`);});return true;
  }
  if(name==='template'){
    const approved=data.templates.filter(t=>t.status==='APPROVED');
    const form=modal('قالب WhatsApp',`${approved.length?`<label>القالب المعتمد</label><select name="cached_template"><option value="">إدخال اسم يدوي</option>${approved.map(t=>`<option value="${t.id}">${escape(t.name)} · ${escape(t.language)}</option>`).join('')}</select>`:''}<label>اسم القالب — عند الإدخال اليدوي</label><input name="template_name" dir="ltr"><label>اللغة</label><input name="language" value="ar" dir="ltr"><label>قيم متغيرات النص بالترتيب — متغير واحد في السطر</label><textarea name="parameters" rows="4" placeholder="اسم العميل&#10;رقم الطلب"></textarea><p class="footnote">الإدخال المبسط يدعم متغيرات نص BODY. القوالب التي تحتاج أزرارًا متغيرة أو وسائط تتطلب تجهيز متغيراتها في توسعة لاحقة. تأكد من موافقة العميل المناسبة قبل بدء التواصل.</p>`,'إضافة لطابور الإرسال');
    bindForm(form,async(values)=>{const cached=approved.find(t=>t.id===values.get('cached_template')),parameters=String(values.get('parameters')).split('\n').filter(v=>v.trim()).map(v=>({type:'text',text:v}));await api(`/conversations/${selectedConversation}/messages`,'POST',{kind:'template',template_name:cached?.name||values.get('template_name'),language:cached?.language||values.get('language'),components:parameters.length?[{type:'body',parameters}]:[]});chatMessages=await api(`/conversations/${selectedConversation}/messages`);});return true;
  }
  if(name==='change-password'){
    const verification=await accountVerificationFields();
    const form=modal('تغيير كلمة المرور',`${verification}
      <label>كلمة المرور الجديدة<input name="new_password" type="password" autocomplete="new-password" dir="ltr" minlength="12" maxlength="256" required></label>
      <label>تأكيد كلمة المرور الجديدة<input name="confirm_password" type="password" autocomplete="new-password" dir="ltr" minlength="12" maxlength="256" required></label>
      <p class="sub">بعد الحفظ، سجّل الدخول بالكلمة الجديدة. ستنتهي جلسات حسابك على الأجهزة الأخرى.</p>`,'تغيير كلمة المرور');
    bindForm(form,async values=>{
      const newPassword=values.get('new_password');
      if(newPassword!==values.get('confirm_password'))throw new Error('كلمتا المرور الجديدتان غير متطابقتين');
      await api('/security/password','POST',{current_password:values.get('current_password'),new_password:newPassword,code:values.get('code')});
      form.reset();$('#modal').close();recordMessenger.reset();user=null;csrf=null;
      login();toast('تم تغيير كلمة المرور. سجّل الدخول بالكلمة الجديدة.');
    });
    return true;
  }
  if(name==='mfa-status'){factorState=await api('/security/mfa');render();return true;}
  if(name==='mfa-enroll'){
    const first=modal('إعداد تطبيق المصادقة',currentPasswordField,'عرض مفتاح الإعداد');
    first.addEventListener('submit',async event=>{
      event.preventDefault();
      const submit=first.querySelector('[type=submit]');
      submit.disabled=true;
      try{
        const result=await api('/security/mfa/enroll','POST',Object.fromEntries(new FormData(first)));
        first.reset();$('#modal').close();
        const form=modal('تأكيد تطبيق المصادقة',`<p class="sub">أضف حسابًا يدويًا في تطبيق المصادقة باستخدام المفتاح التالي. اختَر رمزًا زمنيًا من ست خانات يتغير كل ثلاثين ثانية.</p><label>مفتاح الإعداد<input value="${escape(result.secret)}" readonly dir="ltr"></label>${currentPasswordField}${factorField}`,'تفعيل المصادقة');
        bindForm(form,values=>api('/security/mfa/confirm','POST',Object.fromEntries(values)));
      }catch(error){$('#modalerror').textContent=error.message;}
      finally{submit.disabled=false;}
    });
    return true;
  }
  if(name==='mfa-disable'){
    const form=modal('إيقاف المصادقة بخطوتين',currentPasswordField+factorField,'إيقاف المصادقة');
    bindForm(form,values=>api('/security/mfa/disable','POST',Object.fromEntries(values)));return true;
  }
  return false;
}
document.addEventListener('submit',async event=>{
  if(event.target.id!=='wa-settings')return;event.preventDefault();const form=event.target,button=form.querySelector('[type=submit]');button.disabled=true;
  try{const body=Object.fromEntries(new FormData(form));for(const key of Object.keys(body))if(body[key]==='')delete body[key];body.autoMedia=form.elements.autoMedia.checked;await api('/integrations/whatsapp','PATCH',body);await load();toast('حُفظت الإعدادات؛ اختبر الاتصال ثم أكمل Webhook في Meta');}catch(error){toast(error.message,true);}finally{button.disabled=false;}
});
document.addEventListener('dragstart',event=>{const field=event.target.closest('[data-field-id]');if(field&&isManager()){dragField=field.dataset.fieldId;event.dataTransfer.setData('text/plain',dragField);event.dataTransfer.effectAllowed='move';}});
document.addEventListener('dragover',event=>{if(event.target.closest('.designer')&&dragField)event.preventDefault();});
document.addEventListener('drop',async event=>{
  const target=event.target.closest('[data-field-id]');if(!target||!dragField||!isManager())return;event.preventDefault();
  const ids=fieldsFor(studioEntity).map(f=>f.id),from=ids.indexOf(dragField),to=ids.indexOf(target.dataset.fieldId);dragField=null;
  if(from<0||to<0||from===to)return;ids.splice(to,0,ids.splice(from,1)[0]);
  try{await api('/studio/reorder','POST',{entity:studioEntity,ids});await load();toast('تم حفظ ترتيب النموذج');}catch(error){toast(error.message,true);}
});
document.addEventListener('dragend',()=>dragField=null);

function businessView(){
  if(page==='quotes')return heading('عروض الأسعار','اعرض الخدمة وقيمتها، وسجّل موافقة العميل، ثم حوّلها لفاتورة.','عرض جديد','new-quote')+`<div class="notebox">تسجيل حالة الإرسال أو الموافقة هنا توثيق داخلي؛ لا يُرسل العرض تلقائيًا ولا يوقّع اتفاقًا نيابةً عن العميل.</div><div class="panel">${data.quotes?.length?`<div class="tablewrap"><table><thead><tr><th>العرض</th><th>العميل</th><th>القيمة</th><th>الحالة</th><th>الإجراء</th></tr></thead><tbody>${filtered(data.quotes).map(q=>`<tr><td><b>${escape(q.number)}</b><p class="sub">${escape(q.description)}</p></td><td>${escape(q.contact_name)}</td><td>${money(q.amount_minor,q.currency)}</td><td>${badge({draft:'مسودة',sent:'سُجل الإرسال',accepted:'موافقة مسجلة',rejected:'مرفوض',converted:'حُوّل لفاتورة'}[q.status],q.status==='accepted'||q.status==='converted'?'green':'')}</td><td><div class="actions">${isManager()?`<a class="btn small" href="/api/print/quote/${q.id}" target="_blank" rel="noopener">طباعة</a>`:'<span class="muted">الطباعة للإدارة</span>'}${q.status==='draft'?`<button class="btn small" data-action="quote-sent" data-id="${q.id}">تسجيل أنه أُرسل</button>`:q.status==='sent'?`<button class="btn small" data-action="quote-accept" data-id="${q.id}">تسجيل موافقة العميل</button>`:q.status==='accepted'&&canFinance()?`<button class="btn small primary" data-action="quote-invoice" data-id="${q.id}">تحويل لفاتورة</button>`:''}${['draft','sent'].includes(q.status)?`<button class="btn small" data-action="quote-reject" data-id="${q.id}">تسجيل الرفض</button>`:''}</div></td></tr>`).join('')}</tbody></table></div>`:empty('لا توجد عروض بعد','أنشئ العميل ثم أضف أول عرض خدمة')}</div>`;
  if(page==='operations')return heading('جاهزية التشغيل','فحص قاعدة البيانات والنسخ والطوابير؛ نجاحه لا يغني عن اختبار القناة الحقيقي.')+`<div class="panel"><h2>فحص الآن</h2><p class="sub">يعرض حالات التشغيل دون كلمات المرور أو محتوى العملاء أو التوكنات.</p><div class="actions" style="margin-top:20px"><button class="btn primary" data-action="run-doctor">تشغيل الفحص</button>${user.role==='admin'?'<button class="btn" data-action="education-workspace">تجهيز تطبيقات الطلاب</button><button class="btn" data-action="storage-check">التخزين والاستعادة</button>':''}</div><div id="doctor-result"></div></div><div class="notebox">قوالب التعليم تضيف الطلاب وطلبات القبول وسجل المستندات، بدون إنشاء سجلات طلاب أو استيراد بيانات. إعادة التجهيز لا تكرر التطبيقات والحقول.</div>`;
  return null;
}
async function loadNotes(id){const notes=await api('/contacts/'+id+'/notes');const target=$('#notelist');if(target)target.innerHTML=notes.map(n=>`<div class="fieldcard"><div><b>${escape(n.author)}</b><p class="sub" style="white-space:pre-wrap">${escape(n.body)}</p><small>${new Date(n.created_at).toLocaleString('ar-EG')}</small></div></div>`).join('')||'<p class="sub">لا توجد ملاحظات متابعة.</p>';}
async function businessAction(name,id){
  if(name==='new-quote'){
    if(!data.contacts.length&&!data.invoiceContacts?.length)throw new Error('أضف العميل أولًا');
    const form=modal('عرض سعر جديد',`<div class="formgrid"><div><label>رقم العرض *</label><input name="number" required placeholder="ME-Q-2026-001"></div><div><label>العميل</label><select name="contact_id">${contactOptions()}</select></div><div><label>قيمة العرض *</label><input name="amount" type="number" min="0.01" step="0.01" required></div><div><label>العملة</label><select name="currency">${selectOptions({EGP:'جنيه مصري',USD:'دولار أمريكي',SAR:'ريال سعودي'})}</select></div><div class="full"><label>بيان الخدمة *</label><textarea name="description" required rows="3"></textarea></div><div><label>ساري حتى</label><input name="valid_until" type="date"></div></div>`);
    bindForm(form,async values=>{const body=Object.fromEntries(values);body.amount_minor=Math.round(Number(body.amount)*100);delete body.amount;if(body.valid_until)body.valid_until=new Date(body.valid_until+'T23:59:59').toISOString();await api('/quotes','POST',body);});return true;
  }
  if(name==='quote-sent'||name==='quote-reject'){await api('/quotes/'+id,'PATCH',{status:name==='quote-sent'?'sent':'rejected'});await load();toast('تم تحديث السجل الداخلي');return true;}
  if(name==='quote-accept'){
    const form=modal('توثيق موافقة العميل',`<p class="sub">سجّل مرجع الموافقة التي استلمها فريقك. هذه الخطوة لا تنفذ توقيعًا إلكترونيًا.</p><label>مرجع الموافقة *</label><input name="acceptance_reference" required placeholder="رسالة بتاريخ… أو مستند موافقة…">`);
    bindForm(form,async values=>api('/quotes/'+id,'PATCH',{status:'accepted',acceptance_reference:values.get('acceptance_reference')}));return true;
  }
  if(name==='quote-invoice'){
    const form=modal('تحويل العرض إلى فاتورة داخلية',`<label>رقم الفاتورة *</label><input name="number" required placeholder="ME-2026-001"><p class="footnote">ينشئ فاتورة مسودة بنفس العميل والقيمة والعملة. لا ينفذ دفعًا أو إرسالًا تلقائيًا.</p>`);
    bindForm(form,async values=>api('/quotes/'+id+'/invoice','POST',{number:values.get('number')}));return true;
  }
  if(name==='add-note'){const body=$('#note-body').value;if(!body.trim())throw new Error('اكتب الملاحظة أولًا');await api('/contacts/'+id+'/notes','POST',{body});$('#note-body').value='';await loadCustomerWorkspace(id);toast('حُفظت ملاحظة المتابعة باسمك ووقتها');return true;}
  if(name==='save-consent'){await api('/contacts/'+id+'/preferences','PATCH',{whatsapp_opt_in:$('#wa-consent').checked});const contact=getContact(id);if(contact)contact.whatsapp_opt_in=$('#wa-consent').checked?1:0;toast('حُفظت حالة الموافقة');return true;}
  if(name==='education-workspace'){await api('/workspace/education','POST',{});await load();toast('تطبيقات الطلاب والقبول والمستندات جاهزة بدون بيانات طلاب');return true;}
  if(name==='storage-check'){
    const r=await api('/operations/storage'),rows=[['قاعدة البيانات',r.database.path],['داخل القرص المخصص',r.storage.database_under_mount?'نعم':'غير متحقق'],['المفتاح داخل القرص',r.storage.key_under_mount?'نعم':'غير متحقق'],['مجلد النسخ داخل القرص',r.storage.backups_under_mount?'نعم':'غير متحقق'],['المساحة المتاحة',r.storage.verified?Math.round(r.storage.available_bytes/1024**2)+' MB':'غير متحقق'],['تشفير النسخ مضبوط',r.backup.encrypted_configured?'نعم':'غير مضبوط'],['آخر نسخة محلية',r.backups.last_at||'غير متحقق'],['آخر نسخة خارجية مؤكدة',r.backups.offsite_last_at||'غير متحقق'],['حالة النسخ',r.backups.last_error||r.backups.status],['وضع الاستعادة',r.recovery_mode?'مفعّل — الإرسال الخارجي متوقف':'غير مفعّل']];
    const form=modal('التخزين والاستعادة','<div class="tablewrap"><table><tbody>'+rows.map(([k,v])=>'<tr><th>'+escape(k)+'</th><td>'+escape(v)+'</td></tr>').join('')+'</tbody></table></div><p class="footnote">هذا فحص للحالة والإعداد، وليس اختبار استعادة. وجود مفتاح عام لا يثبت نجاح نسخة خارجية؛ اعتمد تاريخ الإقرار واختبار استعادة منفصل.</p>','إغلاق');form.addEventListener('submit',event=>{event.preventDefault();document.querySelector('#modal').close();});return true;
  }
  if(name==='run-doctor'){
    const report=await api('/operations'),target=$('#doctor-result');
    target.innerHTML=`<div class="metrics" style="margin-top:25px"><article class="metric"><span>سلامة قاعدة البيانات</span><strong>${escape(report.database.integrity)}</strong><small>أخطاء العلاقات: ${report.database.foreign_key_errors}</small></article><article class="metric"><span>عمر آخر نسخة دورية</span><strong>${report.backups.age_hours===null?'—':Math.round(report.backups.age_hours)+' س'}</strong><small>${report.backups.last_at?new Date(report.backups.last_at).toLocaleString('ar-EG'):'لم تُسجل نسخة دورية بعد'}</small></article><article class="metric"><span>إعداد واتساب</span><strong>${report.whatsapp.configuration_present?'موجود':'ناقص'}</strong><small>يحتاج اختبارًا حيًا قبل الاعتماد</small></article><article class="metric"><span>إصدار قاعدة البيانات</span><strong>${report.database.schema_version}</strong><small>فحص محلي — لا يؤكد النشر العام</small></article></div><h2>حالات الطوابير</h2>${Object.entries(report.queues).map(([name,counts])=>`<div class="fieldcard"><b>${escape(name)}</b><div class="actions">${Object.entries(counts).map(([state,count])=>badge(state+': '+count,state==='error'||state==='failed'?'red':state==='done'?'green':'')).join('')||'فارغ'}</div></div>`).join('')}`;return true;
  }
  return false;
}

function showSetup(){
  $('#app').innerHTML=`<main class="login"><div class="loginart"><div class="brand"><div class="brandmark">م</div><div><b>ميد إيست</b><small>BUSINESS WORKSPACE</small></div></div><h1>مساحة عملك<br>تبدأ من هنا.</h1><p>جهز حساب المالك. بعد أول تهيئة، تُغلق هذه الخطوة تلقائيًا.</p></div><div class="loginform"><form id="owner-setup"><h2>تجهيز حساب المالك</h2><p class="sub">رمز التهيئة متاح لك في إعدادات استضافتك. لا توجد كلمة مرور افتراضية.</p><label>رمز التهيئة من حساب الاستضافة</label><input name="token" type="password" required autocomplete="off"><label>اسم المالك</label><input name="name" required><label>البريد الإلكتروني</label><input name="email" type="email" required autocomplete="username"><label>كلمة المرور — 12 حرفًا على الأقل</label><input name="password" type="password" minlength="12" required autocomplete="new-password"><label>تأكيد كلمة المرور</label><input name="confirm" type="password" minlength="12" required autocomplete="new-password"><div class="formerror" id="setup-error"></div><button class="btn primary" type="submit">إنشاء حسابي</button></form></div></main>`;
  $('#owner-setup').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget,values=Object.fromEntries(new FormData(form)),button=form.querySelector('button');if(values.password!==values.confirm){$('#setup-error').textContent='كلمتا المرور غير متطابقتين';return;}delete values.confirm;button.disabled=true;try{await api('/setup','POST',values);login();toast('تم تجهيز حساب المالك؛ سجّل الدخول');}catch(error){$('#setup-error').textContent=error.message;}finally{button.disabled=false;}});
}

function omniView(){
  const h=hubState||{},links=h.links||{},channels=h.channels||[],registrations=h.registrations||[],replies=h.replies||[];
  const registrationRows=studentRecords.requests('registrations',registrations,search);
  if(page==='dashboard'){
    const open=data.tasks.filter(t=>t.status==='open'),active=data.leads.filter(l=>!['won','lost'].includes(l.stage)),ready=channels.filter(c=>c.state==='receiving'||c.state==='verified').length;
    const enquiries=h.enquiries||[];
    const overdue=enquiries.filter(q=>q.task_status==='open'&&Date.parse(q.due_at)<Date.now()).length;
    const enquiryRows=enquiries.slice(0,25).map(q=>'<div class="omni-source-row"><div><b>'+escape(q.name)+'</b> · '+escape(q.service)+'<p class="sub">'+escape(sourceName(q.source))+(q.campaign?' · '+escape(q.campaign):'')+' · '+escape(q.reference)+'</p><p>'+escape(q.notes)+'</p></div><div><small>'+escape(personName(q.owner_id))+' · '+escape(date(q.due_at))+'</small><button class="btn small" data-action="edit-lead" data-id="'+escape(q.lead_id)+'">فتح الفرصة</button>'+(q.registered?badge('تم التسجيل','green'):['won','lost'].includes(q.stage)?'':'<button class="btn small" data-action="enquiry-registration-link" data-id="'+escape(q.lead_id)+'">رابط استكمال التقديم</button>')+'</div></div>').join('');
    return '<div class="omni-hero"><div><div class="eyebrow">MIDDLE EAST · GROWTH WORKSPACE</div><h1>مكتبك كله.<br>في مسار واحد.</h1><p>كل تسجيل له ملف، وكل عميل له مسؤول، وكل خطوة لها متابعة واضحة.</p><span class="omni-mini">بوابة تسجيل مباشرة + إدارة عملاء + مركز قنوات</span></div><div class="actions"><a class="btn primary" href="/apply" target="_blank" rel="noopener">فتح بوابة التسجيل ↗</a><button class="btn" data-page="hub">إدارة القنوات</button></div></div>'+
      '<div class="metrics">'+[[registrations.length,'تسجيلات البوابة','مرتبطة بالطلاب والملفات'],[data.contacts.length,'إجمالي العملاء','أرقام موحدة وإسناد للفريق'],[active.length,'فرص نشطة','من الاستفسار للتعاقد'],[open.length,'مهام مفتوحة','متابعة مرتبطة بالعميل']].map(([count,label,note])=>'<article class="metric"><span>'+label+'</span><strong>'+count.toLocaleString('ar-EG')+'</strong><small>'+note+'</small></article>').join('')+'</div>'+
      '<div class="panel"><div class="panelhead"><h2>الاستفسارات السريعة</h2><a class="btn" href="/enquire" target="_blank" rel="noopener">فتح نموذج الاستفسار ↗</a></div><p class="sub">'+enquiries.length+' ضمن أحدث ٥٠٠ استفسار · '+overdue+' متأخر عن موعد المتابعة</p>'+enquiryRows+'</div>'+
      '<div class="omni-flow"><div><i>01 / ACQUIRE</i><b>الموقع والسوشيال</b><small>روابط تسجيل بمصدر واضح</small></div><div><i>02 / ORGANIZE</i><b>ملف الطالب تلقائيًا</b><small>عميل، فرصة، مستند ومهمة</small></div><div><i>03 / CONNECT</i><b>التواصل والمتابعة</b><small>قوالب ومحادثات وصلاحيات</small></div><div><i>04 / DELIVER</i><b>إتمام الخدمة</b><small>قبول ومستندات وعروض وتحصيل</small></div></div>'+
      '<div class="grid2"><div class="panel"><div class="panelhead"><h2>أولوية اليوم</h2><button class="linkbutton" data-page="tasks">كل المهام ←</button></div>'+(open.length?open.slice(0,5).map(taskRow).join(''):empty('جاهزين لأول طلب','شارك رابط التسجيل؛ الملف والمتابعة يتجهزوا تلقائيًا','✓'))+'</div><div class="panel"><div class="panelhead"><h2>مركز التشغيل</h2><button class="linkbutton" data-page="lab">جرّب المسار ←</button></div><div class="omni-source-row"><span>بوابة التسجيل المستقلة</span>'+badge(h.settings?.enabled?'جاهزة للاستقبال':'متوقفة',h.settings?.enabled?'green':'')+'</div><div class="omni-source-row"><span>فيسبوك وإنستجرام</span>'+badge(ready+' / 2 حسابات تم التحقق منها',ready===2?'green':'amber')+'</div><div class="omni-source-row"><span>WhatsApp API</span>'+badge(h.whatsapp?.configured?'الإعداد موجود':'يحتاج إعداد Meta',h.whatsapp?.configured?'green':'amber')+'</div><div class="actions" style="margin-top:23px"><button class="btn" data-page="registrations">التسجيلات والملفات</button><button class="btn" data-page="templates">الردود والقوالب</button></div></div></div>';
  }
  if(page==='hub'){
    const settings=h.settings||{};
    return heading('مركز القنوات','من أول زيارة لملف طالب قابل للمتابعة. حالة كل قناة ظاهرة كما هي.')+
      '<div class="omni-grid"><article class="channel-card"><span class="channel-symbol">↗</span><h3>الموقع وبوابة التسجيل</h3>'+badge(settings.enabled?'البوابة تعمل':'التسجيل متوقف',settings.enabled?'green':'')+'<p>رابط مستقل يستقبل الطلب ويولّد ملف التسجيل ومهمة المتابعة تلقائيًا.</p><a class="omni-url" href="'+escape(links.website||'/apply')+'" target="_blank" rel="noopener">'+escape(links.website||'/apply')+'</a><div class="actions"><button class="btn small" data-action="intake-settings">إعداد التسجيل</button><button class="btn small" data-action="website-connect">ربط الموقع</button></div></article>'+
      channels.map(c=>'<article class="channel-card"><span class="channel-symbol '+c.channel+'">'+(c.channel==='facebook'?'f':'◎')+'</span><h3>'+(c.channel==='facebook'?'Facebook Messenger':'Instagram Direct')+'</h3>'+badge(({disabled:'بحاجة لربط الحساب',needs_setup:'إعداد محفوظ — لم يُتحقق',verified:'تم التحقق من الحساب',receiving:'استقبل حدثًا حقيقيًا'})[c.state]||'يحتاج إعداد',c.verified_at?'green':'amber')+'<p>استقبال الرسائل في ملف العميل، مع رد ترحيب اختياري ورابط تسجيل بمصدر القناة.</p><span class="omni-url">'+escape(links[c.channel]||'')+'</span><div class="actions"><button class="btn small" data-action="channel-settings" data-id="'+c.channel+'">إعداد الربط</button><button class="btn small" data-action="channel-test" data-id="'+c.channel+'">اختبار الحساب</button></div></article>').join('')+'</div>'+
      '<div class="grid2"><div class="panel"><div class="panelhead"><h2>WhatsApp Cloud API</h2>'+badge(h.whatsapp?.configured?'الإعداد موجود':'غير مربوط بعد',h.whatsapp?.configured?'green':'amber')+'</div><p class="sub">نفس ملف العميل والمرفقات والقوالب. تأكيد التسجيل الآلي يحتاج موافقة وقالبًا معتمدًا بمحتوى مناسب.</p><div class="actions"><button class="btn primary" data-page="integrations">إعداد API والقوالب</button><button class="btn" data-page="inbox">صندوق واتساب</button></div><p class="footnote">الرابط: '+escape(links.whatsapp_webhook||'')+'</p></div><div class="panel"><h2>روابط المصادر الجاهزة</h2>'+['facebook','instagram','whatsapp'].map(c=>'<div class="omni-source-row"><b>'+({facebook:'فيسبوك',instagram:'إنستجرام',whatsapp:'واتساب'})[c]+'</b><a class="linkbutton" href="'+escape(links[c]||'/apply')+'" target="_blank" rel="noopener">فتح رابط التسجيل ↗</a></div>').join('')+'<p class="footnote">تغيير زر صفحة خارجية أو اشتراكات Webhook يتطلب تفويض تلك الصفحة. تجهيز الرابط لا يعني أنه نُشر عليها.</p></div></div>'+
      (user.role==='admin'?'<div class="panel"><div class="panelhead"><h2>واجهة API للموقع والأنظمة</h2><button class="btn" data-action="create-api-key">إنشاء مفتاح</button></div><span class="omni-url">POST '+escape(links.api||'/api/external/registrations')+'</span><p class="sub">مفتاح محدود بإنشاء التسجيلات فقط. يُستخدم من سيرفر الموقع؛ لا يوضع في كود الصفحة العام.</p>'+(h.keys||[]).map(k=>'<div class="omni-source-row"><span><b>'+escape(k.name)+'</b><small class="mono"> · '+escape(k.prefix)+'…</small></span><div class="actions">'+badge(k.active?'نشط':'موقوف',k.active?'green':'')+(k.active?'<button class="btn small" data-action="revoke-api-key" data-id="'+k.id+'">إيقاف</button>':'')+'</div></div>').join('')+'</div>':'');
  }
  if(page==='registrations')return heading('التسجيلات والملفات','كل طلب وصل من البوابة، ومصدره، وملف تسجيله وحالة رسالة التأكيد.')+
    '<div class="panel"><div class="panelhead"><h2>'+registrationRows.length+' من '+registrations.length+' طلب مسجل</h2><a class="btn primary" href="/apply" target="_blank" rel="noopener">فتح بوابة الطالب ↗</a></div>'+studentRecords.requestFilters('registrations',registrations)+(registrationRows.length?'<div class="tablewrap"><table><thead><tr><th>الطالب والمرجع</th><th>المصدر</th><th>المسؤول</th><th>تأكيد واتساب</th><th>ملف التسجيل</th></tr></thead><tbody>'+registrationRows.map(r=>'<tr><td><b>'+escape(r.student_name||r.name)+'</b><div class="sub mono">'+escape(r.reference)+'</div><div class="sub">'+escape(r.requested_service||'طلب دراسي')+'</div><div class="sub mono">'+escape(r.phone)+'</div></td><td>'+badge(sourceName(r.source))+'<small class="sub">'+escape(r.campaign)+'</small></td><td>'+escape(personName(r.owner_id))+'</td><td>'+badge(deliveryName(r.message_status||r.delivery_status),r.delivery_status==='blocked'?'amber':'')+(r.delivery_reason?'<small class="sub">'+escape(deliveryReason(r.delivery_reason))+'</small>':'')+(r.delivery_status==='blocked'&&user.role==='admin'?'<button class="linkbutton" data-action="retry-intake" data-id="'+r.id+'">إعادة التجهيز بعد الربط</button>':'')+'</td><td><a class="btn small" href="/api/files/'+r.file_id+'">ملف التسجيل</a><button class="btn small" data-action="student-folder" data-id="'+escape(r.student_id)+'">فولدر الطالب</button><button class="btn small" data-action="intake-files" data-id="'+r.id+'">ملفات الطلب</button><button class="linkbutton" data-action="edit-contact" data-id="'+r.contact_id+'">ملف العميل</button></td></tr>').join('')+'</tbody></table></div>':empty(registrations.length?'لا توجد نتائج مطابقة':'أول تسجيل هيظهر هنا',registrations.length?'غيّر البحث أو امسح الفلاتر':'بيانات التجربة الافتراضية لا تُضاف إلى هذه القائمة'))+'</div>';
  if(page==='social'){
    const selected=(h.threads||[]).find(t=>t.id===selectedSocial);
    return heading('محادثات السوشيال','رسائل فيسبوك وإنستجرام مرتبطة بالعميل والموظف المسؤول.')+'<div class="actions" style="margin-bottom:20px"><button class="btn" data-page="inbox">صندوق واتساب ←</button><button class="btn" data-page="hub">إدارة الحسابات</button></div><div class="social-layout"><aside class="social-threads">'+((h.threads||[]).map(t=>'<button class="'+(selectedSocial===t.id?'active':'')+'" data-action="social-thread" data-id="'+t.id+'"><b>'+escape(t.name)+'</b> '+badge(sourceName(t.channel))+'<small>'+escape(t.preview)+'</small></button>').join('')||empty('لا محادثات بعد','تظهر الرسائل بعد تفويض الحساب وتفعيل Webhook'))+'</aside><div class="social-chat">'+(selected?'<div class="panelhead"><h2>'+escape(selected.name)+'</h2><button class="btn small" data-action="edit-contact" data-id="'+selected.contact_id+'">ملف العميل</button></div><div class="social-history">'+socialMessages.map(m=>'<div class="social-bubble '+(m.direction==='out'?'out':'')+'">'+escape(m.body)+'<small>'+escape(deliveryName(m.status))+' · '+new Date(m.created_at).toLocaleString('ar-EG')+(m.error_code?' · '+escape(m.error_code):'')+'</small></div>').join('')+'</div><textarea id="social-body" rows="3" maxlength="1000" placeholder="اكتب ردك…"></textarea><div class="actions" style="margin-top:12px"><button class="btn primary" data-action="social-send">إرسال الرد</button><button class="btn" data-action="social-insert-reply">إدراج رد جاهز</button></div><p class="footnote">الرد هنا ضمن نافذة 24 ساعة. قبول Meta للطلب يختلف عن تأكيد التسليم. المرفقات غير النصية تُراجع في القناة الأصلية.</p>':empty('كل محادثة في سياقها','اختار محادثة لعرض الرسائل وملف العميل','◉'))+'</div></div>';
  }
  if(page==='templates')return heading('الردود والقوالب','مكتبة ردود داخلية قابلة للتعديل، بجانب قوالب واتساب المعتمدة.','إضافة رد','new-reply')+
    '<div class="lab-banner">الردود دي جاهزة للاستخدام داخل الفريق. اعتماد قوالب واتساب يتم من Meta، ولا يتحقق بمجرد حفظ رد هنا.</div><div class="omni-grid">'+replies.map(t=>'<article class="reply-card">'+badge(t.category)+'<h3>'+escape(t.name)+'</h3><p>'+escape(t.body)+'</p><button class="btn small" data-action="edit-reply" data-id="'+t.id+'">تعديل الرد</button></article>').join('')+'</div><div class="panel"><h2>تأكيد التسجيل على واتساب</h2><p class="sub">اربط قالبًا معتمدًا بمتغيرات اسم الطالب ورقم التسجيل ورابط الملف، بالترتيب المطابق لقالبك.</p><div class="actions"><button class="btn primary" data-action="intake-settings">اختيار قالب التأكيد</button><button class="btn" data-page="integrations">مزامنة قوالب Meta</button></div></div>';
  if(page==='lab'){
    const latest=(h.lab_runs||[])[0]?.result;
    return heading('المختبر الافتراضي','اختبار المسار كله في قاعدة مؤقتة معزولة؛ تقرير النتيجة فقط يتحفظ.','تشغيل التجربة الكاملة','run-lab')+'<div class="lab-banner"><b>محاكاة واضحة، من غير إرسال خارجي.</b><br>التجربة لا تستخدم توكناتك ولا تضيف طلابًا أو فواتير لبيانات الشركة. نجاحها يختبر التنفيذ، ويُعرض الربط الحقيقي من مركز القنوات.</div><div class="omni-flow">'+['تسجيل من فيسبوك','إنشاء ملف الطالب','قالب تأكيد واتساب','رسائل وترحيب القنوات'].map((v,i)=>'<div><i>0'+(i+1)+'</i><b>'+v+'</b><small>بيانات اصطناعية معزولة</small></div>').join('')+'</div>'+(latest?'<div class="panelhead"><h2>آخر نتيجة</h2>'+badge(latest.passed?'اجتازت المحاكاة':'تحتاج مراجعة',latest.passed?'green':'amber')+'</div><p class="sub">'+new Date(latest.checked_at).toLocaleString('ar-EG')+' · عدد الاتصالات الخارجية: '+latest.external_network_calls+'</p><div class="lab-checks">'+latest.checks.map(c=>'<div class="lab-check"><span class="checkmark">'+(c.passed?'✓':'!')+'</span><div><b>'+escape(c.name)+'</b><small>'+escape(c.detail||'اجتاز الفحص في قاعدة التجربة')+'</small></div></div>').join('')+'</div>':empty('جرّب النظام من أول تسجيل لآخر متابعة','اضغط تشغيل التجربة، وشوف نتيجة كل خطوة بشكل واضح','⚡'));
  }
  return null;
}
function sourceName(value){return ({website:'الموقع',facebook:'فيسبوك',instagram:'إنستجرام',whatsapp:'واتساب',google_sites:'Google Sites',google_forms:'Google Forms',google_business:'Google Business Profile',api:'API',manual:'يدوي'})[value]||value;}
function deliveryName(value){return ({pending:'بانتظار التجهيز',not_requested:'لم يُطلب',blocked:'بحاجة لإعداد',queued:'في طابور الإرسال',accepted:'قبلتها Meta',delivered:'تم التسليم',read:'مقروءة',received:'واردة',failed:'تعذر الإرسال',unknown:'نتيجة غير مؤكدة',sent:'أُرسلت'})[value]||value;}
function deliveryReason(value){return ({WHATSAPP_NOT_CONFIGURED:'ربط واتساب غير مكتمل',APPROVED_TEMPLATE_REQUIRED:'يلزم اختيار قالب معتمد',CONSENT_REQUIRED:'موافقة التواصل غير متاحة',TEMPLATE_VARIABLES_MISMATCH:'ترتيب المتغيرات لا يطابق القالب',TEMPLATE_NEEDS_OTHER_COMPONENTS:'القالب يحتاج وسائط أو أزرار متغيرة',TEMPLATE_REVIEW_PENDING:'في انتظار مراجعة قالب واتساب؛ المتابعة تلقائية',QUEUE_REJECTED:'راجع إعدادات القالب والقناة'})[value]||value;}
async function omniAction(name,id){
  const h=hubState||{},settings=h.settings||{},links=h.links||{};
  if(name==='classify-intake-document'){const form=modal('تصنيف المستند','<label>نوع المستند<select name="document_type">'+['جواز السفر','الشهادة الدراسية','شهادة الميلاد','كشف الدرجات','صورة شخصية','مستند آخر'].map(t=>'<option>'+t+'</option>').join('')+'</select></label>');bindForm(form,async(_,f)=>{await api('/communication/documents/'+encodeURIComponent(id),'PATCH',{document_type:f.elements.document_type.value});});return true;}
  if(name==='intake-files'){
    const files=await api('/intake/'+encodeURIComponent(id)+'/files'),registration=(h.registrations||[]).find(r=>r.id===id);
    const form=modal('مستندات الطلب '+escape(registration?.reference||''),'<p class="sub">الملفات مرتبطة بالطلب والعميل، وتخضع لصلاحية الموظف المسؤول.</p>'+files.map(f=>'<div class="fileline"><a href="/api/files/'+escape(f.id)+'">'+escape(f.name)+'</a><small>'+escape(f.document_type||'مستند آخر')+' · '+Math.ceil(f.size/1024)+' KB</small><button type="button" class="btn small" data-action="classify-intake-document" data-id="'+escape(f.document_id)+'">تصنيف</button></div>').join(''));
    form.addEventListener('submit',event=>event.preventDefault());form.querySelector('.modalfoot')?.remove();return true;
  }
  if(name==='run-lab'){toast('بنختبر التسجيل والقنوات داخل مساحة معزولة…');const result=await api('/lab/run','POST',{});await load();toast(result.passed?'كل فحوص المحاكاة نجحت':'راجع نتيجة الفحص',!result.passed);return true;}
  if(name==='intake-settings'){
    if(user.role!=='admin')throw new Error('إعداد البوابة للمالك');
    const form=modal('التسجيل والتأكيد التلقائي','<label><input type="checkbox" name="enabled" '+(settings.enabled?'checked':'')+'> استقبال التسجيلات الجديدة</label><label>الموظف المسؤول عن التسجيلات الجديدة</label><select name="intake_user">'+data.users.filter(u=>u.active&&u.role!=='accountant').map(u=>'<option value="'+u.id+'" '+((settings.intake_user||data.users.find(v=>v.role==='admin')?.id)===u.id?'selected':'')+'>'+escape(u.name)+'</option>').join('')+'</select><label>عنوان موقع الشركة</label><input name="website" dir="ltr" type="url" value="'+escape(settings.website||'https://mideastedu-eg.com')+'"><label>قالب تأكيد واتساب المعتمد</label><select name="welcome_template"><option value="">لا قالب محدد — يظل الإرسال محجوبًا</option>'+(h.whatsapp?.approved_templates||[]).map(t=>'<option value="'+escape(t.name)+'" '+(settings.welcome_template===t.name?'selected':'')+'>'+escape(t.name)+' · '+escape(t.language)+'</option>').join('')+'</select><label>لغة القالب</label><input name="welcome_language" value="'+escape(settings.welcome_language||'ar')+'" dir="ltr"><label>متغيرات BODY بالترتيب، مفصولة بفواصل</label><input name="welcome_slots" dir="ltr" value="'+escape((settings.welcome_slots||['name','reference','receipt_url']).join(','))+'"><p class="footnote">الأسماء المتاحة: name، reference، receipt_url. للقالب بدون متغيرات اترك الحقل فارغًا. لا يتم إرسال ملف أو رسالة بدون موافقة الطالب.</p><label><input type="checkbox" name="whatsapp_auto_reply" '+(settings.whatsapp_auto_reply?'checked':'')+'> رد آلي ترحيبي عند أول رسالة واتساب مع رابط التسجيل</label><label><input type="checkbox" name="whatsapp_status_lookup" '+(settings.whatsapp_status_lookup===true?'checked':'')+'> تلخيص حالة الملف على واتساب لرقم الطالب أو ولي الأمر المسجل فقط</label><p class="footnote">متوقف افتراضيًا. يحتاج تفعيل الرد الآلي أعلاه؛ عند تعدد الطلاب يطلب رقم الملف. لا يرسل مستندات أو أرقام هوية، ولا يعرض ملفًا من الاسم وحده على فيسبوك أو إنستجرام.</p><label><input type="checkbox" name="social_auto_reply" '+(settings.social_auto_reply?'checked':'')+'> رد آلي ترحيبي لأول رسالة من فيسبوك/إنستجرام بعد الربط</label>');
    bindForm(form,async(values,el)=>{const body=Object.fromEntries(values);body.enabled=el.elements.enabled.checked;body.social_auto_reply=el.elements.social_auto_reply.checked;body.whatsapp_auto_reply=el.elements.whatsapp_auto_reply.checked;body.whatsapp_status_lookup=el.elements.whatsapp_status_lookup.checked;body.welcome_slots=body.welcome_slots.split(',').map(s=>s.trim()).filter(Boolean);await api('/intake/settings','PATCH',body);});return true;
  }
  if(name==='website-connect'){
    modal('ربط الموقع الحالي','<p class="sub">وجه زر «قدم الآن» لرابط البوابة، أو أضف الكود التالي في الموقع لربط روابط التسجيل الحالية تلقائيًا. لم يُنشر هذا التغيير على Wuilt تلقائيًا.</p><label>رابط التسجيل</label><input readonly dir="ltr" value="'+escape(links.website||'')+'"><label>كود ربط الروابط الحالية</label><textarea rows="3" readonly dir="ltr">'+escape('<script defer src="'+(links.connect_script||'')+'"></script>')+'</textarea><label>تضمين النموذج داخل صفحة تسجيل</label><textarea rows="3" readonly dir="ltr">'+escape('<iframe src="'+(links.website||'')+'" title="التسجيل مع ميد إيست" style="width:100%;min-height:1100px;border:0"></iframe>')+'</textarea><p class="footnote">مفتاح API مخصص للربط من السيرفر، ولا يوضع في كود المتصفح.</p>','إغلاق');
    $('#editor').addEventListener('submit',e=>{e.preventDefault();$('#modal').close();});return true;
  }
  if(name==='channel-settings'){
    if(user.role!=='admin')throw new Error('ربط الحسابات للمالك');const channel=(h.channels||[]).find(c=>c.channel===id);
    const form=modal('ربط '+sourceName(id),'<p class="sub">'+(id==='instagram'?'لحساب Instagram احترافي مرتبط بصفحة، باستخدام Facebook Login.':'استخدم Page Access Token بصلاحيات الرسائل المعتمدة.')+'</p><div class="formgrid"><div><label>معرف الحساب</label><input name="account_id" dir="ltr" pattern="[0-9]+" required value="'+escape(channel?.account_id)+'"></div><div><label>إصدار Graph المفعّل</label><input name="version" dir="ltr" required placeholder="vNN.0" value="'+escape(channel?.version)+'"></div></div><label>موظف استقبال القناة</label><select name="intake_user">'+data.users.filter(u=>u.active&&u.role!=='accountant').map(u=>'<option value="'+u.id+'" '+(channel?.intake_user===u.id?'selected':'')+'>'+escape(u.name)+'</option>').join('')+'</select><label>Access Token '+(channel?.token_set?'· محفوظ':'')+'</label><input name="accessToken" type="password" autocomplete="new-password" dir="ltr"><label>App Secret '+(channel?.secret_set?'· محفوظ':'')+'</label><input name="appSecret" type="password" autocomplete="new-password" dir="ltr"><label>Verify Token '+(channel?.verify_set?'· محفوظ':'')+'</label><input name="verifyToken" type="password" autocomplete="new-password" dir="ltr"><label><input name="active" type="checkbox" '+(channel?.active?'checked':'')+'> تفعيل القناة</label><p class="footnote">Webhook: '+escape(links[id+'_webhook']||'')+'<br>بعد الحفظ اختبر الحساب، واشترك في أحداث messages داخل تطبيق Meta. الحقول السرية الفارغة تحتفظ بالقيمة السابقة.</p>');
    bindForm(form,async(values,el)=>{const body=Object.fromEntries(values);body.active=el.elements.active.checked;await api('/channels/'+id,'PATCH',body);});return true;
  }
  if(name==='channel-test'){const result=await api('/channels/'+id+'/test','POST',{});await load();toast('تم التحقق من حساب '+(result.name||result.id)+'؛ استقبال أول حدث يؤكد Webhook');return true;}
  if(name==='create-api-key'){
    const form=modal('مفتاح تكامل محدود','<label>اسم الربط</label><input name="name" required placeholder="سيرفر الموقع"><p class="footnote">المفتاح ينشئ تسجيلات فقط؛ لا يقرأ بيانات العملاء. يظهر مرة واحدة بعد الإنشاء.</p>','إنشاء المفتاح');
    form.addEventListener('submit',async event=>{event.preventDefault();try{const result=await api('/integration-keys','POST',{name:form.elements.name.value});$('#modal').close();await load();modal('احفظ مفتاح الربط','<label>مفتاح API — يظهر مرة واحدة</label><input readonly dir="ltr" value="'+escape(result.key)+'"><p class="footnote">أرسله من سيرفر موقعك داخل X-MidEast-Key. احفظه في إعدادات الأسرار الخاصة بالسيرفر.</p>','تم');$('#editor').addEventListener('submit',e=>{e.preventDefault();$('#modal').close();});}catch(error){$('#modalerror').textContent=error.message;}});return true;
  }
  if(name==='revoke-api-key'){await api('/integration-keys/'+id+'/revoke','POST',{});await load();toast('تم إيقاف المفتاح');return true;}
  if(name==='new-reply'||name==='edit-reply'){
    const current=(h.replies||[]).find(t=>t.id===id);
    const form=modal(current?'تعديل الرد الجاهز':'رد جاهز جديد','<label>اسم الرد</label><input name="name" required value="'+escape(current?.name||'')+'"><label>التصنيف</label><input name="category" value="'+escape(current?.category||'عام')+'"><label>النص</label><textarea rows="5" name="body" maxlength="2000" required>'+escape(current?.body||'')+'</textarea><p class="footnote">متغيرات متاحة حسب السياق: {{name}}، {{reference}}، {{receipt_url}}، {{registration_url}}.</p>');
    bindForm(form,async values=>api(current?'/reply-templates/'+id:'/reply-templates',current?'PATCH':'POST',Object.fromEntries(values)));return true;
  }
  if(name==='retry-intake'){await api('/intake/'+id+'/retry','POST',{});await load();toast('اتجهزت إعادة المحاولة؛ راجع الحالة بعد المعالجة');return true;}
  if(name==='social-thread'){selectedSocial=id;socialMessages=await api('/social/threads/'+id+'/messages');render();return true;}
  if(name==='social-send'){await api('/social/threads/'+selectedSocial+'/messages','POST',{body:$('#social-body').value});socialMessages=await api('/social/threads/'+selectedSocial+'/messages');await load();toast('أُضيف الرد إلى طابور الإرسال');return true;}
  if(name==='social-insert-reply'){
    const form=modal('اختيار رد جاهز','<label>الرد</label><select name="reply_id">'+(h.replies||[]).map(t=>'<option value="'+t.id+'">'+escape(t.name)+'</option>').join('')+'</select>','إدراج');
    form.addEventListener('submit',e=>{e.preventDefault();const selected=(h.replies||[]).find(r=>r.id===form.elements.reply_id.value),thread=(h.threads||[]).find(t=>t.id===selectedSocial),values={name:thread?.name||'',registration_url:links[thread?.channel]||''};$('#modal').close();$('#social-body').value=String(selected?.body||'').replace(/\{\{([a-z_]+)\}\}/g,(_,key)=>values[key]||'');});return true;
  }
  return false;
}
