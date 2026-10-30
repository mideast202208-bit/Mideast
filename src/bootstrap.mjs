import { timingSafeEqual } from 'node:crypto';
import { transaction } from './db.mjs';
import { hashPassword } from './security.mjs';
import { uid, now, text, fail, audit } from './service.mjs';
import { installEducationWorkspace } from './education.mjs';

export async function bootstrapOwner(db,input,expectedToken){
  if(db.prepare('SELECT id FROM users LIMIT 1').get())fail(409,'تم تجهيز النظام بالفعل');
  if(!expectedToken || expectedToken.length<32)fail(503,'تهيئة المتصفح غير مفعلة؛ استخدم تهيئة السيرفر');
  const supplied=Buffer.from(String(input.token||'')),expected=Buffer.from(expectedToken);
  if(supplied.length!==expected.length || !timingSafeEqual(supplied,expected))fail(403,'رمز التهيئة غير صحيح');
  const name=text(input.name,'اسم المالك'),email=text(input.email,'البريد',254).toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fail(400,'بريد غير صالح');
  let password;try{password=await hashPassword(input.password);}catch(error){fail(400,error.message);}
  const id=uid();transaction(db,()=>{
    if(db.prepare('SELECT id FROM users LIMIT 1').get())fail(409,'تم تجهيز النظام بالفعل');
    db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?)').run(id,name,email,password,'admin',1,now());
    db.prepare("INSERT OR REPLACE INTO settings VALUES('company_name',?)").run('ميد إيست');
    db.prepare("INSERT OR REPLACE INTO settings VALUES('currency','EGP')").run();audit(db,{id},'initialized','system','owner');
  });installEducationWorkspace(db,{id,role:'admin'});return {ok:true};
}
