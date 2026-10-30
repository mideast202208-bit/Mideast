import { uid,now,text,fail,manager,audit,getContact } from './service.mjs';
import { createQuote,listQuotes,changeQuote,invoiceFromQuote,printableDocument } from './sales.mjs';
import { installEducationWorkspace } from './education.mjs';
import { readiness } from './operations.mjs';

export async function handleBusiness(context){
  const {db,user,path,method,req,res,jsonBody,sendJson,config}=context;
  const respond=(status,value)=>{sendJson(res,status,value);return true;};
  if(path==='/api/quotes'){
    if(method==='GET')return respond(200,listQuotes(db,user));
    if(method==='POST')return respond(201,createQuote(db,user,await jsonBody(req)));
  }
  const quote=path.match(/^\/api\/quotes\/([^/]+)$/);
  if(quote&&method==='PATCH')return respond(200,changeQuote(db,user,quote[1],await jsonBody(req)));
  const convert=path.match(/^\/api\/quotes\/([^/]+)\/invoice$/);
  if(convert&&method==='POST'){const input=await jsonBody(req);return respond(201,invoiceFromQuote(db,user,convert[1],input.number));}
  const print=path.match(/^\/api\/print\/(quote|invoice)\/([^/]+)$/);
  if(print&&method==='GET'){
    const html=printableDocument(db,user,print[1],print[2]);
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(html);return true;
  }
  const notes=path.match(/^\/api\/contacts\/([^/]+)\/notes$/);
  if(notes){
    getContact(db,user,notes[1]);
    if(method==='GET')return respond(200,db.prepare('SELECT n.id,n.body,n.created_at,u.name AS author FROM customer_notes n JOIN users u ON u.id=n.created_by WHERE n.contact_id=? ORDER BY n.created_at DESC,n.rowid DESC LIMIT 100').all(notes[1]));
    if(method==='POST'){
      if(user.role==='accountant')fail(403,'الملاحظات لفريق العملاء');const input=await jsonBody(req),id=uid();
      db.prepare('INSERT INTO customer_notes VALUES(?,?,?,?,?)').run(id,notes[1],text(input.body,'الملاحظة',4000),user.id,now());
      audit(db,user,'noted','contact',notes[1],{note_id:id});return respond(201,{id});
    }
  }
  if(path==='/api/workspace/education'&&method==='POST')return respond(200,installEducationWorkspace(db,user));
  if(path==='/api/operations'&&method==='GET'){
    if(!manager(user))fail(403,'فحص التشغيل للإدارة');return respond(200,readiness(db,config));
  }
  return false;
}
