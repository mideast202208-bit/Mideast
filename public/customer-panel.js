import {brandIcon} from './brand-icons.js';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={whatsapp:'واتساب',facebook:'Messenger',instagram:'إنستجرام',email:'البريد الإلكتروني'};
const date=value=>value?new Date(value).toLocaleString('ar-EG',{dateStyle:'medium',timeStyle:'short',timeZone:'Africa/Cairo'}):'—';
export function customerChannelButtons(workspace){
 return '<div class="customer-channel-grid">'+workspace.channels.map((c,index)=>'<button type="button" class="customer-channel '+escape(c.channel)+'" data-action="customer-channel" data-id="'+escape(workspace.contact.id)+'|'+index+'" '+(!c.available?'disabled':'')+' title="'+escape(c.reason||'التواصل من داخل المنصة')+'">'+brandIcon(c.channel==='email'?'email':c.channel,24)+'<span><b>'+escape(labels[c.channel]||c.channel)+'</b><small>'+escape(c.available?(c.label||'التواصل داخل المنصة'):(c.reason||'غير متاح'))+'</small></span></button>').join('')+'</div><p class="footnote">الإرسال من حساب الشركة إلى جهة الاتصال المسجلة على الخادم. لا تحتاج لنسخ الرقم أو فتح تطبيق خارجي. واتساب يخضع لنافذة الرد وقوالب Meta.</p>';
}
export function customerTimeline(workspace){
 const last=workspace.last_staff_activity||workspace.last_activity,stages={new:'جديدة',contacted:'تم التواصل',qualified:'مؤهلة',proposal:'عرض خدمة',won:'مكتملة',lost:'مغلقة'};
 return '<div class="customer-last-action">'+brandIcon('history',22)+'<div><b>آخر متابعة للفريق</b><p>'+escape(last?(last.label+' — '+last.author):'لا توجد إجراءات متابعة بعد')+'</p><small>'+date(last?.created_at)+'</small></div></div><ol class="customer-timeline">'+workspace.timeline.map(e=>'<li><span class="customer-event-dot"></span><div><b>'+escape(e.label)+'</b><small>'+escape(e.author)+' · '+date(e.created_at)+'</small>'+(e.body?'<p>'+escape(e.body)+'</p>':'')+(e.stage?'<p>مرحلة الفرصة: '+escape(stages[e.stage]||e.stage)+'</p>':'')+'</div></li>').join('')+'</ol>';
}
export function customerMailHistory(workspace){
 const status={queued:'في طابور الإرسال',sending:'جارٍ الإرسال',accepted:'قبل مزود البريد الرسالة',error:'تعذر الإرسال',unknown:'نتيجة غير مؤكدة — راجع الإدارة قبل إعادة الإرسال'};
 return workspace.email_history.length?'<details class="customer-email-history"><summary>سجل البريد ('+workspace.email_history.length+')</summary>'+workspace.email_history.map(e=>'<article><b>'+escape(e.subject)+'</b><small>'+escape(status[e.status]||e.status)+' · '+date(e.updated_at)+'</small></article>').join('')+'<p class="footnote">قبول مزود البريد لا يثبت وصول الرسالة لصندوق الوارد أو قراءتها.</p></details>':'';
}
