(()=>{
  'use strict';
  const origin=__CRM_ORIGIN__,hosts=['mideastedu-eg.com','www.mideastedu-eg.com'];
  if(!hosts.includes(location.hostname))return;
  const target=origin+'/apply';let pending=false;
  function frameUrl(value,popup){
    const old=new URL(value,location.href),query=new URLSearchParams(old.search);
    if(!query.has('source'))query.set('source',new URLSearchParams(location.search).get('source')||'website');
    if(popup)query.set('utm_campaign','website_popup');query.set('embed','1');return target+'?'+query;
  }
  function connect(){
    pending=false;
    document.querySelectorAll('a[href]').forEach(a=>{
      try{const raw=a.getAttribute('href'),url=new URL(a.href,location.href);
        if(raw&&!raw.startsWith('#')&&url.hostname===location.hostname&&url.pathname.replace(/\/$/,'')==='/registration'){
          if(!url.searchParams.has('source'))url.searchParams.set('source',new URLSearchParams(location.search).get('source')||'website');
          a.href=target+'?'+url.searchParams;
        }
      }catch{}
    });
    document.querySelectorAll('iframe[src]').forEach(frame=>{
      try{const url=new URL(frame.src),popup=!!frame.closest('#me-quick-contact');
        if(url.hostname==='middle-east-education-services.odoo.com'&&url.pathname.replace(/\/$/,'')==='/contactus'){
          frame.src=frameUrl(frame.src,popup);frame.title='التسجيل مع ميد إيست';frame.dataset.mideastPlatform='1';
          frame.style.width='100%';frame.style.border='0';frame.style.minHeight=popup?'540px':'680px';
        }
      }catch{}
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
  const style=document.createElement('style');
  style.textContent='#me-quick-contact{width:min(760px,calc(100vw - 20px))!important;max-height:92dvh!important;padding:0!important;border:0!important;border-radius:18px!important;overflow:auto!important;color:#173f3c!important;background:#fff!important}#me-quick-contact::backdrop{background:#0b263eaa;backdrop-filter:blur(4px)}#me-quick-contact .me-quick-top{position:sticky;top:0;z-index:2;background:#fff;border-bottom:1px solid #dfebe4;padding:14px 20px}#me-quick-close{min-width:44px;min-height:44px;cursor:pointer}#me-quick-contact iframe{display:block;max-width:100%;min-height:540px!important}#me-quick-contact .me-continue{padding:14px 20px;background:#f2f8f3;border-top:1px solid #dfebe4;font:12px/1.8 Tahoma,Arial}#me-quick-contact .me-continue a{display:inline-block;background:#173f3c;color:white;padding:10px 18px;border-radius:9px;text-decoration:none}@media(max-width:600px){#me-quick-contact{width:calc(100vw - 12px)!important;max-height:96dvh!important;border-radius:12px!important}#me-quick-contact .me-quick-top{padding:8px 12px}#me-quick-contact .me-continue{padding:10px 15px}}';
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
