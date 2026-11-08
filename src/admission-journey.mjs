import { randomUUID } from 'node:crypto';

export function ensureAdmissionJourneyFields(db,appId){
  const status=db.prepare("SELECT id,options FROM app_fields WHERE app_id=? AND field_key='application_status' AND type='select'").get(appId);
  if(status){
    const previous=JSON.parse(status.options);
    const options=[...new Set([...previous,'قيد المراجعة','انتظار قرار','استكمال إجراءات القيد','قيد مؤكد'])];
    if(options.length!==previous.length)db.prepare('UPDATE app_fields SET options=? WHERE id=?').run(JSON.stringify(options),status.id);
  }
  const exists=db.prepare('SELECT 1 FROM app_fields WHERE app_id=? AND field_key=?');
  const insert=db.prepare("INSERT INTO app_fields VALUES(?,?,?,?,?,0,'[]',NULL,?)");
  for(const [key,label,type] of [
    ['academic_year','موسم التقديم','text'],
    ['official_reference','مرجع القبول أو القيد الرسمي','text'],
    ['decision_date','تاريخ القرار أو القيد','date']
  ]){
    if(exists.get(appId,key))continue;
    const position=db.prepare('SELECT COALESCE(MAX(position),-1)+1 AS n FROM app_fields WHERE app_id=?').get(appId).n;
    insert.run(randomUUID(),appId,key,label,type,position);
  }
}
