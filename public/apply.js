const form=document.querySelector('#application-form'),steps=[...form.querySelectorAll('[data-step]')],error=document.querySelector('#form-error');
let current=0,busy=false,requestKey=crypto.randomUUID().replaceAll('-','');
form.elements.academic_year.value=String(new Date().getFullYear());
function showStep(index){
  current=index;steps.forEach((step,i)=>{step.hidden=i!==index;});
  document.querySelector('#step-label').textContent='الخطوة '+(index+1)+' من 4';
  document.querySelector('#step-progress').style.width=((index+1)*25)+'%';
  document.querySelector('#previous-step').hidden=index===0;
  document.querySelector('#next-step').hidden=index===3;
  document.querySelector('#send-application').hidden=index!==3;error.textContent='';
  if(index===3){
    const target=document.querySelector('#review-data');target.replaceChildren();
    for(const [label,value] of [['الطالب',form.elements.name.value],['رقم التواصل',form.elements.phone.value],['الدراسة',form.elements.level.value+' · '+form.elements.certificate.value],['سنة التقديم',form.elements.academic_year.value],['المرفقات',String(document.querySelector('#intake-files').files.length)+' ملف']]){
      const row=document.createElement('div'),b=document.createElement('b'),span=document.createElement('span');b.textContent=label;span.textContent=value;row.append(b,span);target.append(row);
    }
  }
}
function validStep(index){for(const el of steps[index].querySelectorAll('input,select,textarea')){if(!el.checkValidity()){el.reportValidity();return false;}}return true;}
document.querySelector('#next-step').addEventListener('click',()=>{if(validStep(current))showStep(current+1);});
document.querySelector('#previous-step').addEventListener('click',()=>showStep(current-1));
form.addEventListener('keydown',event=>{if(event.key==='Enter'&&event.target.tagName==='INPUT'&&event.target.type!=='file'&&current<3){event.preventDefault();document.querySelector('#next-step').click();}});
const filesInput=document.querySelector('#intake-files');
filesInput.addEventListener('change',()=>{const files=[...filesInput.files],invalid=files.length>3||files.some(f=>f.size>5*1024*1024)||files.reduce((n,f)=>n+f.size,0)>10*1024*1024;filesInput.setCustomValidity(invalid?'اختار حتى 3 ملفات، بحد 5 ميجابايت لكل ملف و10 للمجموع':'');document.querySelector('#file-list').textContent=files.map(f=>f.name).join(' · ');if(invalid)filesInput.reportValidity();});
const readFile=file=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(new Error('تعذر قراءة الملف'));reader.onload=()=>resolve({name:file.name,mime:file.type,content:String(reader.result).split(',')[1]});reader.readAsDataURL(file);});
form.addEventListener('submit',async event=>{
  event.preventDefault();if(busy)return;
  for(let i=0;i<steps.length;i++){if(!validStep(i)){showStep(i);return;}}
  busy=true;const button=document.querySelector('#send-application');button.disabled=true;button.textContent='بنجهّز ملفك…';error.textContent='';
  try{
    const params=new URLSearchParams(location.search),body=Object.fromEntries(new FormData(form));
    body.request_key=requestKey;body.consent=form.elements.consent.checked;body.whatsapp_opt_in=form.elements.whatsapp_opt_in.checked;body.source=params.get('source')||'website';body.campaign=params.get('utm_campaign')||params.get('campaign')||'';
    body.files=await Promise.all([...filesInput.files].map(readFile));
    const response=await fetch('/public/registrations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),result=await response.json();
    if(!response.ok)throw new Error(result.error||'تعذر إرسال الطلب');
    form.hidden=true;document.querySelector('#application-success').hidden=false;
    document.querySelector('#registration-reference').textContent=result.reference;
    const link=document.querySelector('#receipt-link');link.href=result.receipt_url;link.download='Middle-East-'+result.reference+'.html';
    document.querySelector('#step-label').textContent='تم التسجيل';document.querySelector('#step-progress').style.width='100%';
    link.click();
  }catch(e){error.textContent=e.message;}finally{busy=false;button.disabled=false;button.textContent='تأكيد التسجيل وإنشاء ملفي ←';}
});
try{const response=await fetch('/public/intake'),status=await response.json();if(!response.ok||!status.enabled){form.hidden=true;document.querySelector('#portal-status').textContent='التسجيل متوقف مؤقتًا. تواصل مع فريق ميد إيست على 01130343708.';}}catch{document.querySelector('#portal-status').textContent='تعذر التحقق من الاتصال؛ حاول إعادة فتح الصفحة.';}
