import {transaction} from './db.mjs';
import {hash,windowOpen} from './security.mjs';
import {audit,fail,getContact,manager,now,text,uid} from './service.mjs';
import {normalizeSearch} from './international.mjs';
import {agentAllowsReply,agentCandidates,agentCanQualify,agentDecision,agentIntent,agentModel,agentReplies,agentReplyKeys,approvedWebsiteUrl,chooseAgentSource,knowledgeReply,officialFeeAnswer,officialFeeTopic,registrationIntro,requestsAgentRegistration,safeAgentAnswer} from './customer-agent-policy.mjs';
import {registrationLink,resolveRegistrationLink,whatsappRegistrationOpportunity} from './intake-links.mjs';
import {companyKnowledge,companyKnowledgeReviewed} from './customer-agent-company.mjs';
import {previewWebsiteKnowledge} from './customer-agent-website.mjs';
import {requestWhatsAppFiles} from './request-documents.mjs';

const settingsKey = 'customer_agent.settings';
const handoffReasons = {
  finance:'سؤال عن أتعاب المكتب أو الدفع', human:'طلب موظف أو شكوى', uncertain:'المعلومة تحتاج تحققًا',
  sensitive:'بيانات خاصة تحتاج مراجعة', documents:'مستندات واردة تحتاج مراجعتك', provider:'تعذر تشغيل مزود التصنيف', window:'انتهت نافذة واتساب',
  staff:'استلام بشري', stop:'طلب إيقاف المتابعة'
};
const nextLabels = {certificate:'اسأل عن نوع الشهادة',subject:'اسأل عن التخصص',university:'اسأل عن الجامعة'};
const defaultSettings = {enabled:false,mode:'provider',company_knowledge:true,instructions:'',replies:{},forbidden:[],fees:{},manager_id:null,pilot_contact_id:null,pilot_phone_hash:null,pilot_name:'',pilot_suffix:'',phone_id:null,revision:0};

function settings(db){
  const row=db.prepare('SELECT value FROM settings WHERE key=?').get(settingsKey);
  return row?{...defaultSettings,...JSON.parse(row.value)}:{...defaultSettings};
}

function writeSettings(db,value){
  db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(settingsKey,JSON.stringify(value));
}

const nameWords=value=>String(value).trim().split(/\s+/).map(normalizeSearch).filter(Boolean).join(' ');

function pilotCandidates(db,cfg){
  if(!cfg.pilot_name||!cfg.pilot_suffix)return [];
  const expected=nameWords(cfg.pilot_name);
  return db.prepare('SELECT id,name,phone FROM contacts WHERE phone LIKE ?').all('%'+cfg.pilot_suffix)
    .filter(contact=>{
      const actual=nameWords(contact.name);
      return actual===expected||actual.startsWith(expected+' ');
    });
}

function providerReady(env){
  return env.RECOVERY_MODE!=='1'&&env.CUSTOMER_AGENT_OPENAI_APPROVED==='1'&&Boolean(env.CUSTOMER_AGENT_OPENAI_KEY?.trim());
}

function engineReady(env,cfg){
  return env.RECOVERY_MODE!=='1'&&(cfg.mode==='local'||providerReady(env));
}

function pilotIdentity(db,cfg,contact,phoneId){
  if(!contact||cfg.pilot_contact_id!==contact.id||
      cfg.phone_id!==phoneId||hash(contact.phone??'')!==cfg.pilot_phone_hash)return false;
  const matches=pilotCandidates(db,cfg);
  return matches.length===1&&matches[0].id===contact.id;
}

function pilotEligible(db,env,cfg,contact,phoneId){
  return cfg.enabled&&engineReady(env,cfg)&&pilotIdentity(db,cfg,contact,phoneId);
}

export function trackedCustomerAgentLead(db,contact,phoneId){
  const cfg=settings(db);
  if(!pilotIdentity(db,cfg,contact,phoneId))return null;
  return db.prepare(`SELECT l.* FROM customer_agent_threads t JOIN conversations c ON c.id=t.conversation_id
    JOIN leads l ON l.id=t.lead_id AND l.contact_id=c.contact_id
    WHERE c.contact_id=? AND t.phone_id=?`).get(contact.id,phoneId);
}

function activeSources(db,cfg){
  const reviewed=db.prepare("SELECT id,title,question,answer,url,reviewed_until FROM customer_agent_sources WHERE status='approved' AND reviewed_until>? ORDER BY updated_at DESC").all(now())
    .filter(source=>agentAllowsReply(source.answer,cfg.forbidden))
    .map(source=>({...source,official_fee:Object.hasOwn(cfg.fees,source.id)?cfg.fees[source.id]:null}));
  if(cfg.mode==='local'&&cfg.company_knowledge)return [...reviewed,...companyKnowledge.filter(source=>agentAllowsReply(source.answer,cfg.forbidden))];
  return reviewed;
}

function thread(db,conversationId,phoneId){
  return db.prepare('SELECT * FROM customer_agent_threads WHERE conversation_id=? AND phone_id=?').get(conversationId,phoneId);
}

function cancelJobs(db,conversationId,phoneId,reason){
  db.prepare(`UPDATE messages SET status='blocked',error_code=?
    WHERE status='queued' AND id IN(SELECT outbound_id FROM customer_agent_jobs
      WHERE conversation_id=? AND (? IS NULL OR phone_id=?))`).run(reason,conversationId,phoneId,phoneId);
  db.prepare(`UPDATE customer_agent_jobs SET status='cancelled',reason=?
    WHERE status IN('queued','planning') AND conversation_id=? AND (? IS NULL OR phone_id=?)`).run(reason,conversationId,phoneId,phoneId);
}

function invalidateJobs(db){
  const rows=db.prepare(`SELECT DISTINCT j.conversation_id,j.phone_id FROM customer_agent_jobs j
    LEFT JOIN messages m ON m.id=j.outbound_id WHERE j.status IN('queued','planning') OR m.status='queued'`).all();
  for(const row of rows)cancelJobs(db,row.conversation_id,row.phone_id,'AGENT_SETTINGS_CHANGED');
}

export function recoverCustomerAgent(db){
  db.prepare("UPDATE customer_agent_jobs SET status='queued' WHERE status='planning'").run();
}

function agentOwner(db,cfg){
  return db.prepare("SELECT id FROM users WHERE active=1 AND role='admin' ORDER BY id IS NOT ?,created_at,id LIMIT 1").get(cfg.manager_id)?.id;
}

function recordDocuments(db,cfg,contactId,leadId,eventId,conversationId){
  const at=now();
  const event=db.prepare("INSERT OR IGNORE INTO crm_activity(kind,event_id,contact_id,lead_id,source,created_at) VALUES('agent_documents',?,?,?,?,?)").run(eventId,contactId,leadId,'whatsapp',at);
  if(!event.changes)return;
  const responsible=agentOwner(db,cfg);
  const title='وكيل خدمة العملاء · '+handoffReasons.documents;
  let taskId=db.prepare("SELECT id FROM tasks WHERE lead_id=? AND owner_id=? AND title=? AND status='open' LIMIT 1").get(leadId,responsible??null,title)?.id;
  if(responsible&&!taskId){
    taskId=uid();
    db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?)').run(taskId,contactId,leadId,title,new Date(Date.now()+3600000).toISOString(),'open',responsible,at);
    audit(db,null,'created','task',taskId,{source:'customer_agent',reason:'documents'});
  }
  if(!conversationId||!cfg.phone_id)return;
  cancelJobs(db,conversationId,cfg.phone_id,'AGENT_DOCUMENT_HANDOFF');
  db.prepare(`INSERT INTO customer_agent_threads(conversation_id,phone_id,lead_id,state,reason,summary,next_step,task_id,updated_at)
    VALUES(?,?,?,'handoff','documents',?,?,?,?) ON CONFLICT(conversation_id,phone_id) DO UPDATE SET
      lead_id=excluded.lead_id,state=excluded.state,reason=excluded.reason,summary=excluded.summary,next_step=excluded.next_step,task_id=excluded.task_id,updated_at=excluded.updated_at
    WHERE customer_agent_threads.state<>'stopped'`).run(conversationId,cfg.phone_id,leadId,'وصلت مستندات تحتاج مراجعة الإدارة.','افتح الفرصة وراجع المستندات',taskId??null,at);
}

export function recordRegistrationDocuments(db,contact,leadId,eventId){
  const cfg=settings(db);
  if(cfg.pilot_contact_id!==contact.id||hash(contact.phone??'')!==cfg.pilot_phone_hash)return;
  const conversation=db.prepare('SELECT id FROM conversations WHERE contact_id=?').get(contact.id);
  recordDocuments(db,cfg,contact.id,leadId,eventId,conversation?.id);
}

// Called within the signed inbound event transaction. A unique inbound ID owns one job.
export function ingestCustomerAgent(db,{env,contact,conversation,lead,messageId,phoneId,body,kind,mediaId,received}){
  const cfg=settings(db);
  const state=thread(db,conversation.id,phoneId);
  if(mediaId&&['document','image'].includes(kind)&&pilotIdentity(db,cfg,contact,phoneId)){
    recordDocuments(db,cfg,contact.id,lead.id,messageId,conversation.id);
    return true;
  }
  if(state?.state==='stopped')return true;
  if(cfg.pilot_contact_id!==contact.id||cfg.phone_id!==phoneId)return false;
  if(agentIntent(body,kind)==='stop'){
    cancelJobs(db,conversation.id,phoneId,'AGENT_OPT_OUT');
    db.prepare(`INSERT INTO customer_agent_threads(conversation_id,phone_id,lead_id,state,reason,summary,next_step,updated_at)
      VALUES(?,?,?,'stopped','stop','طلب العميل إيقاف المتابعة الآلية.','لا متابعة آلية',?)
      ON CONFLICT(conversation_id,phone_id) DO UPDATE SET state='stopped',reason='stop',summary=excluded.summary,next_step=excluded.next_step,updated_at=excluded.updated_at`).run(conversation.id,phoneId,lead.id,now());
    audit(db,null,'agent_opt_out','contact',contact.id,{channel:'whatsapp'});
    return true;
  }
  if(state&&['paused','handoff'].includes(state.state))return true;
  if(!pilotEligible(db,env,cfg,contact,phoneId))return false;
  if(!windowOpen(received))return true;
  db.prepare(`INSERT OR IGNORE INTO customer_agent_threads(conversation_id,phone_id,lead_id,state,reason,updated_at)
    VALUES(?,?,?,'active','',?)`).run(conversation.id,phoneId,lead.id,now());
  db.prepare(`INSERT OR IGNORE INTO customer_agent_jobs(inbound_id,conversation_id,phone_id,lead_id,status,revision,created_at)
    VALUES(?,?,?,?,'queued',?,?)`).run(messageId,conversation.id,phoneId,lead.id,cfg.revision,now());
  return true;
}

// Also used by the ordinary manual reply and CRM assignment paths.
export function pauseCustomerAgent(db,contactId,user,phoneId=null){
  const rows=db.prepare(`SELECT a.* FROM customer_agent_threads a JOIN conversations c ON c.id=a.conversation_id
    WHERE c.contact_id=? AND (? IS NULL OR a.phone_id=?) AND a.state<>'stopped'`).all(contactId,phoneId,phoneId);
  for(const row of rows){
    cancelJobs(db,row.conversation_id,row.phone_id,'AGENT_HUMAN_TAKEOVER');
    if(row.state==='paused')continue;
    db.prepare("UPDATE customer_agent_threads SET state='paused',reason='staff',next_step='المتابعة مع الموظف',updated_at=? WHERE conversation_id=? AND phone_id=?").run(now(),row.conversation_id,row.phone_id);
    audit(db,user,'agent_paused','contact',contactId,{channel:'whatsapp'});
  }
}

function safeToProcess(db,env,job,cfg,contact){
  const current=thread(db,job.conversation_id,job.phone_id);
  return current?.state==='active'&&job.revision===cfg.revision&&pilotEligible(db,env,cfg,contact,job.phone_id);
}

const registrationSeparator='\n\n'+registrationIntro+'\n';

function signedRegistrationUrl(db,job,key,origin){
  if(!key||!origin||!whatsappRegistrationOpportunity(db,job.contact_id,job.lead_id))return '';
  const url=URL.parse(origin);
  if(!url)return '';
  if(url.origin!==origin||!(url.protocol==='https:'||url.protocol==='http:'&&url.hostname==='127.0.0.1'))return '';
  return registrationLink(job.contact_id,'whatsapp',key,origin,job.lead_id,'whatsapp');
}

function verifiedRegistrationUrl(db,job,value,key,origin){
  if(!key||!origin||!whatsappRegistrationOpportunity(db,job.contact_id,job.lead_id))return false;
  try{
    const url=new URL(value),params=url.searchParams;
    return url.origin===origin&&url.pathname==='/apply'&&!url.username&&!url.password&&!url.hash&&
      [...params.keys()].length===4&&params.get('source')==='whatsapp'&&params.get('scope')==='whatsapp'&&params.get('enquiry')===job.lead_id&&
      resolveRegistrationLink(params.get('client'),key,job.lead_id,'whatsapp')===job.contact_id;
  }catch{return false;}
}

function safeReply(db,cfg,reason,body,evidence){
  if(!agentAllowsReply(body,cfg.forbidden))return false;
  if(reason==='official_fee')return activeSources(db,cfg).some(entry=>entry.official_fee&&officialFeeAnswer(entry.official_fee)===body&&entry.answer===body);
  if(!safeAgentAnswer(body))return false;
  if(reason!=='approved_source')return true;
  const active=activeSources(db,cfg).filter(entry=>!entry.official_fee);
  if(!Array.isArray(evidence?.source_ids))return active.some(entry=>entry.answer===body);
  const question=evidence.followup?(cfg.replies[evidence.followup]||agentReplies[evidence.followup]):'';
  const grounded=knowledgeReply(active,evidence.source_ids,question);
  if(!grounded)return false;
  const opening=cfg.replies.welcome||agentReplies.welcome;
  return (evidence.welcomed?opening+'\n\n'+grounded:grounded)===body;
}

export function customerAgentSendAllowed(db,env,messageId,key,origin){
  const job=db.prepare(`SELECT j.*,c.id contact_id,c.phone,m.created_at received_at
    FROM customer_agent_jobs j JOIN conversations v ON v.id=j.conversation_id
    JOIN contacts c ON c.id=v.contact_id JOIN messages m ON m.id=j.inbound_id
    WHERE j.outbound_id=?`).get(messageId);
  if(!job)return true;
  const current=thread(db,job.conversation_id,job.phone_id),cfg=settings(db);
  const source=db.prepare('SELECT body FROM messages WHERE id=?').get(messageId)?.body;
  const [reply,link,...extra]=String(source??'').split(registrationSeparator);
  const evidence=job.reason==='approved_source'?JSON.parse(db.prepare("SELECT metadata FROM audit WHERE action='agent_reply' AND entity='message' AND entity_id=?").get(messageId)?.metadata||'{}'):null;
  return job.revision===cfg.revision&&['active','handoff'].includes(current?.state)&&
    pilotEligible(db,env,cfg,{id:job.contact_id,phone:job.phone},job.phone_id)&&windowOpen(job.received_at)&&
    safeReply(db,cfg,job.reason,reply,evidence)&&!extra.length&&
    (link===undefined||agentAllowsReply(registrationIntro,cfg.forbidden)&&verifiedRegistrationUrl(db,job,link,key,origin));
}

function saveOutcome(db,job,decision,cfg,key,origin){
  const row=thread(db,job.conversation_id,job.phone_id);
  const nextStep=nextLabels[decision.next]||(decision.reason==='qualify'?'وضح خطوات التقديم حسب اختيار الطالب':'المتابعة حسب رد العميل');
  const reasonLabel=handoffReasons[decision.reason];
  const subject=decision.facts.subject,university=decision.facts.university,certificate=decision.facts.certificate;
  let summary=[certificate&&'الشهادة: '+certificate,subject&&'التخصص: '+subject,university&&'الجامعة: '+university].filter(Boolean).join(' · ');
  if(!summary)summary=decision.state==='handled'?'استفسار عام عن خدمات ميدل إيست.':'الاستفسار بحاجة إلى مراجعة بشرية.';
  let taskId=row.task_id;
  if(decision.state==='handoff'){
    const lead=db.prepare('SELECT owner_id FROM leads WHERE id=?').get(job.lead_id);
    const responsible=decision.reason==='finance'?agentOwner(db,cfg)??lead.owner_id:lead.owner_id;
    const open=taskId&&db.prepare("SELECT id FROM tasks WHERE id=? AND status='open' AND owner_id=?").get(taskId,responsible);
    if(!open){
      taskId=uid();
      db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?)').run(taskId,job.contact_id,job.lead_id,'وكيل خدمة العملاء · '+reasonLabel,new Date(Date.now()+3600000).toISOString(),'open',responsible,now());
      audit(db,null,'created','task',taskId,{source:'customer_agent',reason:decision.reason});
    }
    db.prepare("INSERT OR IGNORE INTO crm_activity(kind,event_id,contact_id,lead_id,source,created_at) VALUES('agent_handoff',?,?,?,?,?)")
      .run(job.inbound_id,job.contact_id,job.lead_id,'whatsapp',now());
  }
  db.prepare(`UPDATE customer_agent_threads SET lead_id=?,state=?,reason=?,facts=?,summary=?,next_step=?,task_id=?,updated_at=?
    WHERE conversation_id=? AND phone_id=?`).run(job.lead_id,decision.state==='handoff'?'handoff':'active',decision.reason,JSON.stringify(decision.facts),summary,
      decision.state==='handoff'?'يراجع الموظف المحادثة ويتابع · '+reasonLabel:nextStep,taskId,now(),job.conversation_id,job.phone_id);
  let outbound=null;
  const first=decision.reply&&!db.prepare(`SELECT 1 FROM messages m WHERE m.conversation_id=? AND m.direction='in'
    AND m.rowid<(SELECT rowid FROM messages WHERE id=?) LIMIT 1`).get(job.conversation_id,job.inbound_id);
  if(first)decision=withWelcome(decision,cfg);
  let reply=decision.reply;
  if(reply&&safeReply(db,cfg,decision.reason,reply,decision)&&windowOpen(job.received_at)){
    const firstOrdinary=first&&['greet','qualify','approved_source','uncertain','registration_link'].includes(decision.reason)&&['greet','lookup'].includes(agentIntent(job.body,job.kind));
    if(firstOrdinary&&agentAllowsReply(registrationIntro,cfg.forbidden)){
      const link=signedRegistrationUrl(db,job,key,origin);
      if(link)reply+=registrationSeparator+link;
    }
    if(decision.reason==='registration_link'&&!reply.includes(registrationSeparator))reply='هنكمل معاك على نفس الطلب. لو محتاج مساعدة في التسجيل قول لي.';
    if(!agentAllowsReply(reply.split(registrationSeparator)[0],cfg.forbidden))reply=null;
  }else reply=null;
  if(reply){
    outbound=uid();
    db.prepare(`INSERT INTO messages(id,conversation_id,direction,kind,body,payload,status,created_at)
      VALUES(?,?,'out','text',?,?,'queued',?)`).run(outbound,job.conversation_id,reply,JSON.stringify({type:'text',text:{body:reply}}),now());
    db.prepare('INSERT INTO message_accounts VALUES(?,?)').run(outbound,job.phone_id);
    audit(db,null,'agent_reply','message',outbound,{channel:'whatsapp',reason:decision.reason,source_id:decision.source_id??null,source_ids:decision.source_ids,followup:decision.followup,welcomed:decision.welcomed});
  }
  db.prepare("UPDATE customer_agent_jobs SET status='done',reason=?,outbound_id=? WHERE inbound_id=?").run(decision.reason,outbound,job.inbound_id);
  audit(db,null,decision.state==='handoff'?'agent_handoff':'agent_handled','lead',job.lead_id,{reason:decision.reason});
}

function customizeDecision(decision,cfg){
  const key=decision.reason==='qualify'?decision.next:decision.reason;
  if(cfg.replies[key])decision={...decision,reply:cfg.replies[key]};
  if(decision.followup&&cfg.replies[decision.followup]){
    const reply=decision.reply.slice(0,-agentReplies[decision.followup].length)+cfg.replies[decision.followup];
    if(safeAgentAnswer(reply))decision={...decision,reply};
    else decision={...decision,reply:decision.reply.slice(0,-agentReplies[decision.followup].length).trimEnd(),followup:undefined};
  }
  if(decision.reply&&!agentAllowsReply(decision.reply,cfg.forbidden)){
    return {...decision,reason:'uncertain',state:'handoff',reply:agentAllowsReply(agentReplies.uncertain,cfg.forbidden)?agentReplies.uncertain:null};
  }
  return decision;
}

function withWelcome(decision,cfg){
  if(!decision.reply||!['approved_source','qualify','uncertain','registration_link'].includes(decision.reason))return decision;
  const opening=cfg.replies.welcome||agentReplies.welcome;
  const reply=opening+'\n\n'+decision.reply;
  return safeAgentAnswer(reply)&&agentAllowsReply(reply,cfg.forbidden)?{...decision,reply,welcomed:true}:decision;
}

function feeDecision(body,sources,prior){
  const topic=officialFeeTopic(body);
  if(!topic)return null;
  const matches=sources.filter(row=>row.official_fee?.kind===topic&&officialFeeAnswer(row.official_fee)===row.answer);
  return matches.length===1?{reason:'official_fee',state:'handled',reply:matches[0].answer,source_id:matches[0].id,facts:prior}:null;
}

export async function processCustomerAgent(db,env,transport,key,origin){
  if(env.RECOVERY_MODE==='1')return;
  const job=db.prepare(`SELECT j.*,m.body,m.kind,m.created_at received_at,c.id contact_id,c.phone
    FROM customer_agent_jobs j JOIN messages m ON m.id=j.inbound_id JOIN conversations v ON v.id=j.conversation_id
    JOIN contacts c ON c.id=v.contact_id WHERE j.status='queued' ORDER BY j.created_at,j.rowid LIMIT 1`).get();
  if(!job)return;
  const cfg=settings(db),contact={id:job.contact_id,phone:job.phone};
  const cancel=reason=>db.prepare("UPDATE customer_agent_jobs SET status='cancelled',reason=? WHERE inbound_id=? AND status IN('queued','planning')").run(reason,job.inbound_id);
  if(!safeToProcess(db,env,job,cfg,contact)){cancel('AGENT_INACTIVE');return;}
  if(!db.prepare("UPDATE customer_agent_jobs SET status='planning' WHERE inbound_id=? AND status='queued'").run(job.inbound_id).changes)return;
  const prior=JSON.parse(thread(db,job.conversation_id,job.phone_id).facts);
  const active=activeSources(db,cfg),knowledge=active.filter(row=>!row.official_fee);
  const intent=agentIntent(job.body,job.kind);
  let decision;
  if(!windowOpen(job.received_at)){
    decision={reason:'window',state:'handoff',facts:prior};
  }else if(intent==='lookup'&&cfg.mode==='provider'){
    const candidates=agentCandidates(job.body,knowledge);
    try{
      const choice=candidates.length&&!requestsAgentRegistration(job.body)?await chooseAgentSource(job.body,candidates,cfg.instructions,env.CUSTOMER_AGENT_OPENAI_KEY,transport,prior):undefined;
      decision=agentDecision(job.body,job.kind,knowledge,prior,choice);
    }catch{
      decision={reason:'provider',state:'handoff',reply:agentReplies.uncertain,facts:prior};
    }
  }else{
    decision=(intent==='finance'&&feeDecision(job.body,active,prior))||agentDecision(job.body,job.kind,knowledge,prior);
  }
  transaction(db,()=>{
    if(db.prepare('SELECT status FROM customer_agent_jobs WHERE inbound_id=?').get(job.inbound_id).status!=='planning')return;
    const fresh=db.prepare('SELECT id,phone FROM contacts WHERE id=?').get(job.contact_id);
    if(!safeToProcess(db,env,job,settings(db),fresh)){cancel('AGENT_INACTIVE');return;}
    const activeIds=new Set(activeSources(db,cfg).map(source=>source.id));
    if((decision.source_ids??[decision.source_id]).some(id=>id&&!activeIds.has(id))){
      decision={reason:'uncertain',state:'handoff',reply:agentReplies.uncertain,facts:prior};
    }
    saveOutcome(db,job,customizeDecision(decision,cfg),cfg,key,origin);
  });
}

function updateAgentSettings(db,user,input,env,config){
  if(typeof input.enabled!=='boolean')fail(400,'اختر حالة الوكيل');
  const old=settings(db);
  const instructions=text(input.instructions??old.instructions,'تعليمات الوكيل',1500,false);
  if(/@|https?:|[\p{N}]{4,}|(?:sk-|bearer\s|api[_ -]?key)/iu.test(instructions))fail(400,'استخدم تعليمات عامة من دون بيانات شخصية أو أرقام تعريف');
  const replies=input.replies===undefined?old.replies:input.replies;
  if(!replies||typeof replies!=='object'||Array.isArray(replies)||Object.keys(replies).some(key=>!agentReplyKeys.includes(key)))fail(400,'صياغة الردود غير صالحة');
  const customReplies={};
  for(const [key,value] of Object.entries(replies)){
    const reply=text(value,'صياغة الرد',420,false);
    if(!reply)continue;
    if(!safeAgentAnswer(reply))fail(400,'صياغة الرد تحتاج نصًا عامًا آمنًا بلا أسعار أو بيانات خاصة أو روابط');
    customReplies[key]=reply;
  }
  const forbidden=text(input.forbidden??old.forbidden.join('\n'),'عبارات ممنوعة',1200,false).split('\n').map(line=>line.trim()).filter(Boolean);
  if(forbidden.length>25||forbidden.some(line=>line.length>80||!/[\p{L}\p{N}]{2}/u.test(line)))fail(400,'أدخل حتى خمس وعشرين عبارة ممنوعة، كل عبارة في سطر');
  const pilotName=text(input.pilot_name??old.pilot_name,'اسم صاحب رقم الاختبار',120,false);
  const suffixInput=text(input.pilot_suffix??old.pilot_suffix,'نهاية رقم الاختبار',6,false);
  if((pilotName||suffixInput)&&(!/^[0-9٠-٩۰-۹]{2,6}$/.test(suffixInput)||nameWords(pilotName).split(' ').length<2))fail(400,'أدخل اسم الاختبار من كلمتين على الأقل وآخر رقمين إلى ستة أرقام');
  const pilotSuffix=normalizeSearch(suffixInput);
  const mode=input.mode??old.mode,companyKnowledgeEnabled=input.company_knowledge??old.company_knowledge;
  if(!['local','provider'].includes(mode)||typeof companyKnowledgeEnabled!=='boolean')fail(400,'اختر وضع رد صالحًا');
  const scopeChanged=pilotName!==old.pilot_name||pilotSuffix!==old.pilot_suffix;
  const value={...old,enabled:input.enabled,mode,company_knowledge:companyKnowledgeEnabled,instructions,replies:customReplies,forbidden,manager_id:user.id,pilot_name:pilotName,pilot_suffix:pilotSuffix,revision:old.revision+1};
  if(scopeChanged)Object.assign(value,{pilot_contact_id:null,pilot_phone_hash:null,phone_id:null});
  if(input.enabled){
    if(scopeChanged)fail(409,'احفظ نطاق الاختبار أولًا ثم اختر السجل المطابق');
    if(!engineReady(env,value))fail(409,'التجربة الحية تحتاج موافقة تفعيل مزود التصنيف وإعداداته على الخادم');
    const candidates=pilotCandidates(db,value);
    if(candidates.length!==1)fail(409,candidates.length?'أكثر من سجل يطابق اسم ورقم الاختبار. يلزم تحديد السجل الصحيح قبل التفعيل.':'لم يُعثر على سجل اختبار مطابق');
    const [contact]=candidates;
    if((input.pilot_contact_id??old.pilot_contact_id)!==contact.id)fail(400,'راجع واختر سجل الاختبار المؤكد');
    if(!config.phoneId||!config.accessToken||!/^v\d+\.\d+$/.test(config.version||''))fail(409,'إعداد قناة واتساب الرئيسية غير مكتمل');
    Object.assign(value,{pilot_contact_id:contact.id,pilot_phone_hash:hash(contact.phone),phone_id:String(config.phoneId)});
  }
  transaction(db,()=>{
    writeSettings(db,value);
    invalidateJobs(db);
    audit(db,user,'agent_settings_changed','customer_agent','settings',{enabled:value.enabled,mode:value.mode,company_knowledge:value.company_knowledge,revision:value.revision});
  });
}

function updateSource(db,user,input){
  const id=input.id?text(input.id,'المصدر',80):uid();
  const previous=db.prepare('SELECT * FROM customer_agent_sources WHERE id=?').get(id);
  if(input.id&&!previous)fail(404,'المصدر غير متاح');
  const status=input.status??'draft';
  if(!['draft','approved','disabled'].includes(status))fail(400,'حالة المصدر غير صالحة');
  const title=text(input.title??previous?.title,'عنوان المصدر',160);
  const question=text(input.question??previous?.question,'السؤال',250);
  const cfg=settings(db);
  const submittedFee=input.official_fee===undefined?cfg.fees[id]:input.official_fee;
  const feeAnswer=submittedFee?officialFeeAnswer(submittedFee):null;
  if(submittedFee&&!feeAnswer)fail(400,'اختر بند الرسوم الرسمية والعملة والمبلغ المنشور');
  const fee=feeAnswer?{kind:submittedFee.kind,amount:submittedFee.amount,currency:submittedFee.currency}:null;
  const answer=feeAnswer??text(input.answer??previous?.answer,'الإجابة',600);
  const url=text(input.url??previous?.url??'','رابط الموقع',300,false);
  if(url&&!approvedWebsiteUrl(url))fail(400,'أضف رابطًا عامًا من موقع ميدل إيست الرسمي');
  const reviewedUntil=input.reviewed_until?new Date(input.reviewed_until):null;
  if(status==='approved'&&(!(fee?approvedWebsiteUrl(url):safeAgentAnswer(answer))||!agentAllowsReply(answer,cfg.forbidden)||!reviewedUntil||!(reviewedUntil.getTime()>Date.now())||reviewedUntil.getTime()>Date.now()+180*86400000)){
    fail(400,'الاعتماد يحتاج إجابة آمنة وتاريخ مراجعة. الرسوم الرسمية تحتاج رابط مصدر من موقع الشركة');
  }
  transaction(db,()=>{
    db.prepare(`INSERT INTO customer_agent_sources VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,question=excluded.question,answer=excluded.answer,url=excluded.url,
      reviewed_until=excluded.reviewed_until,reviewed_at=excluded.reviewed_at,reviewed_by=excluded.reviewed_by,status=excluded.status,updated_at=excluded.updated_at`)
      .run(id,title,question,answer,url,status==='approved'?reviewedUntil.toISOString():null,status==='approved'?now():null,status==='approved'?user.id:null,status,now());
    const fees={...cfg.fees};
    if(fee)fees[id]=fee;else delete fees[id];
    writeSettings(db,{...cfg,fees,revision:cfg.revision+1});
    invalidateJobs(db);
    audit(db,user,'agent_source_'+status,'customer_agent',id);
  });
  return {id};
}

function importWebsiteDrafts(db,user,input){
  const url=text(input.url,'صفحة الموقع',300);
  if(!approvedWebsiteUrl(url))fail(400,'اختر صفحة عامة من موقع ميدل إيست الرسمي');
  if(!Array.isArray(input.drafts)||!input.drafts.length||input.drafts.length>12)fail(400,'اختر حتى اثني عشر مقتطفًا من الصفحة');
  const drafts=input.drafts.map(item=>{
    const title=text(item?.title,'عنوان المقتطف',160);
    const answer=text(item?.answer,'نص المقتطف',600);
    if(!safeAgentAnswer(answer))fail(400,'المقتطف يحتاج مراجعة قبل حفظه كمصدر');
    return {title,answer};
  });
  const existing=db.prepare('SELECT 1 FROM customer_agent_sources WHERE url=? AND answer=?');
  const insert=db.prepare("INSERT INTO customer_agent_sources(id,title,question,answer,url,status,updated_at) VALUES(?,?,?,?,?,'draft',?)");
  return transaction(db,()=>{
    let added=0;
    for(const {title,answer} of drafts){
      if(existing.get(url,answer))continue;
      const id=uid();
      insert.run(id,title,title,answer,url,now());
      audit(db,user,'agent_source_draft','customer_agent',id,{source:'website'});
      added++;
    }
    return {added};
  });
}

function agentDashboard(db,env){
  const cfg=settings(db);
  const candidates=pilotCandidates(db,cfg).map(row=>({id:row.id,name:row.name,suffix:cfg.pilot_suffix}));
  const sources=db.prepare(`SELECT s.*,u.name reviewer FROM customer_agent_sources s
    LEFT JOIN users u ON u.id=s.reviewed_by ORDER BY s.updated_at DESC LIMIT 100`).all().map(row=>({...row,official_fee:Object.hasOwn(cfg.fees,row.id)?cfg.fees[row.id]:null}));
  const threads=db.prepare(`SELECT a.*,v.contact_id,c.name,l.title,
    (SELECT m.status FROM customer_agent_jobs j JOIN messages m ON m.id=j.outbound_id
      WHERE j.conversation_id=a.conversation_id AND j.phone_id=a.phone_id ORDER BY j.created_at DESC,j.rowid DESC LIMIT 1) delivery_status,
    (SELECT m.error_code FROM customer_agent_jobs j JOIN messages m ON m.id=j.outbound_id
      WHERE j.conversation_id=a.conversation_id AND j.phone_id=a.phone_id ORDER BY j.created_at DESC,j.rowid DESC LIMIT 1) delivery_error
    FROM customer_agent_threads a JOIN conversations v ON v.id=a.conversation_id JOIN contacts c ON c.id=v.contact_id
    JOIN leads l ON l.id=a.lead_id ORDER BY a.updated_at DESC LIMIT 100`).all();
  const metrics=db.prepare(`SELECT COUNT(*) conversations,COUNT(DISTINCT CASE WHEN EXISTS(SELECT 1 FROM audit x WHERE x.entity='contact' AND x.entity_id=c.id AND x.action='whatsapp_created'
      AND x.created_at>=(SELECT MIN(j.created_at) FROM customer_agent_jobs j WHERE j.conversation_id=a.conversation_id)) THEN c.id END) new_customers,
    COUNT(DISTINCT CASE WHEN t.status='open' THEN a.lead_id END) followups,
    SUM(CASE WHEN a.state='handoff' THEN 1 ELSE 0 END) handoffs
    FROM customer_agent_threads a JOIN conversations v ON v.id=a.conversation_id JOIN contacts c ON c.id=v.contact_id
    LEFT JOIN tasks t ON t.id=a.task_id`).get();
  const reasons=db.prepare("SELECT reason,COUNT(*) count FROM customer_agent_jobs WHERE reason<>'' GROUP BY reason ORDER BY count DESC").all();
  const history=db.prepare(`SELECT a.action,a.entity_id,a.metadata,a.created_at,u.name actor FROM audit a
    LEFT JOIN users u ON u.id=a.user_id WHERE a.entity='customer_agent' ORDER BY a.created_at DESC,a.rowid DESC LIMIT 40`).all();
  return {enabled:cfg.enabled,mode:cfg.mode,company_knowledge:cfg.company_knowledge,company_sources:companyKnowledge,company_reviewed:companyKnowledgeReviewed,provider_ready:providerReady(env),model:agentModel,instructions:cfg.instructions,replies:cfg.replies,default_replies:agentReplies,forbidden:cfg.forbidden,
    pilot_contact_id:cfg.pilot_contact_id,pilot_name:cfg.pilot_name,pilot_suffix:cfg.pilot_suffix,candidates,sources,threads,metrics,reasons,history};
}

export async function handleCustomerAgent({db,user,path,method,req,res,jsonBody,sendJson,env,config,transport}){
  if(!path.startsWith('/api/customer-agent'))return false;
  const respond=(value,status=200)=>{sendJson(res,status,value);return true;};
  const leadDocuments=path.match(/^\/api\/customer-agent\/leads\/([a-f0-9-]{36})\/documents$/i);
  if(leadDocuments&&method==='GET'){
    if(user.role==='accountant')fail(403,'مستندات الطلب لفريق خدمة العملاء');
    const lead=db.prepare('SELECT id,contact_id,owner_id FROM leads WHERE id=?').get(leadDocuments[1]);
    if(!lead||!manager(user)&&(lead.owner_id!==user.id||db.prepare('SELECT 1 FROM crm_waiting WHERE contact_id=?').get(lead.contact_id)))fail(404,'الطلب غير متاح');
    getContact(db,user,lead.contact_id);
    return respond(requestWhatsAppFiles(db,lead.contact_id,lead.id));
  }
  const contactRoute=path.match(/^\/api\/customer-agent\/contacts\/([a-f0-9-]{36})$/i);
  if(contactRoute){
    if(user.role==='accountant')fail(403,'متابعة الوكيل لفريق خدمة العملاء');
    const contact=getContact(db,user,contactRoute[1]);
    if(!manager(user)&&db.prepare('SELECT 1 FROM crm_waiting WHERE contact_id=?').get(contact.id))fail(404,'استلم الفرصة أولًا');
    if(method==='GET'){
      const state=db.prepare(`SELECT a.state,a.reason,a.summary,a.next_step,a.lead_id,a.updated_at
        FROM customer_agent_threads a JOIN conversations v ON v.id=a.conversation_id WHERE v.contact_id=?
        ORDER BY a.updated_at DESC LIMIT 1`).get(contact.id);
      return respond(state??null);
    }
    if(method==='PATCH'){
      const input=await jsonBody(req);
      if(input.action==='pause'){
        transaction(db,()=>pauseCustomerAgent(db,contact.id,user));
      }else if(input.action==='resume'&&user.role==='admin'){
        const cfg=settings(db),conversation=db.prepare('SELECT id FROM conversations WHERE contact_id=?').get(contact.id);
        if(!conversation||!pilotEligible(db,env,cfg,contact,cfg.phone_id))fail(409,'المحادثة ليست ضمن تجربة واتساب المفعلة');
        const result=db.prepare("UPDATE customer_agent_threads SET state='active',reason='',next_step='انتظار رسالة جديدة',updated_at=? WHERE conversation_id=? AND phone_id=? AND state IN('paused','handoff')").run(now(),conversation.id,cfg.phone_id);
        if(!result.changes)fail(409,'يتعذر استئناف المحادثة. يظل إيقاف العميل نافذًا.');
        audit(db,user,'agent_resumed','contact',contact.id,{channel:'whatsapp'});
      }else fail(400,'الإجراء غير متاح');
      return respond({ok:true});
    }
  }
  if(user.role!=='admin')fail(403,'إدارة وكيل خدمة العملاء للمالك');
  if(path==='/api/customer-agent'&&method==='GET')return respond(agentDashboard(db,env));
  if(path==='/api/customer-agent/settings'&&method==='PATCH'){
    updateAgentSettings(db,user,await jsonBody(req),env,config);
    return respond(agentDashboard(db,env));
  }
  if(path==='/api/customer-agent/sources'&&method==='POST')return respond(updateSource(db,user,await jsonBody(req)),201);
  if(path==='/api/customer-agent/sources/website-import'&&method==='POST')return respond(importWebsiteDrafts(db,user,await jsonBody(req)),201);
  if(path==='/api/customer-agent/sources/website-preview'&&method==='POST'){
    const input=await jsonBody(req);
    return respond(await previewWebsiteKnowledge(text(input.url,'صفحة الموقع',300),transport));
  }
  if(path==='/api/customer-agent/preview'&&method==='POST'){
    const input=await jsonBody(req);
    const body=text(input.body,'رسالة اختبار اصطناعية',1600);
    const current=settings(db);
    const cfg=input.local===true&&input.provider!==true?{...current,mode:'local'}:current;
    const sources=activeSources(db,cfg),sourceList=sources.filter(row=>!row.official_fee);
    const candidates=agentCandidates(body,sourceList);
    const qualifies=agentCanQualify(body,sourceList);
    let choice=candidates.length?undefined:qualifies?'qualify':undefined;
    if(input.provider===true){
      if(!providerReady(env))fail(409,'اختبار المزود يحتاج موافقة وإعداد الخادم');
      if(input.synthetic!==true)fail(400,'أكد أن رسالة الاختبار وتعليماتها اصطناعية');
      const instructions=text(input.instructions??settings(db).instructions,'تعليمات الاختبار',1500,false);
      if(/@|https?:|[\p{N}]{4,}|(?:sk-|bearer\s|api[_ -]?key)/iu.test(instructions))fail(400,'أزل البيانات الشخصية من تعليمات الاختبار');
      if(agentIntent(body)==='lookup'&&(candidates.length||qualifies)){
        try{choice=await chooseAgentSource(body,candidates,instructions,env.CUSTOMER_AGENT_OPENAI_KEY,transport);}
        catch{fail(502,'تعذّر اختبار مزوّد التصنيف');}
        return respond({...withWelcome(customizeDecision(agentDecision(body,'text',sourceList,{},choice),cfg),cfg),mode:'provider_preview'});
      }
    }
    const official=agentIntent(body)==='finance'?feeDecision(body,sources,{}):null;
    return respond({...withWelcome(customizeDecision(official||agentDecision(body,'text',sourceList,{},choice),cfg),cfg),mode:'local_policy'});
  }
  fail(404,'مسار وكيل خدمة العملاء غير متاح');
}
