import {documentTypes} from './documents.js';

const e=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const values=row=>{try{return typeof row.data==='string'?JSON.parse(row.data):row.data||{};}catch{return {};}};
const normalize=value=>String(value??'').normalize('NFKC').replace(/[أإآ]/g,'ا').replace(/ى/g,'ي').replace(/[\u064B-\u065F\u0670]/g,'').replace(/[٠-٩]/g,c=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(c))).replace(/[۰-۹]/g,c=>String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c))).replace(/\s+/g,' ').trim().toLowerCase();
export function filterRecordsBySearch(rows,query='',related=()=>[]){
 const q=normalize(query);if(!q)return rows;
 return rows.filter(row=>normalize([...Object.values(row).filter(v=>typeof v==='string'),...related(row)].join(' ')).includes(q));
}
export function sectionSearch(label,placeholder,query,content){
 return `<section class="section-search" role="search" aria-label="البحث في ${e(label)}"><label for="section-search-input">بحث في ${e(label)}</label><div class="section-search-controls"><input type="search" id="section-search-input" data-page-search placeholder="${e(placeholder)}" value="${e(query)}" autocomplete="off" maxlength="160"><button type="button" class="btn" data-action="clear-page-search" ${query?'':'disabled'}>مسح البحث</button></div></section><div data-search-results aria-live="polite">${content}</div>`;
}
// Keep the active input node in place so Arabic/mobile typing retains focus and caret.
export function updateSectionSearch(document,query,view,source){
 for(const control of [document.querySelector('#search'),document.querySelector('[data-page-search]')])if(control&&control!==source)control.value=query;
 const target=document.querySelector('[data-search-results]');
 if(target){const template=document.createElement('template');template.innerHTML=view();const next=template.content.querySelector('[data-search-results]');if(next)target.innerHTML=next.innerHTML;}
 else{const content=document.querySelector('#content');if(content)content.innerHTML=view();}
 const clear=document.querySelector('[data-action="clear-page-search"]');if(clear)clear.disabled=!query;
}
const service=row=>String(values(row).requested_service??row.requested_service??'').trim();
const serviceKey=row=>service(row)?'value:'+service(row):'unset';
const button=(label,action,id='')=>`<button type="button" class="btn small" data-action="${action}" data-id="${e(id)}">${e(label)}</button>`;
const select=(label,key,options,value)=>`<label>${label}<select data-student-filter="${key}"><option value="">الكل</option>${options.map(([id,name])=>`<option value="${e(id)}" ${id===value?'selected':''}>${e(name)}</option>`).join('')}</select></label>`;
const unique=items=>[...new Set(items.filter(Boolean))].sort((a,b)=>a.localeCompare(b,'ar'));
const noResults=()=>'<div class="empty"><b>لا توجد نتائج مطابقة</b>غيّر البحث أو امسح الفلاتر.</div>';

export function filterServiceRequests(rows,filters={},query=''){
 const q=normalize(query);
 return rows.filter(row=>(!filters.service||serviceKey(row)===filters.service)&&(!filters.status||(values(row).application_status||'')===filters.status)&&(!q||normalize([row.name,row.student_name,row.reference,JSON.stringify(values(row)),row.requested_service].join(' ')).includes(q)));
}

// Folders use the student ID, never the name or guardian phone. Existing bytes stay in place.
export function buildStudentFolders(data){
 const app=key=>data.apps.find(a=>a.app_key===key)?.id;
 const students=data.appRecords.filter(r=>r.app_id===app('me_students'));
 const documents=data.appRecords.filter(r=>r.app_id===app('me_documents'));
 const admissions=data.appRecords.filter(r=>r.app_id===app('me_admissions'));
 const folders=students.map(student=>{
  const request=admissions.filter(r=>values(r).student===student.id&&values(r).reference).sort((a,b)=>String(b.created_at||'').localeCompare(String(a.created_at||'')))[0];
  return {...student,reference:request?values(request).reference:'ST-'+student.id.replaceAll('-','').slice(0,12).toUpperCase(),documents:documents.filter(r=>values(r).student===student.id)};
 });
 const ids=new Set(students.map(r=>r.id));
 const unlinked=documents.filter(r=>!ids.has(values(r).student));
 return {folders,unlinked};
}

export function createStudentRecords({getData,getUser,getPage,api,render,navigate,modal,bindForm,toast}){
 let userId=null,selected=null,dossier=null,folderError='',filters={};
 function state(){if(userId!==getUser()?.id){userId=getUser()?.id;selected=null;dossier=null;filters={};}return filters;}
 const filter=key=>state()[key]||'';
 const isManager=()=>['admin','manager'].includes(getUser()?.role);
 const app=key=>getData().apps.find(a=>a.app_key===key);
 const isDocuments=()=>getPage()==='app:'+app('me_documents')?.id;
 async function load(){
  state();if(!isDocuments()||!selected||selected==='unlinked')return;
  dossier=null;folderError='';
  try{dossier=await api('/communication/students/'+encodeURIComponent(selected));}catch{folderError='تعذر فتح الفولدر أو لم يعد متاحًا بصلاحياتك.';}
 }
 function requestFilters(key,rows){
  const options=[...new Map(rows.map(r=>[serviceKey(r),service(r)||'خدمة غير محددة'])).entries()].sort((a,b)=>a[1].localeCompare(b[1],'ar'));
  const statuses=unique(rows.map(r=>values(r).application_status)).map(s=>[s,s]);
  return `<div class="student-filters" role="group" aria-label="فلترة الطلبات">${select('الخدمة المطلوبة',key+':service',options,filter(key+':service'))}${statuses.length?select('حالة الطلب',key+':status',statuses,filter(key+':status')):''}${button('مسح الفلاتر','student-filter-reset',key)}</div>`;
 }
 function requests(key,rows,query){return filterServiceRequests(rows,{service:filter(key+':service'),status:filter(key+':status')},query);}
 function documentMatches(row,query,folder){
  const v=values(row),q=normalize(query);
  return (!filter('documents:type')||v.document_type===filter('documents:type'))&&(!filter('documents:status')||v.document_status===filter('documents:status'))&&(!q||normalize([folder?.name,folder?.reference,row.name,v.document_type,v.document_status].join(' ')).includes(q));
 }
 function documentTable(rows,query,folder){
  const shown=rows.filter(r=>documentMatches(r,query,folder));
  const actual=new Map((dossier?.id===folder?.id?dossier.documents:[]).map(d=>[d.id,d]));
  return `<p class="sub" role="status">${shown.length} من ${rows.length} مستند</p>`+(shown.length?`<div class="tablewrap"><table><thead><tr><th>المستند</th><th>النوع</th><th>الحالة</th><th>تاريخ الاستلام</th><th>الملف</th><th></th></tr></thead><tbody>${shown.map(row=>{const v=values(row),file=actual.get(row.id);return `<tr data-student-document="${e(row.id)}"><td><b>${e(row.name)}</b></td><td>${e(v.document_type||'غير مصنف')}</td><td>${e(v.document_status||'غير محددة')}</td><td>${e(v.received_date||'—')}</td><td>${file?.attachment_id?(isManager()?`<a class="btn small" href="/api/files/${encodeURIComponent(file.attachment_id)}">تنزيل الملف</a>`:'الأصل متاح للإدارة'):file?'لم يُربط ملف فعلي':'افتح فولدر الطالب لعرض الملف'}</td><td>${button('تعديل السجل','edit-record',row.id)}</td></tr>`;}).join('')}</tbody></table></div>`:noResults());
 }
 function documents(query=''){
  state();const model=buildStudentFolders(getData()),all=model.folders.flatMap(f=>f.documents).concat(model.unlinked);
  const current=model.folders.find(f=>f.id===selected);
  const toolbar=`<div class="student-filters" role="group" aria-label="فلترة المستندات">${select('الطالب','documents:student',model.folders.map(f=>[f.id,f.name+' · '+f.reference]),(filter('documents:student')||(current?.id||'')))}${select('نوع المستند','documents:type',unique([...Object.values(documentTypes),...all.map(r=>values(r).document_type)]).map(v=>[v,v]),filter('documents:type'))}${select('حالة المستند','documents:status',unique(all.map(r=>values(r).document_status)).map(v=>[v,v]),filter('documents:status'))}${button('مسح الفلاتر','student-filter-reset','documents')}</div>`;
  if(selected){
   const header=`<div class="student-folder-head">${button('كل فولدرات الطلاب','student-folder-back')}<div><h2>${e(current?.name||(selected==='unlinked'?'مستندات تحتاج ربطًا':'فولدر غير متاح'))}</h2><span class="mono">${e(current?.reference||'')}</span></div>${current?button('رفع مستند للفولدر','student-folder-upload',current.id):''}</div>`;
   const body=selected==='unlinked'?'<p class="sub">اختر الطالب الصحيح من تعديل السجل؛ لا تُنقل المستندات تلقائيًا بالاسم أو الهاتف.</p>'+documentTable(model.unlinked,query,null):folderError?`<p class="notebox" role="alert">${folderError}</p>`:!current?noResults():!dossier?'<p role="status">جارٍ فتح الفولدر…</p>':documentTable(current.documents,query,current);
   return toolbar+`<section class="panel student-folder-detail">${header}${body}</section>`;
  }
  const active=Boolean(query||filter('documents:type')||filter('documents:status'));
  const folders=model.folders.filter(f=>(!filter('documents:student')||f.id===filter('documents:student'))&&(!active||f.documents.some(d=>documentMatches(d,query,f))||(!filter('documents:type')&&!filter('documents:status')&&normalize(f.name+' '+f.reference).includes(normalize(query)))));
  const orphanVisible=!filter('documents:student')&&model.unlinked.some(d=>documentMatches(d,query,null));
  return toolbar+`<p class="sub" role="status">${folders.length} من ${model.folders.length} فولدر طالب · ${all.length} سجل مستند</p><div class="student-folders">${folders.map(f=>`<button type="button" class="student-folder" data-action="student-folder" data-id="${e(f.id)}"><span class="student-folder-icon" aria-hidden="true">▰</span><strong>${e(f.name)}</strong><span class="mono">${e(f.reference)}</span><small>${f.documents.length} مستند · ${e(getData().users.find(u=>u.id===f.owner_id)?.name||'موظف مختص')}</small><span class="student-folder-open">فتح الفولدر ←</span></button>`).join('')}${orphanVisible?`<button type="button" class="student-folder needs-link" data-action="student-folder" data-id="unlinked"><strong>مستندات تحتاج ربطًا</strong><small>${model.unlinked.length} مستند</small></button>`:''}</div>${!folders.length&&!orphanVisible?noResults():''}`;
 }
 async function action(name,id){
  state();
  if(name==='student-filter-reset'){for(const key of Object.keys(filters))if(key.startsWith(id+':'))delete filters[key];render();return true;}
  if(name==='student-folder-back'){selected=null;dossier=null;folderError='';render();return true;}
  if(name==='student-folder'){
   if(id!=='unlinked'&&!buildStudentFolders(getData()).folders.some(f=>f.id===id))throw new Error('فولدر الطالب غير متاح بصلاحياتك');
   const target=app('me_documents');if(!target)throw new Error('تطبيق المستندات غير مجهز');
   selected=id;dossier=null;folderError='';delete filters['documents:student'];
   if(!isDocuments())await navigate('app:'+target.id);else{await load();render();}return true;
  }
  if(name==='student-folder-upload'){
   if(selected!==id||!dossier||dossier.id!==id)throw new Error('افتح فولدر الطالب أولًا');
   const form=modal('رفع مستند إلى فولدر الطالب',`<p><b>${e(dossier.name)}</b> · <span class="mono">${e(dossier.reference)}</span></p><label>نوع المستند<select name="document_type">${Object.values(documentTypes).map(t=>`<option>${e(t)}</option>`).join('')}</select></label><label>الطلب المرتبط<select name="application"><option value="">في فولدر الطالب فقط</option>${dossier.registrations.map(r=>`<option value="${e(r.admission_id)}">${e(r.reference)}</option>`).join('')}</select></label><label>الملف<input type="file" name="file" accept="application/pdf,image/jpeg,image/png" required></label><p class="sub">PDF أو JPG أو PNG، حتى 10 ميجابايت.</p>`,'رفع المستند');
   bindForm(form,async(_,el)=>{const file=el.elements.file.files[0];if(!file||file.size>10*1024*1024)throw new Error('اختر ملفًا حتى 10 ميجابايت');
    const content=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('تعذرت قراءة الملف'));reader.readAsDataURL(file);});
    await api('/communication/students/'+encodeURIComponent(id)+'/documents','POST',{name:file.name,mime:file.type,content,document_type:el.elements.document_type.value,application:el.elements.application.value});toast('حُفظ المستند في فولدر الطالب');});return true;
  }
  return false;
 }
 function change(key,value){state();if(!/^(documents:(student|type|status)|admissions:(service|status)|registrations:(service|status))$/.test(key))return false;filters[key]=value;if(key==='documents:student'&&selected!==value){selected=null;dossier=null;}render();return true;}
 function newDocumentValues(){state();return selected&&selected!=='unlinked'?{student:selected}:{};}
 return {load,documents,requestFilters,requests,action,change,newDocumentValues};
}
