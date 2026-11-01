import {brandIcon} from './brand-icons.js';
import {chatEscape as e,chatHistory} from './chat-ui.js';
const names={whatsapp:'واتساب',facebook:'Messenger',instagram:'إنستجرام'};
export function createRecordMessenger({api,getUser,toast,onUpdate,getTemplates}){
 let current=null;
 const drafts=new Map(),selectedChannels=new Map();
 const active=s=>current===s&&s.root.isConnected;
 const endpoint=s=>'/communication/threads/'+encodeURIComponent(s.key);
 function remember(s){if(s.key){const input=s.root.querySelector('[data-message-body]');if(input)drafts.set(s.key,input.value);}}
 function templateOptions(){return (getTemplates?.()||[]).filter(t=>{if(t.status!=='APPROVED')return false;try{const parts=JSON.parse(t.components);return Array.isArray(parts)&&parts.every(c=>c&&(c.type==='BODY'&&!/\{\{(?!\d+\}\})/.test(String(c.text||''))||c.type==='FOOTER'||c.type==='HEADER'&&c.format==='TEXT'&&!String(c.text||'').includes('{{')));}catch{return false;}});}
 function paint(s){
  if(!active(s))return;
  if(!s.channel){s.root.innerHTML='<div class="chat-empty">'+brandIcon('communications',38)+'<b>راسل العميل من نفس الملف</b><span>اختر واتساب أو Messenger أو إنستجرام من الأعلى لعرض المحادثة والرد هنا.</span></div>';return;}
  for(const button of s.root.closest('.customer-workspace')?.querySelectorAll('.customer-channel')||[])button.setAttribute('aria-pressed',String(s.workspace.channels[Number(button.dataset.id?.split('|')[1])]?.channel===s.channel.channel&&s.workspace.channels[Number(button.dataset.id?.split('|')[1])]?.account_id===s.channel.account_id));
  const c=s.channel,choice=s.context?.requires_choice,approved=c.channel==='whatsapp'&&c.templates_allowed?templateOptions():[],template=approved.find(t=>t.id===s.template),closed=c.reply_window_open!==true;
  let variables=[];if(template){try{const body=JSON.parse(template.components).find(c=>c.type==='BODY')?.text||'';variables=[...new Set([...body.matchAll(/\{\{(\d+)\}\}/g)].map(m=>Number(m[1])))].sort((a,b)=>a-b);}catch{}}
  s.root.innerHTML='<header class="record-chat-head"><span class="channel-symbol '+e(c.channel)+'">'+brandIcon(c.channel,23)+'</span><div><b>'+e(s.workspace.contact.name)+'</b><small>'+e(c.label||names[c.channel])+' · '+names[c.channel]+'</small></div><button type="button" class="chat-icon-button" data-message-control="refresh" aria-label="تحديث المحادثة">'+brandIcon('refresh',20)+'</button></header><div class="chat-toolbar"><span class="reply-window '+(closed?'closed':'')+'">'+brandIcon(closed?'clock':'shield',15)+(closed?'نافذة الرد النصي مغلقة':'نافذة الرد النصي مفتوحة')+'</span><label class="chat-search">'+brandIcon('search',16)+'<input data-message-search aria-label="بحث داخل رسائل هذا العميل" placeholder="بحث في الرسائل" value="'+e(s.query||'')+'"></label></div><div class="record-chat-history unified-history" role="log" aria-label="رسائل العميل" aria-live="polite">'+chatHistory(s.messages,{originals:['admin','manager'].includes(getUser()?.role),query:s.query||''})+'</div>'+(choice||s.context?.students?.length>1?'<div class="record-student-choice"><label>ملف الطالب المرتبط بالرد<select data-message-student><option value="">اختر ملف الطالب قبل الإرسال</option>'+(s.context.students||[]).map(v=>'<option value="'+e(v.id)+'" '+(v.id===s.context.selected?.id?'selected':'')+'>'+e(v.name)+' · '+e(v.reference)+'</option>').join('')+'</select></label><small>لن يُختار ملف طالب بالاسم وحده عند وجود أكثر من ملف.</small></div>':'')+'<div class="record-chat-compose"><div class="compose-top"><b>'+brandIcon('send',17)+' الرد للعميل</b><span>من حساب الشركة · بيانات الاتصال محمية</span></div>'+(closed?'<p class="chat-window-notice">الرد النصي متوقف حتى تصل رسالة جديدة من العميل.'+(c.channel==='whatsapp'?' يمكنك استخدام قالب معتمد مع موافقة التواصل المسجلة.':' الإرسال يخضع لسياسة القناة.')+'</p>':'')+(approved.length?'<label>نوع الرسالة<select data-message-template><option value="">رد نصي داخل نافذة التواصل</option>'+approved.map(t=>'<option value="'+e(t.id)+'" '+(t.id===s.template?'selected':'')+'>'+e(t.name)+' · '+e(t.language)+'</option>').join('')+'</select></label>':'')+(template?'<div class="template-preview">'+e(JSON.parse(template.components).find(c=>c.type==='BODY')?.text||template.name)+'</div>'+variables.map(n=>'<label>قيمة المتغير '+n+'<input data-template-variable="'+n+'" maxlength="500" value="'+e(s.parameters?.[n]||'')+'"></label>').join(''):'<label class="sr-only" for="record-message-body">نص الرسالة</label><textarea id="record-message-body" data-message-body rows="3" maxlength="'+(c.channel==='whatsapp'?4096:1000)+'" placeholder="اكتب رسالتك للعميل هنا…" '+(closed?'disabled':'')+'>'+e(drafts.get(s.key)||'')+'</textarea>')+(s.context?.selected&&!template?'<label class="reply-reference"><input type="checkbox" data-message-reference '+(s.includeReference?'checked':'')+'> تضمين اسم الطالب ورقم الملف</label>':'')+'<div class="compose-bottom"><small>تُحفظ الرسالة في سجل العميل. قبول المزود لا يعني التسليم.</small><button class="btn primary" type="button" data-message-control="send" '+(s.sending||choice||closed&&!template?'disabled':'')+'>'+brandIcon('send',18)+(s.sending?'جارٍ تجهيز الرسالة…':'إرسال الرسالة')+'</button></div><p class="record-message-feedback" role="status">'+e(s.feedback||'')+'</p></div>';
  const history=s.root.querySelector('.record-chat-history');history.scrollTop=history.scrollHeight;
 }
 async function reload(s){
  const key=s.key;const [messages,context,workspace]=await Promise.all([api(endpoint(s)+'/messages'),api(endpoint(s)+'/students'),api('/contacts/'+s.workspace.contact.id+'/workspace')]);
  if(!active(s)||key!==s.key)return;
  s.messages=messages;s.context=context;s.workspace=workspace;s.channel=workspace.channels.find(c=>c.channel===s.channel.channel&&c.account_id===s.channel.account_id)||s.channel;paint(s);
 }
 async function open(channel){
  const s=current;if(!s||!active(s))return;remember(s);const version=++s.version;
  s.root.setAttribute('aria-busy','true');
  try{const result=await api('/contacts/'+s.workspace.contact.id+'/open-channel','POST',{channel:channel.channel,account_id:channel.account_id});if(!active(s)||version!==s.version)return;s.key=result.key;s.channel=channel;s.query='';s.template='';s.feedback='';s.parameters={};selectedChannels.set(s.workspace.contact.id,{channel:channel.channel,account_id:channel.account_id});await reload(s);}finally{if(active(s)&&version===s.version)s.root.removeAttribute('aria-busy');}
 }
 function mount(root,workspace){
  if(current){remember(current);clearInterval(current.timer);}
  const s={root,workspace,key:null,channel:null,messages:[],context:null,version:0,includeReference:false,sending:false};current=s;paint(s);
  root.addEventListener('input',event=>{if(!active(s))return;if(event.target.matches('[data-message-body]'))drafts.set(s.key,event.target.value);if(event.target.matches('[data-template-variable]'))(s.parameters||={})[event.target.dataset.templateVariable]=event.target.value;if(event.target.matches('[data-message-search]')){s.query=event.target.value;root.querySelector('.record-chat-history').innerHTML=chatHistory(s.messages,{originals:['admin','manager'].includes(getUser()?.role),query:s.query});}});
  root.addEventListener('change',async event=>{if(!active(s))return;try{if(event.target.matches('[data-message-reference]'))s.includeReference=event.target.checked;if(event.target.matches('[data-message-template]')){remember(s);s.template=event.target.value;s.parameters={};paint(s);}if(event.target.matches('[data-message-student]')){if(!event.target.value){s.context={...s.context,selected:null,requires_choice:true};paint(s);return;}s.context=await api(endpoint(s)+'/students','POST',{student_id:event.target.value});paint(s);}}catch(error){if(active(s))toast(error.message,true);}});
  root.addEventListener('click',async event=>{
   const control=event.target.closest('[data-message-control]');if(!control||!active(s))return;event.preventDefault();
   try{if(control.dataset.messageControl==='refresh'){remember(s);await reload(s);return;}
    if(control.dataset.messageControl!=='send'||s.sending)return;
    const body=root.querySelector('[data-message-body]')?.value||'',template=templateOptions().find(t=>t.id===s.template);
    if(!template&&!body.trim())throw Error('اكتب الرسالة أولًا');
    const parameters=[...root.querySelectorAll('[data-template-variable]')].map(el=>{if(!el.value.trim())throw Error('أكمل متغيرات القالب');return {type:'text',text:el.value.trim()};});
    const payload=template?{kind:'template',template_name:template.name,language:template.language,components:parameters.length?[{type:'body',parameters}]:[],student_id:s.context?.selected?.id}:{body,student_id:s.context?.selected?.id,include_reference:s.includeReference};
    s.sending=true;control.disabled=true;control.textContent='جارٍ تجهيز الرسالة…';
    let accepted=false;
    try{await api(endpoint(s)+'/messages','POST',payload);accepted=true;drafts.delete(s.key);s.feedback='أُضيفت الرسالة إلى طابور الإرسال. راقب حالة التسليم في السجل.';s.template='';s.parameters={};await reload(s);await onUpdate?.(s.workspace.contact.id);}
    catch(error){s.feedback=accepted?'حُفظت الرسالة؛ تعذر تحديث العرض. حدّث المحادثة قبل أي إرسال آخر.':'تعذر تأكيد تجهيز الرسالة. حدّث السجل وراجع آخر رسالة قبل المحاولة مجددًا. '+error.message;throw error;}
    finally{s.sending=false;paint(s);}
   }catch(error){if(active(s))toast(error.message,true);}
  });
  const saved=selectedChannels.get(workspace.contact.id),channel=workspace.channels.find(c=>c.available&&c.channel!=='email'&&(saved?c.channel===saved.channel&&c.account_id===saved.account_id:c.thread_key));
  if(channel)open(channel).catch(error=>{if(active(s))toast(error.message,true);});
  s.timer=setInterval(async()=>{
   if(!active(s)){clearInterval(s.timer);return;}
   const focused=s.root.ownerDocument.activeElement;
   if(!s.key||s.sending||s.polling||s.root.getAttribute('aria-busy')||s.root.ownerDocument.hidden||s.root.closest('dialog')&&!s.root.closest('dialog').open||s.root.contains(focused)&&['INPUT','TEXTAREA','SELECT'].includes(focused?.tagName))return;
   s.polling=true;try{remember(s);await reload(s);}catch{}finally{s.polling=false;}
  },20000);
 }
 return {mount,open,reset(){if(current)clearInterval(current.timer);current=null;drafts.clear();selectedChannels.clear();}};
}
