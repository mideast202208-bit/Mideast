import {transaction} from './db.mjs';
import {audit,fail,finance,now,text} from './service.mjs';
import {cairoDay} from '../public/chat-ui.js';

const currencies=new Set(['EGP','USD','SAR']);
const categories=new Set(['advertising','rent','payroll','transport','office','other']);
const cap=100_000_000_000;

function expenseDate(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))fail(400,'اختر تاريخًا صحيحًا للمصروف');
  const date=new Date(value+'T12:00:00Z');
  if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==value||value>cairoDay())fail(400,'اختر تاريخ مصروف صحيحًا حتى اليوم');
  return value;
}

function monthlyReport(db,month){
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))fail(400,'اختر شهرًا صحيحًا');
  const expenses=db.prepare(`SELECT id,expense_date,category,description,amount_minor,currency,voided_at,void_reason
    FROM office_expenses WHERE expense_date>=? AND expense_date<=? ORDER BY expense_date DESC,created_at DESC,id DESC`).all(month+'-01',month+'-31');
  const paid=db.prepare(`SELECT p.created_at,p.amount_minor,i.currency FROM payments p
    JOIN invoices i ON i.id=p.invoice_id WHERE i.status='issued' AND p.created_at>=? AND p.created_at<?`)
    .all(new Date(Date.parse(month+'-01T00:00:00Z')-86400000).toISOString(),
      new Date(Date.parse(month+'-01T00:00:00Z')+32*86400000).toISOString());
  const totals=new Map();
  const forCurrency=currency=>{
    if(!totals.has(currency))totals.set(currency,{currency,paid_minor:0,expenses_minor:0});
    return totals.get(currency);
  };
  for(const row of paid)if(cairoDay(row.created_at).slice(0,7)===month)forCurrency(row.currency).paid_minor+=row.amount_minor;
  for(const row of expenses)if(!row.voided_at)forCurrency(row.currency).expenses_minor+=row.amount_minor;
  return {month,expenses,totals:[...totals.values()].sort((a,b)=>a.currency.localeCompare(b.currency))};
}

export async function handleOfficeFinance({db,user,path,method,req,res,jsonBody,sendJson,url}){
  const entry=path.match(/^\/api\/finance\/expenses\/([a-f0-9-]{36})$/);
  if(path!=='/api/finance/expenses'&&!entry)return false;
  if(!finance(user))fail(403,'سجل المصروفات للإدارة والحسابات');
  if(path==='/api/finance/expenses'&&method==='GET'){
    sendJson(res,200,monthlyReport(db,url.searchParams.get('month')??cairoDay().slice(0,7)));
    return true;
  }
  if(path==='/api/finance/expenses'&&method==='POST'){
    const input=await jsonBody(req,8192);
    const date=expenseDate(input.expense_date),description=text(input.description,'بيان المصروف',240);
    if(!categories.has(input.category)||!currencies.has(input.currency))fail(400,'اختر بند المصروف والعملة');
    if(!Number.isSafeInteger(input.amount_minor)||input.amount_minor<1||input.amount_minor>cap)fail(400,'قيمة المصروف غير صالحة');
    const key=text(input.request_id,'مرجع المصروف',36);
    if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(key))fail(400,'مرجع المصروف غير صالح');
    const replayed=transaction(db,()=>{
      const prior=db.prepare('SELECT * FROM office_expenses WHERE id=?').get(key);
      if(prior){
        if(prior.created_by!==user.id||prior.expense_date!==date||prior.category!==input.category||
          prior.description!==description||prior.amount_minor!==input.amount_minor||prior.currency!==input.currency)fail(409,'مرجع التسجيل مستخدم بالفعل');
        return true;
      }
      db.prepare('INSERT INTO office_expenses(id,expense_date,category,description,amount_minor,currency,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(key,date,input.category,description,input.amount_minor,input.currency,user.id,now());
      audit(db,user,'created','office_expense',key);
      return false;
    });
    sendJson(res,replayed?200:201,{id:key,replayed});return true;
  }
  if(entry&&method==='PATCH'){
    const input=await jsonBody(req,8192),reason=text(input.reason,'سبب الإلغاء',240);
    transaction(db,()=>{
      const id=entry[1];
      const updated=db.prepare('UPDATE office_expenses SET voided_at=?,voided_by=?,void_reason=? WHERE id=? AND voided_at IS NULL').run(now(),user.id,reason,id);
      if(updated.changes!==1)fail(409,'المصروف غير متاح للإلغاء');
      audit(db,user,'voided','office_expense',id);
    });
    sendJson(res,200,{ok:true});return true;
  }
  fail(405,'طريقة غير مدعومة');
}
