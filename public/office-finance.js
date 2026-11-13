import {cairoDay} from './chat-ui.js';

const categories={advertising:'إعلانات',rent:'إيجار',payroll:'رواتب',transport:'انتقالات',office:'تشغيل المكتب',other:'أخرى'};
const currencies={EGP:'جنيه مصري',USD:'دولار أمريكي',SAR:'ريال سعودي'};

function amountMinor(value){
  const match=/^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(String(value));
  if(!match)throw new Error('أدخل مبلغًا صحيحًا بمنزلتين عشريتين على الأكثر');
  const amount=Number(match[1])*100+Number((match[2]||'').padEnd(2,'0'));
  if(!amount)throw new Error('المبلغ لازم يكون أكبر من صفر');
  return amount;
}

export function createOfficeFinance({api,escape:e,money,modal,bindForm,selectOptions,render}){
  let report=null,month='',contactId='';
  function reset(){report=null;month='';contactId='';}
  async function load(value=month){
    const next=await api('/finance/expenses'+(value?'?month='+encodeURIComponent(value):''));
    report=next;month=next.month;
  }
  function customerSummary(invoices){
    const totals=new Map();
    for(const invoice of invoices){
      if(invoice.status!=='issued')continue;
      const row=totals.get(invoice.currency)??{total:0,paid:0};
      row.total+=invoice.amount_minor;row.paid+=invoice.paid_minor;
      totals.set(invoice.currency,row);
    }
    const rows=[...totals].map(([currency,row])=>`<tr><td>${e(currency)}</td><td>${e(money(row.total,currency))}</td><td>${e(money(row.paid,currency))}</td><td>${e(money(row.total-row.paid,currency))}</td></tr>`).join('');
    return `<section class="panel" aria-label="حساب العميل"><h3>حساب العميل</h3>${rows?
      '<div class="tablewrap"><table><thead><tr><th>العملة</th><th>إجمالي الفواتير الصادرة</th><th>المدفوع</th><th>المتبقي</th></tr></thead><tbody>'+rows+'</tbody></table></div>':
      '<p class="sub">لا توجد فواتير صادرة لهذا العميل.</p>'}</section>`;
  }
  function accountsView(invoices){
    const customers=Object.fromEntries(invoices.filter(row=>row.status==='issued').map(row=>[row.contact_id,row.contact_name]));
    if(!Object.keys(customers).length)return '';
    return `<section class="panel"><h2>أرصدة العملاء</h2><label>العميل <select data-finance-contact>
      <option value="">اختر العميل</option>${selectOptions(customers,contactId)}</select></label>
      ${customers[contactId]?customerSummary(invoices.filter(row=>row.contact_id===contactId)):''}</section>`;
  }
  function selectContact(id){contactId=id;render();}
  function view(){
    if(!report)return '';
    const sums=report.totals.map(row=>`<tr><td>${e(row.currency)}</td><td>${e(money(row.paid_minor,row.currency))}</td><td>${e(money(row.expenses_minor,row.currency))}</td><td>${e(money(row.paid_minor-row.expenses_minor,row.currency))}</td></tr>`).join('');
    const rows=report.expenses.map(row=>`<tr><td>${e(row.expense_date)}</td><td>${e(categories[row.category])}</td><td>${e(row.description)}</td><td>${e(money(row.amount_minor,row.currency))}</td><td>${row.voided_at?'ملغى · '+e(row.void_reason):'<button type="button" class="btn small" data-action="office-expense-void" data-id="'+e(row.id)+'">إلغاء القيد</button>'}</td></tr>`).join('');
    return `<section class="panel"><div class="panelhead"><h2>مصروفات المكتب</h2><div class="actions">
      <label>الشهر <input type="month" data-expense-month value="${e(report.month)}"></label>
      <button type="button" class="btn primary small" data-action="office-expense-new">إضافة مصروف</button></div></div>
      <p class="sub">المحصل هو الدفعات المسجلة خلال الشهر. الفرق يخص التدفقات المسجلة لكل عملة.</p>
      ${sums?'<div class="tablewrap"><table><thead><tr><th>العملة</th><th>المحصل</th><th>المصروفات</th><th>الفرق</th></tr></thead><tbody>'+sums+'</tbody></table></div>':'<p class="sub">لا توجد حركة مالية مسجلة لهذا الشهر.</p>'}
      ${rows?'<div class="tablewrap"><table><thead><tr><th>التاريخ</th><th>البند</th><th>البيان</th><th>القيمة</th><th>الحالة</th></tr></thead><tbody>'+rows+'</tbody></table></div>':''}
    </section>`;
  }
  async function changeMonth(value){await load(value);render();}
  function action(name,id){
    if(name==='office-expense-new'){
      const today=cairoDay(),requestId=crypto.randomUUID();
      const form=modal('إضافة مصروف مكتب',`<label>التاريخ<input type="date" name="expense_date" value="${e(today)}" max="${e(today)}" required></label>
        <label>البند<select name="category">${selectOptions(categories,'advertising')}</select></label>
        <label>البيان<input name="description" maxlength="240" required></label>
        <label>المبلغ<input name="amount" type="number" min="0.01" max="999999999.99" step="0.01" required></label>
        <label>العملة<select name="currency">${selectOptions(currencies,'EGP')}</select></label>`,'حفظ المصروف');
      bindForm(form,async values=>{
        const input=Object.fromEntries(values);
        await api('/finance/expenses','POST',{request_id:requestId,expense_date:input.expense_date,category:input.category,description:input.description,currency:input.currency,amount_minor:amountMinor(input.amount)});
        month=input.expense_date.slice(0,7);
      });
      return true;
    }
    if(name==='office-expense-void'){
      const form=modal('إلغاء قيد المصروف','<label>سبب الإلغاء<input name="reason" maxlength="240" required></label>','إلغاء القيد');
      bindForm(form,values=>api('/finance/expenses/'+encodeURIComponent(id),'PATCH',{reason:values.get('reason')}));
      return true;
    }
    return false;
  }
  return {load,reset,view,accountsView,selectContact,customerSummary,changeMonth,action};
}
