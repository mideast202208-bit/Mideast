import { transaction } from './db.mjs';
import { uid,now,fail,audit } from './service.mjs';

export function installEducationWorkspace(db,user){
  if(user.role!=='admin')fail(403,'تجهيز التطبيقات للمالك فقط');
  const result=[];
  transaction(db,()=>{
    const createApp=(key,name,description)=>{
      let app=db.prepare('SELECT * FROM studio_apps WHERE app_key=?').get(key);
      if(!app){app={id:uid()};db.prepare('INSERT INTO studio_apps VALUES(?,?,?,?,?)').run(app.id,key,name,description,now());}
      result.push(app.id);return app.id;
    };
    const addField=(appId,key,label,type,required=0,options=[],target=null)=>{
      const existing=db.prepare('SELECT * FROM app_fields WHERE app_id=? AND field_key=?').get(appId,key);
      if(existing){if(existing.type!==type||existing.relation_target!==target)fail(409,'الحقل الموجود يتعارض مع تجهيز التطبيق: '+key);return;}
      const position=db.prepare('SELECT COUNT(*) n FROM app_fields WHERE app_id=?').get(appId).n;
      db.prepare('INSERT INTO app_fields VALUES(?,?,?,?,?,?,?,?,?)').run(uid(),appId,key,label,type,required,JSON.stringify(options),target,position);
    };
    const students=createApp('me_students','الطلاب','ملف مستقل لكل طالب، ويمكن ربط عدة طلاب بجهة اتصال ولي أمر واحدة.');
    addField(students,'guardian','جهة اتصال الطالب أو ولي الأمر','relation',1,[],'contact');
    addField(students,'nationality','الجنسية','text');
    addField(students,'certificate','نوع الشهادة','select',1,['ثانوي سوداني','IGCSE','دبلومة أمريكية','شهادة عربية','أخرى']);
    addField(students,'academic_year','سنة التقديم','text',1);
    addField(students,'grade','النسبة أو التقدير','text');
    addField(students,'notes','ملاحظات الطالب','text');
    const admissions=createApp('me_admissions','طلبات القبول','رغبات الطالب والجامعة والكلية ومراحل متابعة طلب القبول.');
    addField(admissions,'student','الطالب','relation',1,[],students);
    addField(admissions,'reference','رقم الطلب','text');
    addField(admissions,'university','الجامعة المطلوبة','text',1);
    addField(admissions,'faculty','الكلية المطلوبة','text',1);
    addField(admissions,'level','المرحلة الدراسية','select',1,['بكالوريوس','ماجستير','دكتوراه']);
    addField(admissions,'application_status','حالة الملف','select',1,['استكمال البيانات','جمع المستندات','جاهز للتقديم','تم التقديم','قبول مبدئي','قبول نهائي','مغلق']);
    addField(admissions,'next_date','موعد المراجعة القادمة','date');
    const documents=createApp('me_documents','سجل المستندات','فهرس المستندات وحالة استلامها؛ الملف الفعلي يرفع إلى جهة الاتصال بعد تحديد الطالب.');
    addField(documents,'student','الطالب','relation',1,[],students);
    addField(documents,'application','طلب القبول','relation',0,[],admissions);
    addField(documents,'document_type','نوع المستند','select',1,['جواز السفر','شهادة الميلاد','الشهادة الدراسية','كشف الدرجات','صورة شخصية','مستند آخر']);
    addField(documents,'document_status','حالة المستند','select',1,['مطلوب','صورة مستلمة','قيد المراجعة','مقبول','يحتاج إعادة إرسال','الأصل مستلم']);
    addField(documents,'received_date','تاريخ الاستلام','date');
    addField(documents,'file_reference','معرف أو اسم المرفق في ملف العميل','text');
    audit(db,user,'installed','workspace','education',{apps:result});
  });return {apps:result,records_created:0};
}
