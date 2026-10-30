import {services,nonAcademicServices} from './services.js';
const form=document.querySelector('#application-form'),steps=[...form.querySelectorAll('[data-step]')],error=document.querySelector('#form-error');
let selectedFiles=[];
let current=0,busy=false,requestKey=crypto.randomUUID().replaceAll('-','');
form.elements.academic_year.value=String(new Date().getFullYear());
const initialParams=new URLSearchParams(location.search);
if(['بكالوريوس','ماجستير','دكتوراه'].includes(initialParams.get('service')))form.elements.level.value=initialParams.get('service');
const serviceSelect=form.elements.requested_service;
for(const label of ['طلب دراسة أو استشارة عامة',...services]){const option=document.createElement('option');option.value=label==='طلب دراسة أو استشارة عامة'?'':label;option.textContent=label;serviceSelect.append(option);}
const requested=initialParams.get('interest')||initialParams.get('requested_service')||'';
if(requested&&requested.length<=200){if(!services.includes(requested)){const option=document.createElement('option');option.value=requested;option.textContent=requested;serviceSelect.append(option);}serviceSelect.value=requested;}
function updateService(){
 const nonAcademic=nonAcademicServices.includes(serviceSelect.value);
 if(nonAcademic)form.elements.level.value='غير دراسي';
 else if(form.elements.level.value==='غير دراسي')form.elements.level.value=/دراسات عليا/.test(serviceSelect.value)?'ماجستير':'بكالوريوس';
 for(const name of ['certificate','academic_year','university','faculty']){const input=form.elements[name];input.closest('label').hidden=nonAcademic;input.required=!nonAcademic&&['certificate','academic_year'].includes(name);}
}
if(/دراسات عليا/.test(requested))form.elements.level.value='ماجستير';
serviceSelect.addEventListener('change',updateService);form.elements.level.addEventListener('change',()=>{if(form.elements.level.value==='غير دراسي'&&!nonAcademicServices.includes(serviceSelect.value))serviceSelect.value='استشارة وتواصل مع الفريق';updateService();});updateService();
if(initialParams.get('embed')==='1'){
  document.body.classList.add('embedded');
  if(window.parent!==window){
    let parentOrigin;try{parentOrigin=new URL(document.referrer).origin;}catch{}
    if(['https://mideastedu-eg.com','https://www.mideastedu-eg.com'].includes(parentOrigin)){
      const report=()=>window.parent.postMessage({type:'mideast-platform-form-height',height:document.body.scrollHeight},parentOrigin);
      new ResizeObserver(report).observe(document.body);report();
    }
  }
}
function showStep(index){
  current=index;steps.forEach((step,i)=>{step.hidden=i!==index;});
  document.querySelector('#step-label').textContent='الخطوة '+(index+1)+' من 4';
  document.querySelector('#step-progress').style.width=((index+1)*25)+'%';
  document.querySelector('#previous-step').hidden=index===0;
  document.querySelector('#next-step').hidden=index===3;
  document.querySelector('#send-application').hidden=index!==3;error.textContent='';
  if(index===3){
    const target=document.querySelector('#review-data');target.replaceChildren();
    for(const [label,value] of [['الخدمة',serviceSelect.value||'طلب دراسة أو استشارة عامة'],['الطالب',form.elements.name.value],['رقم التواصل',form.elements.phone.value],['الدراسة',form.elements.level.value+' · '+form.elements.certificate.value],['سنة التقديم',form.elements.academic_year.value],['المرفقات',String(selectedFiles.length)+' ملف']]){
      const row=document.createElement('div'),b=document.createElement('b'),span=document.createElement('span');b.textContent=label;span.textContent=value;row.append(b,span);target.append(row);
    }
  }
}
function validStep(index){for(const el of steps[index].querySelectorAll('input,select,textarea')){if(!el.checkValidity()){el.reportValidity();return false;}}return true;}
document.querySelector('#next-step').addEventListener('click',()=>{if(validStep(current))showStep(current+1);});
document.querySelector('#previous-step').addEventListener('click',()=>showStep(current-1));
form.addEventListener('keydown',event=>{if(event.key==='Enter'&&event.target.tagName==='INPUT'&&event.target.type!=='file'&&current<3){event.preventDefault();document.querySelector('#next-step').click();}});
const filesInput=document.querySelector('#intake-files');
const limits={maxFiles:12,maxFileMB:5,maxTotalMB:25};
const fileMime=file=>file.type||({pdf:'application/pdf',jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png'}[file.name.split('.').pop().toLowerCase()]||'');
function renderFiles(){
  const list=document.querySelector('#file-list');list.replaceChildren();
  selectedFiles.forEach((file,index)=>{
    const row=document.createElement('div'),name=document.createElement('span'),size=document.createElement('small'),remove=document.createElement('button');
    row.className='portal-file-row';name.textContent=file.name;size.textContent=Math.ceil(file.size/1024)+' KB';
    remove.type='button';remove.textContent='إزالة';remove.disabled=busy;remove.setAttribute('aria-label','إزالة '+file.name);
    remove.addEventListener('click',()=>{selectedFiles.splice(index,1);document.querySelector('#file-error').textContent='';renderFiles();});
    row.append(name,size,remove);list.append(row);
  });
  document.querySelector('#file-count').textContent=selectedFiles.length+' / '+limits.maxFiles+' ملف · '+(selectedFiles.reduce((n,f)=>n+f.size,0)/1024/1024).toFixed(1)+' / '+limits.maxTotalMB+' MB';
}
function addFiles(batch){
  if(busy)return;
  const known=new Set(selectedFiles.map(f=>[f.name,f.size,f.lastModified].join('|'))),next=[...selectedFiles];
  for(const file of batch){const id=[file.name,file.size,file.lastModified].join('|');if(!known.has(id)){known.add(id);next.push(file);}}
  let message='';
  if(next.length>limits.maxFiles)message='الحد '+limits.maxFiles+' ملفًا. أزل بعض الملفات أولًا؛ لم نضف الدفعة الجديدة.';
  else if(next.some(f=>!['application/pdf','image/jpeg','image/png'].includes(fileMime(f))))message='المسموح PDF وJPG وPNG فقط؛ لم نضف الدفعة الجديدة.';
  else if(next.some(f=>f.size>limits.maxFileMB*1024*1024)||next.reduce((n,f)=>n+f.size,0)>limits.maxTotalMB*1024*1024)message='حد الملف '+limits.maxFileMB+' MB والمجموع '+limits.maxTotalMB+' MB؛ لم نضف الدفعة الجديدة.';
  if(!message)selectedFiles=next;
  document.querySelector('#file-error').textContent=message;filesInput.value='';renderFiles();
}
filesInput.addEventListener('change',()=>addFiles([...filesInput.files]));
const drop=filesInput.closest('.portal-drop');
drop.addEventListener('dragover',event=>{event.preventDefault();drop.dataset.drag='true';});
drop.addEventListener('dragleave',()=>{delete drop.dataset.drag;});
drop.addEventListener('drop',event=>{event.preventDefault();delete drop.dataset.drag;addFiles([...event.dataTransfer.files]);});
renderFiles();
const readFile=file=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(new Error('تعذر قراءة الملف'));reader.onload=()=>resolve({name:file.name,mime:fileMime(file),content:String(reader.result).split(',')[1]});reader.readAsDataURL(file);});
form.addEventListener('submit',async event=>{
  event.preventDefault();if(busy)return;
  for(let i=0;i<steps.length;i++){if(!validStep(i)){showStep(i);return;}}
  busy=true;filesInput.disabled=true;renderFiles();const button=document.querySelector('#send-application');button.disabled=true;button.textContent='بنجهّز ملفك…';error.textContent='';
  try{
    const params=new URLSearchParams(location.search),body=Object.fromEntries(new FormData(form));
    body.request_key=requestKey;body.consent=form.elements.consent.checked;body.whatsapp_opt_in=form.elements.whatsapp_opt_in.checked;body.source=params.get('source')||'website';body.campaign=params.get('utm_campaign')||params.get('campaign')||'';
    body.link_token=params.get('client')||'';body.files=await Promise.all(selectedFiles.map(readFile));
    const response=await fetch('/public/registrations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),result=await response.json();
    if(!response.ok)throw new Error(result.error||'تعذر إرسال الطلب');
    form.hidden=true;document.querySelector('#application-success').hidden=false;
    document.querySelector('#registration-reference').textContent=result.reference;
    const link=document.querySelector('#receipt-link');link.href=result.receipt_url;link.download='Middle-East-'+result.reference+'.html';
    document.querySelector('#step-label').textContent='تم التسجيل';document.querySelector('#step-progress').style.width='100%';
    link.click();
  }catch(e){error.textContent=e.message;}finally{busy=false;filesInput.disabled=false;renderFiles();button.disabled=false;button.textContent='تأكيد التسجيل وإنشاء ملفي ←';}
});
try{const response=await fetch('/public/intake'),status=await response.json();if(!response.ok||!status.enabled){form.hidden=true;document.querySelector('#portal-status').textContent='التسجيل متوقف مؤقتًا. تواصل مع فريق ميد إيست على 01130343708.';}}catch{document.querySelector('#portal-status').textContent='تعذر التحقق من الاتصال؛ حاول إعادة فتح الصفحة.';}
