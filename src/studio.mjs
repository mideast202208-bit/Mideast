import { transaction } from './db.mjs';
import { uid, now, manager, fail, text, owner, audit, getContact } from './service.mjs';

export function validKey(value) {
  const key=text(value,'المعرف',50);
  if(!/^[a-z][a-z0-9_]{1,49}$/.test(key)||['constructor','prototype','__proto__'].includes(key))fail(400,'استخدم معرفًا إنجليزيًا آمنًا بحروف وأرقام وشرطة سفلية');
  return key;
}
export function appFor(db,id) {
  const app=db.prepare('SELECT * FROM studio_apps WHERE id=?').get(id);
  if(!app)fail(404,'التطبيق غير موجود');return app;
}
export function recordFor(db,user,id,appId) {
  const record=db.prepare('SELECT * FROM app_records WHERE id=? AND app_id=?').get(id,appId);
  if(!record || (!manager(user)&&record.owner_id!==user.id) || user.role==='accountant')fail(404,'السجل غير متاح');
  return record;
}
export function fieldDefinition(db,input) {
  const key=validKey(input.field_key),label=text(input.label,'اسم الحقل',100);
  if(!['text','number','date','select','boolean','relation'].includes(input.type))fail(400,'نوع الحقل غير صالح');
  const choices=input.options || [];
  if(!Array.isArray(choices)||choices.length>100||choices.some(x=>typeof x!=='string'||!x.trim()||x.length>100))fail(400,'خيارات غير صالحة');
  if(input.type==='select'&&!choices.length)fail(400,'أضف اختيارات القائمة');
  let target=null;
  if(input.type==='relation'){
    target=text(input.relation_target,'التطبيق المرتبط',100);
    if(!['contact','lead'].includes(target))appFor(db,target);
  }
  return {key,label,type:input.type,required:input.required?1:0,options:JSON.stringify(choices),target};
}
function validateRelation(db,user,target,id){
  if(typeof id!=='string')fail(400,'مرجع السجل غير صالح');
  if(target==='contact'){getContact(db,user,id);return;}
  if(target==='lead'){
    const lead=db.prepare('SELECT contact_id FROM leads WHERE id=?').get(id);
    if(!lead)fail(400,'الفرصة المرتبطة غير موجودة');getContact(db,user,lead.contact_id);return;
  }
  recordFor(db,user,id,target);
}
export function validateAppData(db,user,appId,input={}){
  if(!input||typeof input!=='object'||Array.isArray(input))fail(400,'بيانات النموذج غير صالحة');
  const fields=db.prepare('SELECT * FROM app_fields WHERE app_id=? ORDER BY position,rowid').all(appId);
  const keys=new Set(fields.map(f=>f.field_key));const cleaned=Object.create(null);
  for(const key of Object.keys(input))if(!keys.has(key))fail(400,'حقل غير معروف: '+key);
  for(const field of fields){
    const value=input[field.field_key];
    if(value===undefined||value===null||value===''){if(field.required)fail(400,'حقل مطلوب: '+field.label);continue;}
    if(field.type==='number'){if(typeof value!=='number'||!Number.isFinite(value))fail(400,'رقم غير صالح: '+field.label);}
    else if(field.type==='boolean'){if(typeof value!=='boolean')fail(400,'اختيار غير صالح: '+field.label);}
    else if(field.type==='relation')validateRelation(db,user,field.relation_target,value);
    else{
      if(typeof value!=='string'||value.length>4000)fail(400,'قيمة غير صالحة: '+field.label);
      if(field.type==='select'&&!JSON.parse(field.options).includes(value))fail(400,'اختيار غير متاح: '+field.label);
      if(field.type==='date'&&(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value))fail(400,'تاريخ غير صالح: '+field.label);
    }
    cleaned[field.field_key]=value;
  }
  return JSON.stringify(cleaned);
}
export function saveRecord(db,user,appId,input,id){
  if(user.role==='accountant')fail(403,'التطبيق غير متاح لهذا الدور');appFor(db,appId);
  const current=id?recordFor(db,user,id,appId):null;
  const recordId=id||uid(),name=text(input.name ?? current?.name,'عنوان السجل');
  const assigned=owner(db,user,input.owner_id || current?.owner_id);
  const values=validateAppData(db,user,appId,input.data ?? (current?JSON.parse(current.data):{}));
  transaction(db,()=>{
    if(current)db.prepare('UPDATE app_records SET name=?,owner_id=?,data=?,updated_at=? WHERE id=?').run(name,assigned,values,now(),recordId);
    else db.prepare('INSERT INTO app_records VALUES(?,?,?,?,?,?,?)').run(recordId,appId,name,assigned,values,now(),now());
    audit(db,user,current?'updated':'created','app_record',recordId,{app_id:appId});
  });return {id:recordId};
}
export function reorderFields(db,user,entity,ids){
  if(!manager(user))fail(403,'للإدارة فقط');
  if(!Array.isArray(ids)||ids.length>200||new Set(ids).size!==ids.length)fail(400,'ترتيب غير صالح');
  const builtIn=['contact','lead'].includes(entity);
  const table=builtIn?'studio_fields':'app_fields',column=builtIn?'entity':'app_id';
  if(!builtIn)appFor(db,entity);
  const all=db.prepare(`SELECT id FROM ${table} WHERE ${column}=?`).all(entity).map(f=>f.id);
  if(ids.length!==all.length||ids.some(id=>!all.includes(id)))fail(400,'يجب إرسال كل حقول النموذج مرة واحدة');
  transaction(db,()=>{ids.forEach((id,index)=>db.prepare(`UPDATE ${table} SET position=? WHERE id=?`).run(index,id));audit(db,user,'reordered','form',entity);});
}
