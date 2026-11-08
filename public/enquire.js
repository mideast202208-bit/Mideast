import { countries } from './countries.js';
import { requestedService, services } from './services.js';

const form=document.querySelector('#enquiry-form');
const button=form.querySelector('button');
const error=document.querySelector('#enquiry-error');
const params=new URLSearchParams(location.search);
const source=params.get('source')||'website';
const campaign=(params.get('utm_campaign')||params.get('campaign')||'').slice(0,150);
const selectedService=requestedService(params);
const requestKey=crypto.randomUUID();
const applyParams=new URLSearchParams({source,campaign});
if(services.includes(selectedService))applyParams.set('interest',selectedService);
document.querySelector('#full-application').href='/apply?'+applyParams;

for(const country of countries.filter(item=>item.dial)){
  form.elements.phone_country.add(new Option(country.name+' ('+country.dial+')',country.code));
}
form.elements.phone_country.value='EG';
for(const service of services)form.elements.service.add(new Option(service,service));
form.elements.service.value=services.includes(selectedService)?selectedService:'استشارة وتواصل مع الفريق';

if(params.get('embed')==='1'){
  document.body.classList.add('embedded');
  if(window.parent!==window&&document.referrer){
    const parentOrigin=new URL(document.referrer).origin;
    if(['https://mideastedu-eg.com','https://www.mideastedu-eg.com'].includes(parentOrigin)){
      const report=()=>window.parent.postMessage({type:'mideast-platform-form-height',height:document.body.scrollHeight},parentOrigin);
      new ResizeObserver(report).observe(document.body);
      report();
    }
  }
}

form.addEventListener('submit',async event=>{
  event.preventDefault();
  if(button.disabled)return;
  button.disabled=true;
  error.textContent='';
  const data=Object.fromEntries(new FormData(form));
  data.consent=form.elements.consent.checked;
  data.whatsapp_opt_in=form.elements.whatsapp_opt_in.checked;
  try{
    const response=await fetch('/public/enquiries',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({...data,source,campaign,request_key:requestKey})
    });
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||'تعذر إرسال الاستفسار');
    form.hidden=true;
    document.querySelector('#enquiry-reference').textContent=result.reference;
    document.querySelector('#enquiry-success').hidden=false;
  }catch(err){error.textContent=err.message||'تعذر الاتصال، أعد المحاولة';}
  finally{button.disabled=false;}
});

try{
  const response=await fetch('/public/intake');
  if(!response.ok)throw new Error();
  if((await response.json()).enabled)button.disabled=false;
  else error.textContent='استقبال الاستفسارات متوقف مؤقتًا. استخدم صفحة التواصل على موقعنا.';
}catch{error.textContent='تعذر الاتصال، أعد فتح الصفحة للمحاولة.';}
