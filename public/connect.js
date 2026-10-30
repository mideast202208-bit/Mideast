(()=>{
  'use strict';
  const origin=__CRM_ORIGIN__,hosts=['mideastedu-eg.com','www.mideastedu-eg.com'];
  if(!hosts.includes(location.hostname))return;
  const target=origin+'/apply';let pending=false;
  const legacyServices={'/regreg4':'تقديم طلب التحاق - جامعي','/postgradeaddmission':'تقديم طلب التحاق - دراسات عليا','/regsre3':'تحويل من الخارج','/sersw':'تعديل ترشيح - جامعي','/resres':'تصديق المستندات','/regre2':'استقبال من المطار وحجز فندقي'};
  let pathService=legacyServices[location.pathname.replace(/\/$/,'')];
  try{
    if(pathService)sessionStorage.setItem('me-crm-service-context',JSON.stringify({service:pathService,at:Date.now()}));
    else if(location.pathname.replace(/\/$/,'')==='/registration'){
      const saved=JSON.parse(sessionStorage.getItem('me-crm-service-context')||'null');sessionStorage.removeItem('me-crm-service-context');
      const explicit=new URLSearchParams(location.search);
      if(!explicit.get('service')&&!explicit.get('interest')&&!explicit.get('requested_service')&&saved&&Date.now()-saved.at>=0&&Date.now()-saved.at<120000)pathService=saved.service;
    }
  }catch{}
  function frameUrl(value,popup){
    const old=new URL(value,location.href),query=new URLSearchParams(old.search);
    if(!query.has('source'))query.set('source',new URLSearchParams(location.search).get('source')||'website');
    if(!query.has('interest')&&pathService)query.set('interest',pathService);
    if(popup)query.set('utm_campaign','website_popup');query.set('embed','1');return target+'?'+query;
  }
  function connect(){
    pending=false;
    document.querySelectorAll('a[href]').forEach(a=>{
      try{const raw=a.getAttribute('href'),url=new URL(a.href,location.href);
        const legacy=legacyServices[url.pathname.replace(/\/$/,'')];
        if(legacy&&url.hostname===location.hostname){url.searchParams.set('interest',legacy);url.searchParams.set('source',new URLSearchParams(location.search).get('source')||'website');a.href=target+'?'+url.searchParams;}
        if(raw&&!raw.startsWith('#')&&url.hostname===location.hostname&&url.pathname.replace(/\/$/,'')==='/registration'){
          if(!url.searchParams.has('source'))url.searchParams.set('source',new URLSearchParams(location.search).get('source')||'website');
          a.href=target+'?'+url.searchParams;
        }
        const destination=new URL(a.href,location.href);
        if(destination.origin===origin&&destination.pathname==='/apply'){
          if(!destination.searchParams.has('interest')){
            const label=a.textContent||'';let service='';
            if(/تحويل من الخارج/.test(label))service='تحويل من الخارج';
            else if(/دراسات|درسات/.test(label))service='تقديم طلب التحاق - دراسات عليا';
            else if(destination.searchParams.get('service')==='بكالوريوس')service='تقديم طلب التحاق - جامعي';
            if(service){destination.searchParams.set('interest',service);a.href=destination.href;}
          }
          if(!a.closest('#me-quick-contact'))a.dataset.mideastPopup='1';
        }
      }catch{}
    });
    document.querySelectorAll('form').forEach(form=>{
      if(form.getAttribute('role')==='search'||form.querySelector('input[type="search"]'))return;
      const contactForm=form.querySelector('input[type="email"],input[type="tel"]')&&form.querySelector('textarea');
      if(!pathService&&!contactForm)return;
      const frame=document.createElement('iframe'),box=document.createElement('section'),note=document.createElement('p');
      const url=new URL(target);url.searchParams.set('interest',pathService||'استشارة وتواصل مع الفريق');url.searchParams.set('source',new URLSearchParams(location.search).get('source')||'website');
      frame.src=frameUrl(url.href,false);frame.title='التسجيل مع ميد إيست';frame.dataset.mideastPlatform='1';frame.style.cssText='width:100%;border:0;min-height:680px';
      note.textContent='طلبك ومستنداتك تُسجل في ملف العميل لدى فريق ميد إيست.';box.append(note,frame);form.replaceWith(box);
    });
    document.querySelectorAll('iframe[src]').forEach(frame=>{
      try{const url=new URL(frame.src),popup=!!frame.closest('#me-quick-contact');
        if(url.hostname==='middle-east-education-services.odoo.com'&&url.pathname.replace(/\/$/,'')==='/contactus'){
          frame.src=frameUrl(frame.src,popup);frame.title='التسجيل مع ميد إيست';frame.dataset.mideastPlatform='1';
          frame.style.width='100%';frame.style.border='0';frame.style.minHeight=popup?'540px':'680px';
        }
      }catch{}
    });
    if(location.pathname.replace(/\/$/,'')==='/ourservices')document.querySelectorAll('main article').forEach(card=>{
      if(card.dataset.meServiceBrand)return;
      const image=card.querySelector('img'),heading=card.querySelector('h3');if(!image||!heading)return;
      const title=heading.textContent||'',kind=/تدريب|دورات/.test(title)?'training':/تحويل|ترشيح|نقل|سحب|تأجيل/.test(title)?'transfer':'study';
      const paths={study:'M2 9l10-6 10 6-10 6z M6 12v6c4 3 8 3 12 0v-6 M22 9v9',transfer:'M3 7h15l-4-4 M18 7l-4 4 M21 17H6l4 4 M6 17l4-4',training:'M3 4h18v13H3z M8 21l4-4 4 4 M8 8h8 M8 12h5'};
      const art=document.createElement('div');art.className='me-service-brand-art';art.setAttribute('role','img');art.setAttribute('aria-label',title);
      art.innerHTML='<span><svg viewBox="0 0 24 24" width="52" height="52" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="'+paths[kind]+'"/></svg></span><small>MIDDLE EAST · STUDENT SERVICES</small>';
      (image.closest('picture')||image).replaceWith(art);card.dataset.meServiceBrand='1';
    });
    const popup=document.getElementById('me-quick-contact');
    if(popup&&!popup.dataset.crmEnhanced){
      popup.dataset.crmEnhanced='1';popup.setAttribute('aria-label','التسجيل مع ميد إيست');
      const close=popup.querySelector('#me-quick-close');if(close)close.setAttribute('aria-label','إغلاق التسجيل');
      const continuation=popup.querySelector('.me-continue');
      if(continuation){
        const note=document.createElement('p'),link=document.createElement('a');
        note.textContent='بياناتك ومستنداتك تصل لفريق المتابعة في ملف طلب واحد.';
        link.textContent='فتح التسجيل في صفحة مستقلة ↗';link.href=target+'?source=website&utm_campaign=website_popup';link.target='_blank';link.rel='noopener';
        continuation.replaceChildren(note,link);
      }
    }
    document.querySelectorAll('main h1').forEach(h=>{if(h.textContent.trim()==='التسجيل بالخمس خطوات')h.textContent='ابدأ طلبك مع ميد إيست';});
    document.querySelectorAll('main div').forEach(e=>{if(!e.children.length&&e.textContent.trim()==='الخدمة ← تفاصيل الطلب ← التواصل ← المستندات ← المراجعة')e.textContent='الدراسة ← التواصل ← المستندات ← تأكيد التسجيل';});
  }
  function schedule(){if(!pending){pending=true;requestAnimationFrame(connect);}}
  document.addEventListener('click',event=>{
    const link=event.target.closest?.('a[data-mideast-popup]');
    if(!link||event.defaultPrevented||event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey||link.target==='_blank')return;
    const popup=document.getElementById('me-quick-contact'),frame=popup?.querySelector('iframe');
    if(!popup||!frame||typeof popup.showModal!=='function')return;
    event.preventDefault();const url=new URL(frameUrl(link.href,true));
    if(frame.src!==url.href)frame.src=url.href;
    frame.title='التسجيل مع ميد إيست';frame.dataset.mideastPlatform='1';frame.style.width='100%';frame.style.border='0';
    if(!popup.open)popup.showModal();
  });
  const style=document.createElement('style');
  style.textContent='.me-service-brand-art{height:180px;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:19px;background:radial-gradient(ellipse at 80% 10%,#cee5dcaa,transparent 65%),linear-gradient(140deg,#f4f7ed,#e6f1ee);border-bottom:1px solid #dbe8e1;position:relative;color:#174b50;overflow:hidden}.me-service-brand-art>span{display:grid;place-items:center;width:92px;height:92px;background:#ffffffb5;border:1px solid #c4dcd1;border-radius:25px;box-shadow:0 12px 24px #183a4210}.me-service-brand-art small{font:8px/1.5 Arial;letter-spacing:2px;color:#5c8279}.o-livechat-root{display:none!important}#me-quick-contact{width:min(760px,calc(100vw - 20px))!important;max-height:92dvh!important;padding:0!important;border:0!important;border-radius:18px!important;overflow:auto!important;color:#173f3c!important;background:#fff!important}#me-quick-contact::backdrop{background:#0b263eaa;backdrop-filter:blur(4px)}#me-quick-contact .me-quick-top{position:sticky;top:0;z-index:2;background:#fff;border-bottom:1px solid #dfebe4;padding:14px 20px}#me-quick-close{min-width:44px;min-height:44px;cursor:pointer}#me-quick-contact iframe{display:block;max-width:100%;min-height:540px!important}#me-quick-contact .me-continue{padding:14px 20px;background:#f2f8f3;border-top:1px solid #dfebe4;font:12px/1.8 Tahoma,Arial}#me-quick-contact .me-continue a{display:inline-block;background:#173f3c;color:white;padding:10px 18px;border-radius:9px;text-decoration:none}@media(max-width:600px){#me-quick-contact{width:calc(100vw - 12px)!important;max-height:96dvh!important;border-radius:12px!important}#me-quick-contact .me-quick-top{padding:8px 12px}#me-quick-contact .me-continue{padding:10px 15px}}';
  (document.head||document.documentElement).append(style);
  window.addEventListener('message',event=>{
    if(event.origin!==origin||event.data?.type!=='mideast-platform-form-height')return;
    document.querySelectorAll('iframe[data-mideast-platform]').forEach(frame=>{
      if(event.source===frame.contentWindow&&Number.isFinite(event.data.height))frame.style.height=Math.min(3000,Math.max(540,event.data.height+20))+'px';
    });
  });
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',schedule);else schedule();
  new MutationObserver(schedule).observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['src']});
})();
