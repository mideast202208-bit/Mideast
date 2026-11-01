import test from 'node:test';
import assert from 'node:assert/strict';
import {inflateRawSync,crc32} from 'node:zlib';
import {execFileSync} from 'node:child_process';
import {JSDOM} from 'jsdom';
import {openDatabase} from '../src/db.mjs';
import {uid,now,createContact,createLead} from '../src/service.mjs';
import {hash,token} from '../src/security.mjs';
import {createApp} from '../src/server.mjs';
import {installEducationWorkspace} from '../src/education.mjs';
import {customerExportRows,customerWorkbook,customerExportColumns,cairoDay} from '../src/customer-export.mjs';
import {renderFixture,fixture as uiFixture} from './ui-fixture.mjs';

function setup(){
 const db=openDatabase(':memory:'),users={};
 for(const role of ['admin','manager','agent','accountant']){const user={id:uid(),role};db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?)').run(user.id,'Synthetic '+role,role+'@example.test','unused',role,1,now());users[role]=user;}
 const first=createContact(db,users.admin,{name:'أحمد علي',phone:'+201000000010',email:'synthetic@example.test',source:'website'}),second=createContact(db,users.admin,{name:'عميل بلا فرصة',phone:'+201000000020'});
 createLead(db,users.admin,{contact_id:first.id,title:'فرصة سابقة',stage:'new'});const latest=createLead(db,users.admin,{contact_id:first.id,title:'فرصة أحدث',stage:'qualified'});
 db.prepare("UPDATE leads SET updated_at='2026-11-02T00:00:00.000Z' WHERE contact_id=?").run(first.id);db.prepare("UPDATE leads SET stage='qualified',updated_at='2026-11-03T00:00:00.000Z' WHERE id=?").run(latest.id);db.prepare("UPDATE pipeline_stages SET label='مؤهل للمتابعة' WHERE stage_key='qualified'").run();
 db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?)').run(uid(),first.id,null,'متابعة',null,'open',users.admin.id,now());
 installEducationWorkspace(db,users.admin);const app=key=>db.prepare('SELECT id FROM studio_apps WHERE app_key=?').get(key).id;
 for(const [name,ref,status,service] of [['طالب أول','ME-2026-AAAAAAAAAA','جمع المستندات','قبول جامعي'],['طالب ثان','ME-2026-BBBBBBBBBB','تم التقديم','توثيق']]){
  const student=uid();db.prepare('INSERT INTO app_records VALUES(?,?,?,?,?,?,?)').run(student,app('me_students'),name,users.admin.id,JSON.stringify({guardian:first.id}),now(),now());db.prepare('INSERT INTO app_records VALUES(?,?,?,?,?,?,?)').run(uid(),app('me_admissions'),'طلب',users.admin.id,JSON.stringify({student,reference:ref,application_status:status,requested_service:service}),now(),now());
 }
 return {db,users,first,second};
}
function unzip(bytes){
 const files=new Map();let p=0;
 while(bytes.readUInt32LE(p)===0x04034b50){const n=bytes.readUInt16LE(p+26),extra=bytes.readUInt16LE(p+28),size=bytes.readUInt32LE(p+18),start=p+30+n+extra,name=bytes.subarray(p+30,p+30+n).toString(),raw=inflateRawSync(bytes.subarray(start,start+size));assert.equal(raw.length,bytes.readUInt32LE(p+22));assert.equal(crc32(raw),bytes.readUInt32LE(p+14));files.set(name,raw.toString());p=start+size;}
 assert.equal(bytes.readUInt32LE(p),0x02014b50);assert.equal(bytes.readUInt32LE(bytes.length-22),0x06054b50);return files;
}
test('one row per customer preserves latest opportunity status, renamed stages, all shared-guardian file statuses and service names',()=>{
 const {db,users,first}=setup();try{
  const {rows}=customerExportRows(db,users.admin),row=rows.find(r=>r[0]==='أحمد علي');assert.equal(rows.length,2);assert.equal(row[1],'مؤهل للمتابعة');assert.equal(row[2],'فرصة أحدث');assert.match(row[3],/فرصة سابقة/);assert.match(row[4],/طالب أول \[ME-2026-AAAAAAAAAA\]: جمع المستندات/);assert.match(row[4],/طالب ثان \[ME-2026-BBBBBBBBBB\]: تم التقديم/);assert.match(row[5],/قبول جامعي/);assert.match(row[5],/توثيق/);assert.equal(row[6],'+201000000010');assert.equal(row[10],1);assert.equal(typeof row[11],'number');assert.equal(rows.find(r=>r[0]==='عميل بلا فرصة')[1],'بدون فرصة');
  const filtered=customerExportRows(db,users.admin,{scope:'filtered',query:'احمد'});assert.equal(filtered.rows.length,1);assert.equal(customerExportRows(db,users.admin,{scope:'filtered',query:'لا تطابق'}).rows.length,0);assert.equal(customerExportRows(db,users.admin,{scope:'all',query:'لا تطابق'}).rows.length,2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM contacts').get().n,2);assert.equal(db.prepare('SELECT COUNT(*) n FROM leads WHERE contact_id=?').get(first.id).n,2);
 }finally{db.close();}
});
test('native XLSX is a valid ZIP with Arabic text, frozen headings, filters, numeric dates and literal formula-like input',()=>{
 const {db,users}=setup();try{
  const rows=customerExportRows(db,users.admin).rows;rows[0][0]='=HYPERLINK("https://example.invalid")\u0000 <اسم> 😀';const bytes=customerWorkbook(rows),files=unzip(bytes);
  for(const xml of files.values())assert.equal(new JSDOM(xml,{contentType:'application/xml'}).window.document.querySelector('parsererror'),null);
  const doc=new JSDOM(files.get('xl/worksheets/sheet1.xml'),{contentType:'application/xml'}).window.document;assert.equal(doc.querySelectorAll('sheetData row').length,3);assert.equal(doc.querySelector('sheetView').getAttribute('rightToLeft'),'1');assert.equal(doc.querySelector('pane').getAttribute('state'),'frozen');assert.equal(doc.querySelector('autoFilter').getAttribute('ref'),'A1:M3');assert.equal(doc.querySelector('c[r="A2"]').getAttribute('t'),'inlineStr');assert.match(doc.querySelector('c[r="A2"] t').textContent,/^=HYPERLINK/);assert.equal(doc.querySelector('f'),null);assert.equal(doc.querySelector('c[r="G2"]').getAttribute('t'),'inlineStr');assert.equal(doc.querySelector('c[r="L2"]').getAttribute('t'),null);assert.equal(doc.querySelectorAll('row[r="1"] c').length,customerExportColumns.length);
  const check=execFileSync('python3',['-c','import sys,io,zipfile,xml.etree.ElementTree as E; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); assert z.testzip() is None; [E.fromstring(z.read(p)) for p in z.namelist()]; print("valid")'],{input:bytes,encoding:'utf8'});assert.equal(check.trim(),'valid');
  assert.equal(cairoDay('2026-11-01T23:30:00Z'),'2026-11-02');assert.match(unzip(customerWorkbook([])).get('xl/worksheets/sheet1.xml'),/ref="A1:M1"/);
 }finally{db.close();}
});
test('export endpoint requires owner authentication and CSRF, returns XLSX and records a count-only audit',async()=>{
 const {db,users}=setup(),app=createApp({db,secretKey:Buffer.alloc(32,3),env:{}});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+app.server.address().port+'/api/contacts/export.xlsx';
 try{
  const auth={};for(const [role,user] of Object.entries(users)){const value=token(),csrf=token();db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(hash(value),user.id,csrf,new Date(Date.now()+3600000).toISOString());auth[role]={cookie:'me_session='+value,csrf};}
  const request=(role,csrf=true,body={scope:'filtered',query:'احمد'})=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...(role?{Cookie:auth[role].cookie,...(csrf?{'X-CSRF-Token':auth[role].csrf}:{})}:{})},body:JSON.stringify(body)});
  assert.equal((await request()).status,401);assert.equal((await request('admin',false)).status,403);for(const role of ['manager','agent','accountant'])assert.equal((await request(role)).status,403);
  const response=await request('admin');assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/spreadsheetml/);assert.match(response.headers.get('content-disposition'),/\.xlsx"$/);assert.equal(response.headers.get('x-export-count'),'1');assert.equal(response.headers.get('cache-control'),'no-store');const files=unzip(Buffer.from(await response.arrayBuffer()));assert.match(files.get('xl/worksheets/sheet1.xml'),/أحمد علي/);assert.ok(!files.get('xl/worksheets/sheet1.xml').includes('عميل بلا فرصة'));
  const log=db.prepare("SELECT metadata FROM audit WHERE action='exported' AND entity='contacts'").all();assert.equal(log.length,1);assert.deepEqual(JSON.parse(log[0].metadata),{count:1,scope:'filtered'});assert.equal((await request('admin',true,{scope:'invalid'})).status,400);
 }finally{await new Promise(resolve=>app.server.close(resolve));db.close();}
});
test('the export button is visible to the owner in every customer layout and absent for staff and other pages',async()=>{
 for(const role of ['admin','manager','agent']){const data=structuredClone(uiFixture);data.users[0].role=role;const ui=await renderFixture(data);for(const mode of ['cards','list','table']){const html=ui.recordMode('contacts',mode);assert.equal(html.includes('data-action="export-customers"'),role==='admin');}assert.ok(!ui.page('leads').includes('data-action="export-customers"'));}
});
