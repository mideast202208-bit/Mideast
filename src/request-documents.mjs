import {audit,now,uid} from './service.mjs';
import {validateAppData} from './studio.mjs';
import {documentTypes} from '../public/documents.js';

const whatsappFiles=`FROM crm_activity x JOIN messages m ON m.id=x.event_id
  JOIN attachments a ON a.contact_id=x.contact_id AND
    (a.message_id=m.id OR a.id=json_extract(m.payload,'$.archived_attachment_id'))
  WHERE x.kind='agent_documents' AND x.lead_id=? AND x.contact_id=?`;

export function requestWhatsAppFiles(db,contactId,leadId){
  return db.prepare(`SELECT DISTINCT a.id,a.name,a.mime,a.created_at ${whatsappFiles} ORDER BY a.created_at,a.id`).all(leadId,contactId);
}

export function matchingRequestAttachment(db,contactId,leadId,bytes){
  const filed=db.prepare(`SELECT a.id FROM intake_registrations r JOIN app_records d
    ON json_extract(d.data,'$.application')=r.admission_id AND json_extract(d.data,'$.student')=r.student_id
    JOIN studio_apps s ON s.id=d.app_id AND s.app_key='me_documents'
    JOIN attachments a ON a.id=json_extract(d.data,'$.file_reference') AND a.contact_id=r.contact_id
    WHERE r.lead_id=? AND r.contact_id=? AND a.content=? ORDER BY a.created_at,a.id LIMIT 1`).get(leadId,contactId,bytes);
  return filed??db.prepare(`SELECT a.id ${whatsappFiles} AND a.content=? ORDER BY a.created_at,a.id LIMIT 1`).get(leadId,contactId,bytes);
}

export function documentOnAnotherRequest(db,attachmentId,studentId,admissionId){
  return db.prepare(`SELECT 1 FROM app_records d JOIN studio_apps s ON s.id=d.app_id AND s.app_key='me_documents'
    WHERE json_extract(d.data,'$.file_reference')=? AND
    (json_extract(d.data,'$.student') IS NOT ? OR COALESCE(NULLIF(json_extract(d.data,'$.application'),''),?)<>?) LIMIT 1`).get(attachmentId,studentId,admissionId,admissionId);
}

function supported({mime,content}){
  const bytes=Buffer.from(content);
  if(mime==='application/pdf')return bytes.subarray(0,5).toString()==='%PDF-';
  if(mime==='image/jpeg')return bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
  if(mime==='image/png')return bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  return mime==='image/webp'&&bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP';
}

export function fileWhatsAppRequestDocument(db,contactId,leadId,attachmentId){
  const requests=db.prepare(`SELECT r.student_id,r.admission_id,s.owner_id FROM intake_registrations r
    JOIN app_records s ON s.id=r.student_id AND json_extract(s.data,'$.guardian')=r.contact_id
    JOIN app_records a ON a.id=r.admission_id AND json_extract(a.data,'$.student')=s.id
    WHERE r.lead_id=? AND r.contact_id=? LIMIT 2`).all(leadId,contactId);
  if(requests.length!==1||db.prepare("SELECT 1 FROM leads WHERE contact_id=? AND id<>? AND stage NOT IN('won','lost') LIMIT 1").get(contactId,leadId))return;
  const request=requests[0],app=db.prepare("SELECT id FROM studio_apps WHERE app_key='me_documents'").get();
  if(!app||documentOnAnotherRequest(db,attachmentId,request.student_id,request.admission_id))return;
  const existing=db.prepare("SELECT id,data FROM app_records WHERE app_id=? AND json_extract(data,'$.file_reference')=? LIMIT 1").get(app.id,attachmentId);
  if(existing){
    const data=JSON.parse(existing.data);
    if(!data.application)db.prepare('UPDATE app_records SET data=?,updated_at=? WHERE id=?').run(JSON.stringify({...data,application:request.admission_id}),now(),existing.id);
    return;
  }
  const file=db.prepare('SELECT name,mime,content,created_at FROM attachments WHERE id=? AND contact_id=?').get(attachmentId,contactId);
  if(!file||!supported(file))return;
  let fields;
  try{
    fields=validateAppData(db,{id:request.owner_id,role:'admin'},app.id,{student:request.student_id,application:request.admission_id,
      document_type:documentTypes.other,document_status:'صورة مستلمة',received_date:file.created_at.slice(0,10),file_reference:attachmentId});
  }catch(error){
    if(![400,404,409].includes(error.status))throw error;
    return; // Keep the archived file available for the owner when custom fields need review.
  }
  const id=uid(),at=now();
  db.prepare('INSERT INTO app_records VALUES(?,?,?,?,?,?,?)').run(id,app.id,file.name,request.owner_id,fields,at,at);
  audit(db,null,'linked','student_document',id,{student_id:request.student_id,attachment_id:attachmentId,source:'whatsapp'});
}
