import { transaction } from './db.mjs';
import { uid,now,manager,finance,fail,text,audit,getContact } from './service.mjs';

export function quoteFor(db,user,id){
  const quote=db.prepare('SELECT * FROM quotes WHERE id=?').get(id);if(!quote)fail(404,'العرض غير موجود');
  if(user.role!=='accountant')getContact(db,user,quote.contact_id);return quote;
}
export function listQuotes(db,user){
  return db.prepare(`SELECT q.*,c.name AS contact_name FROM quotes q JOIN contacts c ON c.id=q.contact_id
    ${manager(user)||user.role==='accountant'?'':'WHERE c.owner_id=?'} ORDER BY q.created_at DESC`).all(...(manager(user)||user.role==='accountant'?[]:[user.id]));
}
export function createQuote(db,user,input){
  if(user.role==='accountant'){
    if(!db.prepare('SELECT id FROM contacts WHERE id=?').get(input.contact_id))fail(400,'العميل غير موجود');
  }else getContact(db,user,input.contact_id);
  const number=text(input.number,'رقم العرض',80),description=text(input.description,'بيان الخدمة',4000);
  if(db.prepare('SELECT id FROM quotes WHERE number=?').get(number))fail(409,'رقم العرض موجود');
  if(!Number.isSafeInteger(input.amount_minor)||input.amount_minor<=0)fail(400,'المبلغ بالقرش يجب أن يكون موجبًا');
  const currency=input.currency||'EGP';if(!['EGP','USD','SAR'].includes(currency))fail(400,'عملة غير مدعومة');
  const valid=input.valid_until?new Date(input.valid_until):null;if(valid&&!Number.isFinite(valid.getTime()))fail(400,'موعد غير صالح');
  const id=uid();transaction(db,()=>{
    db.prepare(`INSERT INTO quotes(id,number,contact_id,description,amount_minor,currency,status,valid_until,created_by,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id,number,input.contact_id,description,input.amount_minor,currency,'draft',valid?.toISOString()||null,user.id,now(),now());
    audit(db,user,'created','quote',id);
  });return {id};
}
export function changeQuote(db,user,id,input){
  const quote=quoteFor(db,user,id),allowed={draft:['sent','rejected'],sent:['accepted','rejected'],accepted:[],rejected:[],converted:[]};
  if(!allowed[quote.status].includes(input.status))fail(409,'انتقال حالة العرض غير متاح');
  let reference=null;
  if(input.status==='accepted'){
    if(quote.valid_until&&Date.parse(quote.valid_until)<Date.now())fail(409,'انتهت صلاحية العرض؛ أنشئ عرضًا جديدًا');
    reference=text(input.acceptance_reference,'مرجع موافقة العميل',400);
  }
  transaction(db,()=>{db.prepare('UPDATE quotes SET status=?,acceptance_reference=?,updated_at=? WHERE id=?').run(input.status,reference,now(),id);audit(db,user,'status_changed','quote',id,{status:input.status});});
  return {ok:true};
}
export function invoiceFromQuote(db,user,id,number){
  if(!finance(user))fail(403,'التحويل لفاتورة متاح للحسابات والإدارة');
  const quote=quoteFor(db,user,id);if(quote.invoice_id)return {id:quote.invoice_id,existing:true};
  if(quote.status!=='accepted')fail(409,'سجّل موافقة العميل على العرض أولًا');
  const invoiceNumber=text(number,'رقم الفاتورة',80);if(db.prepare('SELECT id FROM invoices WHERE number=?').get(invoiceNumber))fail(409,'رقم الفاتورة موجود');
  const invoiceId=uid();transaction(db,()=>{
    db.prepare('INSERT INTO invoices VALUES(?,?,?,?,?,?,?,?,?)').run(invoiceId,invoiceNumber,quote.contact_id,quote.description,quote.amount_minor,quote.currency,'draft',null,now());
    db.prepare("UPDATE quotes SET status='converted',invoice_id=?,updated_at=? WHERE id=?").run(invoiceId,now(),id);audit(db,user,'converted','quote',id,{invoice_id:invoiceId});
  });return {id:invoiceId,existing:false};
}
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export function printableDocument(db,user,kind,id){
  let record;
  if(kind==='quote')record=quoteFor(db,user,id);
  else{
    if(!finance(user))fail(403,'طباعة الفواتير للحسابات والإدارة');record=db.prepare('SELECT * FROM invoices WHERE id=?').get(id);if(!record)fail(404,'الفاتورة غير موجودة');
  }
  const contact=db.prepare('SELECT name,phone FROM contacts WHERE id=?').get(record.contact_id);
  const company=db.prepare("SELECT value FROM settings WHERE key='company_name'").get()?.value || 'ميد إيست';
  const amount=new Intl.NumberFormat('ar-EG',{style:'currency',currency:record.currency}).format(record.amount_minor/100);
  const payments=kind==='invoice'?db.prepare('SELECT amount_minor,reference,created_at FROM payments WHERE invoice_id=? ORDER BY created_at').all(id):[];
  audit(db,user,'printed',kind,id);
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(record.number)}</title><link rel="stylesheet" href="/print.css"></head><body><main><header><strong>${escape(company)}</strong><span>${kind==='quote'?'عرض سعر':'فاتورة داخلية'}</span></header><h1>${escape(record.number)}</h1><p>العميل: <b>${escape(contact.name)}</b></p><p>تاريخ الإصدار: ${escape(new Date(record.created_at).toLocaleDateString('ar-EG'))}</p>${record.valid_until?`<p>ساري حتى: ${escape(new Date(record.valid_until).toLocaleDateString('ar-EG'))}</p>`:''}<table><thead><tr><th>بيان الخدمة</th><th>القيمة</th></tr></thead><tbody><tr><td>${escape(record.description)}</td><td>${escape(amount)}</td></tr></tbody></table>${payments.length?`<h2>الدفعات المسجلة</h2><table><tbody>${payments.map(p=>`<tr><td>${escape(p.reference)}</td><td>${escape(new Intl.NumberFormat('ar-EG',{style:'currency',currency:record.currency}).format(p.amount_minor/100))}</td></tr>`).join('')}</tbody></table>`:''}<footer>مستند متابعة داخلي — ليس فاتورة ضريبية إلكترونية أو إثبات تحويل بنكي.<br>يمكن الطباعة أو الحفظ PDF من قائمة الطباعة في المتصفح.</footer></main></body></html>`;
}
