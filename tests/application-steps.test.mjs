import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

test('five existing application stages retain all fields and show the only submit control after final review',()=>{
 const html=readFileSync(new URL('../public/apply.html',import.meta.url),'utf8'),source=readFileSync(new URL('../public/apply.js',import.meta.url),'utf8');
 assert.deepEqual([...html.matchAll(/data-step="(\d+)"/g)].map(m=>+m[1]),[0,1,2,3,4]);
 for(const name of ['requested_service','level','certificate','academic_year','university','faculty','name','nationality_code','phone_country','phone','email','notes','consent','whatsapp_opt_in'])assert.equal([...html.matchAll(new RegExp('name="'+name+'"','g'))].length,1,name);
 const final=html.split('<fieldset data-step="4"')[1].split('</fieldset>')[0];assert.match(final,/id="review-data"/);assert.match(final,/name="consent" type="checkbox" required/);assert.match(html.split('<fieldset data-step="3"')[1].split('</fieldset>')[0],/whatsapp_opt_in/);
 const els=new Map(),node=()=>({hidden:false,textContent:'',style:{},children:[],append(...xs){this.children.push(...xs);},replaceChildren(){this.children=[];}}),get=id=>{if(!els.has(id))els.set(id,node());return els.get(id);};
 const steps=Array.from({length:5},node),form={elements:Object.fromEntries(['name','phone','nationality_code','level','certificate','academic_year'].map(k=>[k,{value:k==='name'?'<script>unsafe</script>':'synthetic'}]))};
 const ctx=vm.createContext({steps,form,current:0,selectedFiles:[],countries:[],serviceSelect:{value:''},error:node(),document:{querySelector:get,createElement:node}});
 vm.runInContext(source.slice(source.indexOf('function showStep('),source.indexOf('function validStep(')),ctx);
 for(let i=0;i<5;i++){vm.runInContext('showStep('+i+')',ctx);assert.equal(steps.filter(s=>!s.hidden).length,1);assert.equal(steps[i].hidden,false);assert.equal(get('#step-label').textContent,'الخطوة '+(i+1)+' من 5');assert.equal(get('#send-application').hidden,i!==4);assert.equal(get('#next-step').hidden,i===4);assert.equal(get('#step-progress').style.width,(i+1)*20+'%');}
 assert.equal(get('#review-data').children[1].children[1].textContent,'<script>unsafe</script>');
 vm.runInContext('showStep(5)',ctx);assert.equal(ctx.current,4);vm.runInContext('showStep(0)',ctx);assert.equal(get('#send-application').hidden,true);
 assert.match(source,/fetch\('\/public\/registrations'/);assert.match(source,/body\.request_key=requestKey/);
});
