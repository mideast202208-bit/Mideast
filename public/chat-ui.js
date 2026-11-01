import {brandIcon} from './brand-icons.js';
export const chatEscape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const statusNames={received:'واردة',queued:'في طابور الإرسال',accepted:'قبلتها Meta',sent:'أُرسلت',delivered:'تم التسليم',read:'مقروءة',failed:'تعذر الإرسال',error:'تعذر الإرسال',unknown:'نتيجة غير مؤكدة',blocked:'محجوبة'};
const format=(value,options)=>new Date(value).toLocaleString('ar-EG',{...options,timeZone:'Africa/Cairo'});
export function chatHistory(messages,{originals=false,query='',saveToStudent=false}={}){
 const rows=messages.filter(m=>!query||String(m.body||'').toLocaleLowerCase().includes(query.toLocaleLowerCase()));
 if(!rows.length)return '<div class="chat-empty">'+brandIcon('communications',38)+'<b>'+(query?'لا توجد نتائج للبحث':'بداية محادثة واضحة')+'</b><span>'+(query?'جرّب كلمة أخرى من الرسائل المحملة.':'الرسائل الجديدة تظهر هنا. فتح المحادثة لا يرسل أي رسالة.')+'</span></div>';
 let day='';return rows.map(m=>{
  const stamp=format(m.created_at,{day:'numeric',month:'long',year:'numeric'}),divider=stamp!==day?'<div class="chat-date"><span>'+chatEscape(stamp)+'</span></div>':'';day=stamp;
  const status=statusNames[m.status]||m.status||'',ticks=m.direction==='out'?(m.status==='read'?'✓✓':m.status==='delivered'?'✓✓':m.status==='sent'?'✓':''):'',bad=['failed','error','unknown','blocked'].includes(m.status);
  return divider+'<article class="unified-bubble '+(m.direction==='out'?'out':'in')+(bad?' attention':'')+'" data-message-id="'+chatEscape(m.id)+'"><p dir="auto">'+chatEscape(m.body||'['+(m.kind||'مرفق')+']')+'</p>'+(m.attachment_id&&originals?'<a class="message-attachment" href="/api/files/'+encodeURIComponent(m.attachment_id)+'">'+brandIcon('document',16)+' تنزيل المرفق</a>'+(saveToStudent?'<button type="button" class="btn small" data-action="workspace-attach-document" data-id="'+chatEscape(m.attachment_id)+'">حفظ في ملف الطالب</button>':''):'')+(m.student_reference?'<span class="message-file">ملف '+chatEscape(m.student_reference)+'</span>':'')+'<footer><time datetime="'+chatEscape(m.created_at)+'">'+chatEscape(format(m.created_at,{hour:'2-digit',minute:'2-digit'}))+'</time><span class="message-status '+(m.status==='read'?'is-read':'')+'" title="'+chatEscape(status)+'">'+ticks+' '+chatEscape(status)+'</span>'+(m.error_code?'<span class="message-error">'+chatEscape(m.error_code)+'</span>':'')+'</footer></article>';
 }).join('');
}
