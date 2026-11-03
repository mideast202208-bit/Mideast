import {services,nonAcademicServices,requestedService} from './services.js';
import {countries} from './countries.js';
import {documentTypes} from './documents.js';
const form=document.querySelector('#application-form'),steps=[...form.querySelectorAll('[data-step]')],error=document.querySelector('#form-error');

for(const country of countries){const option=document.createElement('option');option.value=country.code;option.textContent=country.name;form.elements.nationality_code.append(option);if(country.dial){const phoneOption=option.cloneNode(true);phoneOption.textContent=country.name+' ('+country.dial+')';form.elements.phone_country.append(phoneOption);}}
form.elements.phone_country.value='EG';
function phonePreview(){
 const input=form.elements.phone,preview=document.querySelector('#phone-preview');input.setCustomValidity('');
 if(!input.value){preview.textContent='';return;}
 const raw=input.value.replace(/[٠-٩]/g,d=>'٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[۰-۹]/g,d=>'۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/^\s*00/,'+');
 const phone=window.libphonenumber.parsePhoneNumberFromString(raw,{defaultCountry:form.elements.phone_country.value,extract:false});
 if(phone&&!phone.ext&&phone.isPossible()){preview.textContent=phone.number;preview.dir='ltr';preview.dataset.valid='true';}
 else{input.setCustomValidity('راجع رقم واتساب وكود الدولة');preview.textContent='أكمل الرقم وراجع كود الدولة';preview.dataset.valid='false';}
}
form.elements.phone.addEventListener('input',phonePreview);form.elements.phone_country.addEventListener('change',phonePreview);

let selectedFiles=[];
let current=0,busy=false,requestKey=crypto.randomUUID().replaceAll('-','');
form.elements.academic_year.value=String(new Date().getFullYear());
const initialParams=new URLSearchParams(location.search);
if(['بكالوريوس','ماجستير','دكتوراه'].includes(initialParams.get('service')))form.elements.level.value=initialParams.get('service');
const serviceSelect=form.elements.requested_service;
for(const label of ['طلب دراسة أو استشارة عامة',...services]){const option=document.createElement('option');option.value=label==='طلب دراسة أو استشارة عامة'?'':label;option.textContent=label;serviceSelect.append(option);}
const requested=requestedService(initialParams);
if(requested&&requested.length<=200){if(!services.includes(requested)){const option=document.createElement('option');option.value=requested;option.textContent=requested;serviceSelect.append(option);}serviceSelect.value=requested;}
function updateService(){
 const nonAcademic=nonAcademicServices.includes(serviceSelect.value);
 const intro=steps[0];intro.querySelector('.portal-kicker').textContent=nonAcademic?'خدمتك في مكان واحد':'الدراسة اللي بتطمح لها';
 intro.querySelector('h2').textContent=nonAcademic?'نرتّب طلبك.':'نبدأ من هدفك.';
 intro.querySelector('.portal-sub').textContent=nonAcademic?'اختار الخدمة اللي محتاجها، وفريقنا هيراجع التفاصيل معاك.':'مش لازم تكون حددت الجامعة؛ نقدر نساعدك تختار.';
 form.elements.level.closest('label').hidden=nonAcademic;
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
  if(index<0||index>=steps.length)return;
  current=index;steps.forEach((step,i)=>{step.hidden=i!==index;});
  document.querySelector('#step-label').textContent='الخطوة '+(index+1)+' من '+steps.length;
  document.querySelector('#step-progress').style.width=((index+1)/steps.length*100)+'%';
  document.querySelector('#previous-step').hidden=index===0;
  document.querySelector('#next-step').hidden=index===steps.length-1;
  document.querySelector('#send-application').hidden=index!==steps.length-1;error.textContent='';
  if(index===steps.length-1){
    const target=document.querySelector('#review-data');target.replaceChildren();
    for(const [label,value] of [['الخدمة',serviceSelect.value||'طلب دراسة أو استشارة عامة'],['الطالب',form.elements.name.value],['رقم التواصل',document.querySelector('#phone-preview').textContent||form.elements.phone.value],['الجنسية',countries.find(c=>c.code===form.elements.nationality_code.value)?.name||''],['الدراسة',form.elements.level.value+' · '+form.elements.certificate.value],['سنة التقديم',form.elements.academic_year.value],['المرفقات',String(selectedFiles.length)+' ملف']]){
      const row=document.createElement('div'),b=document.createElement('b'),span=document.createElement('span');b.textContent=label;span.textContent=value;row.append(b,span);target.append(row);
    }
  }
}
function validStep(index){if(index===1)phonePreview();for(const el of steps[index].querySelectorAll('input,select,textarea')){if(!el.checkValidity()){el.reportValidity();return false;}}return true;}
document.querySelector('#next-step').addEventListener('click',()=>{if(validStep(current))showStep(current+1);});
document.querySelector('#previous-step').addEventListener('click',()=>showStep(current-1));
form.addEventListener('keydown',event=>{if(event.key==='Enter'&&event.target.tagName==='INPUT'&&event.target.type!=='file'&&current<steps.length-1){event.preventDefault();document.querySelector('#next-step').click();}});
const filesInput=document.querySelector('#intake-files');
const limits={maxFiles:12,maxFileMB:5,maxTotalMB:25};
const typeSelect=document.querySelector('#upload-document-type');
for(const label of Object.values(documentTypes)){const option=document.createElement('option');option.value=label;option.textContent=label;typeSelect.append(option);}
typeSelect.value=documentTypes.passport;
const fileMime=file=>file.type||({pdf:'application/pdf',jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png'}[file.name.split('.').pop().toLowerCase()]||'');
function renderFiles(){
  const list=document.querySelector('#file-list');list.replaceChildren();
  selectedFiles.forEach(({file,document_type},index)=>{
    const row=document.createElement('div'),name=document.createElement('span'),size=document.createElement('small'),remove=document.createElement('button');
    row.className='portal-file-row';name.textContent=file.name;size.textContent=Math.ceil(file.size/1024)+' KB';
    remove.type='button';remove.textContent='إزالة';remove.disabled=busy;remove.setAttribute('aria-label','إزالة '+file.name);
    remove.addEventListener('click',()=>{selectedFiles.splice(index,1);document.querySelector('#file-error').textContent='';renderFiles();});
    const category=document.createElement('select');category.setAttribute('aria-label','نوع '+file.name);category.disabled=busy;for(const label of Object.values(documentTypes)){const option=document.createElement('option');option.value=label;option.textContent=label;option.selected=label===document_type;category.append(option);}category.addEventListener('change',()=>{selectedFiles[index].document_type=category.value;renderFiles();});
    row.append(name,category,size,remove);list.append(row);
  });
  const categories=document.querySelector('#document-categories');categories.replaceChildren();for(const [key,label] of Object.entries(documentTypes)){const card=document.createElement('button');card.type='button';card.className='document-category '+(typeSelect.value===label?'selected':'');const count=selectedFiles.filter(f=>f.document_type===label).length;card.textContent=label+' · '+count+' ملف';card.addEventListener('click',()=>{typeSelect.value=label;renderFiles();});categories.append(card);}
  document.querySelector('#file-count').textContent=selectedFiles.length+' / '+limits.maxFiles+' ملف · '+(selectedFiles.reduce((n,f)=>n+f.file.size,0)/1024/1024).toFixed(1)+' / '+limits.maxTotalMB+' MB';
}
function addFiles(batch){
  if(busy)return;
  const known=new Set(selectedFiles.map(({file:f})=>[f.name,f.size,f.lastModified].join('|'))),next=[...selectedFiles];
  for(const file of batch){const id=[file.name,file.size,file.lastModified].join('|');if(!known.has(id)){known.add(id);next.push({file,document_type:typeSelect.value});}}
  let message='';
  if(next.length>limits.maxFiles)message='الحد '+limits.maxFiles+' ملفًا. أزل بعض الملفات أولًا؛ لم نضف الدفعة الجديدة.';
  else if(next.some(({file:f})=>!['application/pdf','image/jpeg','image/png'].includes(fileMime(f))))message='المسموح PDF وJPG وPNG فقط؛ لم نضف الدفعة الجديدة.';
  else if(next.some(({file:f})=>f.size>limits.maxFileMB*1024*1024)||next.reduce((n,f)=>n+f.file.size,0)>limits.maxTotalMB*1024*1024)message='حد الملف '+limits.maxFileMB+' MB والمجموع '+limits.maxTotalMB+' MB؛ لم نضف الدفعة الجديدة.';
  if(!message)selectedFiles=next;
  document.querySelector('#file-error').textContent=message;filesInput.value='';renderFiles();
}
typeSelect.addEventListener('change',renderFiles);
filesInput.addEventListener('change',()=>addFiles([...filesInput.files]));
const drop=filesInput.closest('.portal-drop');
drop.addEventListener('dragover',event=>{event.preventDefault();drop.dataset.drag='true';});
drop.addEventListener('dragleave',()=>{delete drop.dataset.drag;});
drop.addEventListener('drop',event=>{event.preventDefault();delete drop.dataset.drag;addFiles([...event.dataTransfer.files]);});
renderFiles();showStep(0);
const readFile=({file,document_type})=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(new Error('تعذر قراءة الملف'));reader.onload=()=>resolve({name:file.name,document_type,mime:fileMime(file),content:String(reader.result).split(',')[1]});reader.readAsDataURL(file);});
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
