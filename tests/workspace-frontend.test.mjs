import test from 'node:test';
import assert from 'node:assert/strict';
import {renderFixture,fixture} from './ui-fixture.mjs';

test('unified communication and assistant views render real modules and escape customer-controlled text',async()=>{
 const unsafe='<img src=x onerror=alert(1)>',data=structuredClone(fixture);
 data.communication={accounts:[{id:'primary-whatsapp',channel:'whatsapp',account_id:'1000',name:unsafe,primary:true,state:'needs_setup'}],threads:[{key:'whatsapp:synthetic:1000',name:unsafe,preview:unsafe,account_name:unsafe,account_id:'1000',channel:'whatsapp',status:'open',unread:1,last_at:'2026-10-31T00:00:00Z'}],totals:{all:1,unread:1,open:1}};
 data.assistant={metrics:{customers:1,overdue_tasks:0,new_leads:0,open_tickets:0},settings:{enabled:false,key_set:false,model:''},history:[],suggestions:['ملخص الشركة'],answer:unsafe,sources:['العملاء'],cards:[{title:unsafe,detail:unsafe,page:'contacts'}],mode:'local'};
 const ui=await renderFixture(data),communications=await ui.pageAsync('communications'),assistant=await ui.pageAsync('assistant');
 assert.match(communications,/كل محادثاتك/);assert.match(communications,/&lt;img/);assert.ok(!communications.includes('<img src=x'));
 assert.match(assistant,/مساعد ميد إيست/);assert.match(assistant,/&lt;img/);assert.ok(!assistant.includes('<img src=x'));
 assert.match(communications,/brand-icon/);assert.match(assistant,/تحليل مباشر من النظام/);
});
