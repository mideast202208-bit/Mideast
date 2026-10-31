import {findStudents,studentDossier} from './student-files.mjs';
import {normalizePhone} from './security.mjs';
import {normalizeSearch} from './international.mjs';

const normalized=value=>String(value||'').replace(/[٠-٩]/g,c=>'٠١٢٣٤٥٦٧٨٩'.indexOf(c)).toUpperCase();
const oneLine=value=>String(value||'').replace(/https?:\/\/\S+/gi,'').replace(/\s+/g,' ').trim().slice(0,160);
const denied='لا يمكن عرض ملف غير مرتبط برقم واتساب المرسل. تواصل مع الموظف المسؤول لمراجعة الربط؛ لن نشارك مستندات أو بيانات أشخاص آخرين.';
const states=new Set(['استكمال البيانات','جمع المستندات','جاهز للتقديم','تم التقديم','قبول مبدئي','قبول نهائي','مغلق']);

// Never performs a global name/phone/reference search. Called only after signed inbound
// resolution and inside its transaction. The caller also enforces the reply window/flags.
export function whatsappStatusReply(db,contact,senderPhone,body){
 if(!contact?.id||!contact.phone||senderPhone!==contact.phone)return null;
 const owner=db.prepare("SELECT id FROM users WHERE id=? AND active=1 AND role IN('admin','manager','agent')").get(contact.owner_id);
 if(!owner)return null;
 const actor={id:owner.id,role:'agent'},students=findStudents(db,actor,'',contact.id);
 const query=normalized(body),references=query.match(/\b(?:ME-\d{4}-[A-Z0-9]{6,32}|ST-[A-F0-9]{12})\b/g)||[];
 let phoneRequest=false;
 if(/^[+\d٠-٩\s()-]{7,45}$/.test(String(body||'')))try{phoneRequest=normalizePhone(String(body).replace(/[٠-٩]/g,c=>'٠١٢٣٤٥٦٧٨٩'.indexOf(c)).replace(/[\s()-]/g,''))===contact.phone;}catch{}
 const nameRequest=students.some(s=>normalizeSearch(s.name)===normalizeSearch(body));
 const request=references.length||phoneRequest||nameRequest||/ملف|حالة|طلب|مستند|متابع|بياناتي|اسمي|\bstatus\b|\bfile\b|\bapplication\b/i.test(String(body||''));
 if(!request)return null;
 if(!students.length)return 'لا يوجد ملف طالب مرتبط بهذا الرقم حاليًا. تواصل مع الفريق أو أكمل نموذج التسجيل؛ لن يُنشأ مستند أو قبول من هذه الرسالة.';
 let selected;
 if(references.length){const unique=[...new Set(references)];if(unique.length!==1)return 'اكتب رقم ملف واحد فقط لمراجعة حالته.';selected=students.find(s=>normalized(s.reference)===unique[0]);if(!selected)return denied;}
 else if(students.length===1)selected=students[0];
 else return 'هذا الرقم مرتبط بأكثر من ملف طالب. أرسل رقم الملف المحدد فقط؛ الاسم وحده لا يحدد الملف ولن نختار ملفًا نيابة عنك.';
 const dossier=studentDossier(db,actor,selected.id),saved=dossier.latest_registration?.registration_status;
 const state=states.has(saved)?saved:'تحتاج مراجعة الموظف المسؤول';
 const received=dossier.checklist.filter(d=>d.count>0).map(d=>d.label),missing=dossier.checklist.filter(d=>!d.count).map(d=>d.label);
 return ['الطالب: '+oneLine(dossier.name),'رقم الملف: '+dossier.reference,'الحالة المسجلة بالنظام: '+state,'تصنيفات مستندات مستلمة: '+(received.join('، ')||'لم تُسجل بعد'),'تصنيفات بدون ملفات مرفوعة: '+(missing.join('، ')||'لا توجد تصنيفات فارغة ضمن الفهرس الحالي'),'هذا فهرس تصنيف واستلام وليس قائمة متطلبات نهائية؛ المطلوب النهائي يحدده الفريق حسب حالتك. هذه إفادة بالحالة المسجلة وليست قرار قبول جديدًا.'].join('\n');
}
