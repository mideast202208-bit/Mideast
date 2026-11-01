import {deflateRawSync,crc32} from 'node:zlib';
import {fail,text,audit} from './service.mjs';
import {filterRecordsBySearch} from '../public/student-records.js';

const sourceNames={manual:'يدوي',website:'الموقع',whatsapp:'واتساب',facebook:'فيسبوك',instagram:'إنستجرام',referral:'ترشيح',other:'أخرى'};
export const customerExportColumns=['اسم العميل','حالة العميل (أحدث فرصة)','الفرصة الأحدث','حالات الفرص المرتبطة','حالات ملفات الطلاب','الخدمات المطلوبة','الهاتف','البريد الإلكتروني','المسؤول','المصدر','مهام مفتوحة','تاريخ الإضافة (القاهرة)','آخر تحديث (القاهرة)'];
const xml=value=>String(value??'').toWellFormed().replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g,'').slice(0,32767).toWellFormed().replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
// A small, standards-based ZIP package, with no macros, external links or formulas.
function zip(parts){
 const local=[],central=[];let offset=0;
 for(const [path,xml] of Object.entries(parts)){
  const name=Buffer.from(path),data=Buffer.from(xml),compressed=deflateRawSync(data),crc=crc32(data),header=Buffer.alloc(30),entry=Buffer.alloc(46);
  header.writeUInt32LE(0x04034b50,0);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(8,8);header.writeUInt16LE(0x21,12);header.writeUInt32LE(crc,14);header.writeUInt32LE(compressed.length,18);header.writeUInt32LE(data.length,22);header.writeUInt16LE(name.length,26);
  entry.writeUInt32LE(0x02014b50,0);entry.writeUInt16LE(20,4);entry.writeUInt16LE(20,6);entry.writeUInt16LE(0x800,8);entry.writeUInt16LE(8,10);entry.writeUInt16LE(0x21,14);entry.writeUInt32LE(crc,16);entry.writeUInt32LE(compressed.length,20);entry.writeUInt32LE(data.length,24);entry.writeUInt16LE(name.length,28);entry.writeUInt32LE(offset,42);
  local.push(header,name,compressed);central.push(entry,name);offset+=header.length+name.length+compressed.length;
 }
 const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(Object.keys(parts).length,8);end.writeUInt16LE(Object.keys(parts).length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...local,directory,end]);
}
export function cairoDay(value=new Date()){
 const date=new Date(value);if(!Number.isFinite(date.getTime()))return '';
 const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Cairo',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date).map(v=>[v.type,v.value]));return p.year+'-'+p.month+'-'+p.day;
}
const dateCell=value=>{const day=cairoDay(value);return day?Math.round(Date.parse(day+'T00:00:00Z')/86400000)+25569:null;};

export function customerExportRows(db,user,input={}){
 if(user.role!=='admin')fail(403,'تصدير بيانات العملاء للمالك');
 const scope=input.scope||'all';if(!['all','filtered'].includes(scope))fail(400,'اختر نطاق التصدير');
 const query=text(input.query??'','البحث',160,false);
 const contacts=db.prepare('SELECT * FROM contacts ORDER BY created_at DESC,rowid DESC').all();
 const chosen=scope==='filtered'?filterRecordsBySearch(contacts,query):contacts;
 const stages=new Map(db.prepare('SELECT stage_key,label FROM pipeline_stages').all().map(s=>[s.stage_key,s.label]));
 const owners=new Map(db.prepare('SELECT id,name FROM users').all().map(u=>[u.id,u.name]));
 const leads=db.prepare('SELECT * FROM leads ORDER BY updated_at DESC,created_at DESC,rowid DESC').all();
 const requests=db.prepare(`SELECT json_extract(s.data,'$.guardian') contact_id,s.name student_name,s.id student_id,json_extract(a.data,'$.reference') reference,json_extract(a.data,'$.application_status') status,json_extract(a.data,'$.requested_service') service FROM app_records a JOIN studio_apps aa ON aa.id=a.app_id AND aa.app_key='me_admissions' JOIN app_records s ON s.id=json_extract(a.data,'$.student') JOIN studio_apps sa ON sa.id=s.app_id AND sa.app_key='me_students' ORDER BY a.created_at DESC,a.rowid DESC`).all();
 const tasks=new Map(db.prepare("SELECT contact_id,COUNT(*) count FROM tasks WHERE status='open' GROUP BY contact_id").all().map(t=>[t.contact_id,t.count]));
 const group=rows=>{const map=new Map();for(const r of rows){const list=map.get(r.contact_id)||[];list.push(r);map.set(r.contact_id,list);}return map;},byContact=group(leads),filesByContact=group(requests);
 const rows=chosen.map(c=>{
  const opportunities=byContact.get(c.id)||[],latest=opportunities[0],files=filesByContact.get(c.id)||[];
  const stage=l=>stages.get(l.stage)||l.stage;
  return [c.name,latest?stage(latest):'بدون فرصة',latest?.title||'',opportunities.map(l=>l.title+': '+stage(l)).join('\n'),files.map(f=>f.student_name+' ['+(f.reference||'ST-'+f.student_id.replaceAll('-','').slice(0,12).toUpperCase())+']: '+(f.status||'حالة غير مسجلة')).join('\n')||'لا توجد طلبات ملفات', [...new Set(files.map(f=>String(f.service||'').trim()).filter(Boolean))].join('\n'),c.phone||'',c.email||'',owners.get(c.owner_id)||'غير مسجل',sourceNames[c.source]||c.source||'غير مسجل',tasks.get(c.id)||0,dateCell(c.created_at),dateCell(c.updated_at)];
 });
 return {rows,scope};
}

export function customerWorkbook(rows){
 // SpreadsheetML package: https://learn.microsoft.com/en-us/office/open-xml/spreadsheet/structure-of-a-spreadsheetml-document
 if(rows.length>1048575)fail(413,'عدد العملاء يتجاوز سعة ورقة Excel');
 const ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main',rels='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
 const column=i=>String.fromCharCode(65+i),widths=[28,25,35,48,50,30,23,32,26,18,17,24,24];
 const strings=(value,ref,style)=>`<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
 const header=`<row r="1" ht="35" customHeight="1">${customerExportColumns.map((v,i)=>strings(v,column(i)+'1',1)).join('')}</row>`;
 const data=rows.map((values,r)=>`<row r="${r+2}" ht="${Math.min(96,Math.max(32,...values.map(v=>String(v??'').split('\n').length*16)))}" customHeight="1">${values.map((v,i)=>{const ref=column(i)+(r+2);return i>=10?(v===null?`<c r="${ref}" s="2"/>`:`<c r="${ref}" s="${i===10?3:2}"><v>${v}</v></c>`):strings(v,ref,0);}).join('')}</row>`).join('');
 const range='A1:M'+(rows.length+1);
 const styles=`<styleSheet xmlns="${ns}"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF173B4B"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top" wrapText="1" readingOrder="2"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1" readingOrder="2"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
 return zip({
  '[Content_Types].xml':'<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
  '_rels/.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="'+rels+'/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  'xl/workbook.xml':`<workbook xmlns="${ns}" xmlns:r="${rels}"><bookViews><workbookView/></bookViews><sheets><sheet name="العملاء" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  'xl/_rels/workbook.xml.rels':`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rels}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${rels}/styles" Target="styles.xml"/></Relationships>`,
  'xl/styles.xml':styles,
  'xl/worksheets/sheet1.xml':`<worksheet xmlns="${ns}"><dimension ref="${range}"/><sheetViews><sheetView workbookViewId="0" rightToLeft="1"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="20"/><cols>${widths.map((w,i)=>`<col min="${i+1}" max="${i+1}" width="${w}" customWidth="1"/>`).join('')}</cols><sheetData>${header}${data}</sheetData><autoFilter ref="${range}"/></worksheet>`
 });
}

export async function handleCustomerExport({db,user,path,method,req,res,jsonBody}){
 if(path!=='/api/contacts/export.xlsx'||method!=='POST')return false;
 if(user.role!=='admin')fail(403,'تصدير بيانات العملاء للمالك');
 const result=customerExportRows(db,user,await jsonBody(req)),bytes=customerWorkbook(result.rows);
 audit(db,user,'exported','contacts','xlsx',{count:result.rows.length,scope:result.scope});
 res.writeHead(200,{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':'attachment; filename="Middle-East-Customers-'+cairoDay()+'.xlsx"','Content-Length':bytes.length,'Cache-Control':'no-store','X-Export-Count':String(result.rows.length)});res.end(bytes);return true;
}
