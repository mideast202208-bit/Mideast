const states={active:'يديرها الوكيل',handoff:'محولة إلى الفريق',paused:'استلمها موظف',stopped:'المتابعة متوقفة'};
const reasons={finance:'سؤال مالي',official_fee:'رسوم رسمية معتمدة',registration_link:'رابط تسجيل',documents:'مستندات واردة',human:'طلب موظف أو شكوى',uncertain:'يحتاج تحققًا',sensitive:'بيانات خاصة أو مرفق',provider:'تعذر التصنيف',window:'انتهت نافذة واتساب',staff:'استلام بشري',stop:'طلب إيقاف المتابعة',greet:'ترحيب',qualify:'تحديد الاحتياج',approved_source:'مصدر معتمد',AGENT_SETTINGS_CHANGED:'تغيّر الإعداد',AGENT_HUMAN_TAKEOVER:'استلام بشري',AGENT_DOCUMENT_HANDOFF:'استلام مستندات',AGENT_OPT_OUT:'إيقاف بطلب العميل',AGENT_INACTIVE:'الوكيل غير نشط'};
const replyLabels={greet:'الترحيب',certificate:'السؤال عن الشهادة',subject:'السؤال عن التخصص',university:'السؤال عن الجامعة',uncertain:'معلومة تحتاج مراجعة',finance:'تحويل السؤال المالي',human:'التحويل لموظف'};
const feeLabels={application:'رسوم التقديم',ministry:'رسوم القيد للوزارة',university:'باقي رسوم القيد للجامعة',medical:'رسوم التأمين الطبي'};
const deliveries={queued:'في الطابور',accepted:'قبلتها Meta',sent:'أُرسلت',delivered:'تم التسليم',read:'مقروءة',unknown:'النتيجة غير مؤكدة',failed:'فشل الإرسال',blocked:'توقف الإرسال'};
const date=value=>value?new Date(value).toLocaleString('ar-EG'):'—';

export function createCustomerAgent({api,escape:e,modal,bindForm,toast,render,getUser,openLead,openContact,openWhatsApp}){
  let dashboard;
  async function load(){dashboard=await api('/customer-agent');}
  function reset(){dashboard=null;}
  function view(){
    const d=dashboard;
    if(!d)return '<h1>وكيل خدمة العملاء الذكي</h1><p>جارٍ التحميل…</p>';
    const metrics=[['المحادثات',d.metrics.conversations],['العملاء الجدد',d.metrics.new_customers],['فرص تحتاج متابعة',d.metrics.followups],['بانتظار تدخل بشري',d.metrics.handoffs]];
    const scope=d.enabled?'تجربة واتساب محدودة':'متوقف';
    return `<header class="pagehead"><div><h1>وكيل خدمة العملاء الذكي</h1><p class="sub">التعليمات والمعرفة والتجربة وسجل التدخل البشري.</p></div><button type="button" class="btn" data-action="agent-refresh">تحديث</button></header>
    <section class="panel"><h2>التحكم والتجربة</h2><p><b>${e(scope)}</b> · ${d.provider_ready?'إعداد المزود متاح على الخادم':'المزوّد الخارجي غير مفعّل'}</p>
    <p class="sub">التجربة الحية محصورة في سجل واتساب واحد. الرسوم الرسمية تحتاج مصدرًا معتمدًا. أسئلة أتعاب المكتب والمستندات الواردة تتحوّل للإدارة.</p>
    <div class="actions"><button type="button" class="btn primary" data-action="agent-preview">اختبار اصطناعي</button>
    <button type="button" class="btn" data-action="agent-settings">الإعدادات والتعليمات</button>
    ${d.enabled?'<button type="button" class="btn" data-action="agent-stop">إيقاف الوكيل الآن</button>':''}</div></section>
    <section class="metrics" aria-label="مؤشرات الوكيل">${metrics.map(([label,value])=>'<article class="metric"><span>'+e(label)+'</span><strong>'+e(value??0)+'</strong></article>').join('')}</section>
    <section class="panel"><div class="panelhead"><h2>مصادر المعرفة</h2><button type="button" class="btn" data-action="agent-source">إضافة سؤال ومصدر</button></div>
    <p class="sub">راجع الإجابة ورابطها وتاريخ صلاحيتها قبل اعتمادها. المصادر المنتهية لا تُستخدم.</p>
    ${d.sources.map(source=>`<article class="fieldcard"><div><b>${e(source.title)}</b><p class="sub">${e(source.question)}</p>
      <p>${e(source.answer)}</p><p class="sub">${e({draft:'مسودة',approved:'معتمد',disabled:'موقوف'}[source.status])} · آخر تحديث ${e(date(source.updated_at))}${source.reviewed_until?' · صالح حتى '+e(date(source.reviewed_until)):''}${source.reviewer?' · '+e(source.reviewer):''}</p>
      ${source.url?'<a href="'+e(source.url)+'" target="_blank" rel="noopener noreferrer">فتح المصدر العام</a>':''}</div>
      <button type="button" class="btn small" data-action="agent-source" data-id="${e(source.id)}">مراجعة وتعديل</button></article>`).join('')||'<p>أضف أول مصدر.</p>'}</section>
    <section class="panel"><h2>المحادثات والتدخل البشري</h2>
    ${d.threads.map(item=>`<article class="fieldcard"><div><b>${e(item.name)}</b><p class="sub">${e(states[item.state])} · ${e(reasons[item.reason]||'بانتظار الرد')} · ${e(date(item.updated_at))}</p>
    <p>${e(item.summary)}</p><p>${e(item.next_step)}</p>${item.delivery_status?'<p class="sub">'+e(deliveries[item.delivery_status]||item.delivery_status)+(item.delivery_error?' · '+e(item.delivery_error):'')+'</p>':''}</div>
    <div class="actions"><button type="button" class="btn small" data-action="agent-lead" data-id="${e(item.lead_id)}">الفرصة</button>
    <button type="button" class="btn small" data-action="agent-chat" data-id="${e(item.contact_id)}">فتح محادثة واتساب</button>
    ${item.state!=='stopped'?'<button type="button" class="btn small" data-action="agent-'+(item.state==='active'?'pause':'resume')+'" data-id="'+e(item.contact_id)+'">'+(item.state==='active'?'استلام المحادثة':'استئناف')+'</button>':''}</div></article>`).join('')||'<p>لا توجد محادثات ضمن تجربة الوكيل بعد.</p>'}</section>
    <div class="grid2"><section class="panel"><h2>أسباب التحويل والإيقاف</h2>
    ${d.reasons.filter(item=>!['greet','qualify','approved_source','official_fee','registration_link'].includes(item.reason)).map(item=>'<p>'+e(reasons[item.reason]||item.reason)+' · '+e(item.count)+'</p>').join('')||'<p>لا توجد حالات مسجلة بعد.</p>'}</section>
    <section class="panel"><h2>سجل التعديلات</h2>${d.history.map(item=>'<p>'+e(({agent_settings_changed:'حُفظت إعدادات الوكيل',agent_source_draft:'حُفظت مسودة',agent_source_approved:'اعتمد مصدر',agent_source_disabled:'أوقف مصدر'})[item.action]||item.action)+' · '+e(item.actor||'النظام')+' · '+e(date(item.created_at))+'</p>').join('')||'<p>لا توجد تعديلات بعد.</p>'}</section></div>`;
  }

  function preview(){
    const form=modal('اختبار الوكيل', `<p class="sub">استخدم رسالة وتعليمات اصطناعية أو عامة. هذه الشاشة لا ترسل شيئًا على واتساب.</p>
      <label>رسالة الاختبار<textarea name="body" rows="4" maxlength="1600" required></textarea></label>
      ${dashboard.provider_ready?'<label>تعليمات تجريبية غير محفوظة<textarea name="instructions" rows="3" maxlength="1500">'+e(dashboard.instructions)+'</textarea></label><label><input type="checkbox" name="provider"> استخدم المزوّد لتصنيف كلمات الموضوع. أؤكد أن الرسالة اصطناعية والتعليمات عامة.</label>':''}
      <div data-agent-preview role="status"></div>`,'جرّب الرد');
    form.addEventListener('submit',async event=>{
      event.preventDefault();
      const button=form.querySelector('[type=submit]'),result=form.querySelector('[data-agent-preview]');
      button.disabled=true;
      try{
        const input=new FormData(form),provider=input.has('provider');
        const value=await api('/customer-agent/preview','POST',{body:input.get('body'),provider,synthetic:provider,instructions:input.get('instructions')});
        result.innerHTML='<p><b>'+e(reasons[value.reason]||value.reason)+'</b> · '+(value.mode==='provider_preview'?'اختبار المزوّد':'اختبار محلي')+'</p><p>'+e(value.reply||'')+'</p>';
      }catch(error){result.textContent=error.message;}
      finally{button.disabled=false;}
    });
  }

  async function action(name,id){
    if(!name.startsWith('agent-'))return false;
    if(name==='agent-lead'){await openLead(id);return true;}
    if(name==='agent-chat'){await openContact(id);await openWhatsApp(dashboard.threads.find(row=>row.contact_id===id)?.phone_id);return true;}
    if(name==='agent-pause'||name==='agent-resume'){
      const resume=name==='agent-resume';
      await api('/customer-agent/contacts/'+encodeURIComponent(id),'PATCH',{action:resume?'resume':'pause'});
      const area=document.querySelector('dialog[open] [data-agent-contact]');
      if(area)await mount(area,id);
      else{await load();render();}
      toast(resume?'الوكيل ينتظر رسالة جديدة':'تم إيقاف الرد الآلي لهذه المحادثة');
      return true;
    }
    if(name==='agent-preview'){preview();return true;}
    if(name==='agent-refresh'){await load();render();return true;}
    if(name==='agent-stop'){
      await api('/customer-agent/settings','PATCH',{enabled:false});await load();render();toast('تم إيقاف الوكيل');return true;
    }
    if(name==='agent-settings'){
      const d=dashboard;
      const candidates=d.candidates.length===1?'<option value="'+e(d.candidates[0].id)+'" '+(d.pilot_contact_id===d.candidates[0].id?'selected':'')+'>'+e(d.candidates[0].name)+' · ‎••'+e(d.candidates[0].suffix)+'</option>':'';
      const form=modal('إعدادات وتعليمات الوكيل',`<label>تعليمات عامة للوكيل<textarea name="instructions" rows="4" maxlength="1500">${e(d.instructions)}</textarea></label>
       <p class="sub">اكتب نطاق الإجابة وكيف يختار المعلومة. لتحديد الكلام الذي يراه العميل اكتب صياغتك في الردود التالية أو في مصدر معرفة معتمد.</p>
       <details><summary>الردود التي أريد الوكيل يقولها</summary>${Object.entries(replyLabels).map(([key,label])=>'<label>'+e(label)+'<textarea name="reply_'+key+'" rows="2" maxlength="420" placeholder="'+e(d.default_replies[key])+'">'+e(d.replies[key]||'')+'</textarea></label>').join('')}</details>
       <label>عبارات ممنوع قولها<textarea name="forbidden" rows="4" maxlength="1200" placeholder="اكتب عبارة واحدة في كل سطر">${e(d.forbidden.join('\n'))}</textarea></label>
       <p class="sub">العبارات الممنوعة تُفحص قبل الإرسال. رابط التسجيل يُرسل في أول تواصل فقط، وتستمر المتابعة على نفس الطلب. أضف الرسوم الرسمية من مصادر المعرفة بعد مراجعتها.</p>
       <label>اسم صاحب رقم الاختبار<input name="pilot_name" maxlength="120" value="${e(d.pilot_name)}"></label>
       <label>آخر أرقام الهاتف<input name="pilot_suffix" inputmode="numeric" dir="ltr" maxlength="6" value="${e(d.pilot_suffix)}"></label>
       <p class="sub">احفظ الاسم ونهاية الرقم والوكيل متوقف، ثم ارجع لاختيار السجل المطابق.</p>
       <label>نطاق التجربة<select name="pilot_contact_id"><option value="">اختر السجل المؤكد</option>${candidates}</select></label>
       ${d.candidates.length===1?'':'<p class="sub">التفعيل معلق إلى أن يتوفر تطابق فريد لسجل الاختبار.</p>'}
       <label><input type="checkbox" name="enabled" ${d.enabled?'checked':''} ${d.provider_ready?'':'disabled'}> تشغيل الوكيل على محادثة واتساب التجريبية</label>`);
      bindForm(form,v=>api('/customer-agent/settings','PATCH',{enabled:v.has('enabled'),instructions:v.get('instructions'),forbidden:v.get('forbidden'),replies:Object.fromEntries(Object.keys(replyLabels).map(key=>[key,v.get('reply_'+key)])),pilot_name:v.get('pilot_name'),pilot_suffix:v.get('pilot_suffix'),pilot_contact_id:v.get('pilot_contact_id')}));
      return true;
    }
    if(name==='agent-source'){
      const current=dashboard.sources.find(source=>source.id===id);
      const form=modal(current?'مراجعة مصدر المعرفة':'إضافة مصدر معرفة',`<label>العنوان<input name="title" required maxlength="160" value="${e(current?.title||'')}"></label>
       <label>السؤال أو الكلمات الدالة<input name="question" required maxlength="250" value="${e(current?.question||'')}"></label>
       <label>رابط صفحة موقع الشركة (اختياري)<input dir="ltr" name="url" type="url" maxlength="300" value="${e(current?.url||'')}"></label>
       <button type="button" class="btn small" data-agent-website>جلب نص الصفحة للمراجعة</button><p class="sub" data-agent-website-result role="status" style="white-space:pre-wrap" hidden></p>
       <label>الإجابة المعتمدة للعميل<textarea name="answer" rows="5" maxlength="600">${e(current?.official_fee?'':current?.answer||'')}</textarea></label>
       <details ${current?.official_fee?'open':''}><summary>إضافة رسم رسمي منشور</summary>
       <label>بند رسمي<select name="fee_kind"><option value="">إجابة عامة</option>${Object.entries(feeLabels).map(([key,label])=>'<option value="'+key+'" '+(current?.official_fee?.kind===key?'selected':'')+'>'+e(label)+'</option>').join('')}</select></label>
       <label>المبلغ المنشور<input name="fee_amount" type="number" min="1" max="999999" value="${e(current?.official_fee?.amount||'')}"></label>
       <label>العملة<select name="fee_currency"><option value="USD">دولار أمريكي</option><option value="EGP" ${current?.official_fee?.currency==='EGP'?'selected':''}>جنيه مصري</option></select></label></details>
       <label>حالة المصدر<select name="status"><option value="draft">مسودة</option><option value="approved" ${current?.status==='approved'?'selected':''}>اعتماد هذه الإجابة بعد مراجعتها</option><option value="disabled" ${current?.status==='disabled'?'selected':''}>إيقاف</option></select></label>
       <label>صالح للمراجعة حتى<input type="date" name="reviewed_until" value="${e(current?.reviewed_until?.slice(0,10)||'')}"></label>`);
      const websiteButton=form.querySelector('[data-agent-website]'),websiteResult=form.querySelector('[data-agent-website-result]');
      websiteButton.addEventListener('click',async()=>{
        websiteButton.disabled=true;websiteResult.hidden=false;websiteResult.textContent='جارٍ جلب الصفحة…';
        try{
          const value=await api('/customer-agent/sources/website-preview','POST',{url:form.elements.url.value});
          form.elements.url.value=value.url;
          if(!form.elements.title.value)form.elements.title.value=value.title;
          websiteResult.textContent=value.excerpt;
        }catch(error){websiteResult.textContent=error.message;}finally{websiteButton.disabled=false;}
      });
      bindForm(form,v=>api('/customer-agent/sources','POST',{title:v.get('title'),question:v.get('question'),answer:v.get('answer'),url:v.get('url'),status:v.get('status'),reviewed_until:v.get('reviewed_until'),official_fee:v.get('fee_kind')?{kind:v.get('fee_kind'),amount:Number(v.get('fee_amount')),currency:v.get('fee_currency')}:null,...(current?{id:current.id}:{})}));
      return true;
    }
    return false;
  }

  async function mount(area,id,leadId=null){
    area.dataset.agentContact=id;
    const row=await api('/customer-agent/contacts/'+encodeURIComponent(id));
    if(!area.isConnected||!row||(leadId&&row.lead_id!==leadId))return;
    const canResume=getUser()?.role==='admin'&&['paused','handoff'].includes(row.state);
    area.innerHTML='<article class="notebox"><b>متابعة وكيل خدمة العملاء · '+e(states[row.state]||row.state)+'</b><p>'+e(row.summary||'')+'</p><p>'+e(row.next_step||'')+'</p>'+
      (row.state==='active'?'<button type="button" class="btn small" data-action="agent-pause" data-id="'+e(id)+'">استلام وإيقاف الوكيل</button>':'')+
      (canResume?'<button type="button" class="btn small" data-action="agent-resume" data-id="'+e(id)+'">استئناف الوكيل</button>':'')+'</article>';
  }
  return {load,reset,view,action,mount};
}
