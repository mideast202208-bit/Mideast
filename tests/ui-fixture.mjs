import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {createRecordMessenger} from '../public/record-messenger.js';
import {chatHistory} from '../public/chat-ui.js';
export const fixture={
  contacts:[],leads:[],tasks:[],tickets:[],conversations:[],fields:[],automations:[],invoices:[],invoiceContacts:[],templates:[],appFields:[],appRecords:[],
  users:[{id:'qa-owner',name:'مساحة اختبار',email:'fixture@example.test',role:'admin',active:1}],
  settings:{company_name:'ميد إيست — بيانات اختبار'},
  apps:[{id:'qa-students',app_key:'students',name:'ملفات الطلاب',description:'تطبيق مخصص من الاستوديو'}],
  pipeline:[['new','جديد'],['contacted','تم التواصل'],['qualified','مؤهل'],['proposal','عرض سعر'],['won','تم التعاقد'],['lost','لم يكتمل']].map(([stage_key,label],position)=>({stage_key,label,position}))
};
export async function renderFixture(data=fixture){
  const elements=new Map();
  const element=selector=>{if(!elements.has(selector))elements.set(selector,{innerHTML:'',textContent:'',className:'',open:false,addEventListener(){},showModal(){this.open=true;},close(){this.open=false;}});return elements.get(selector);};
  const stripImports=source=>source.replace(/^import .*$/gm,'');
  const modules=['brand-icons.js','documents.js','countries.js','workspace.js','marketing.js'].map(file=>stripImports(readFileSync(new URL('../public/'+file,import.meta.url),'utf8')).replace(/export function /g,'function ').replace(/export const /g,'const ')).join('\n');
  const source=modules+'\n'+stripImports(readFileSync(new URL('../public/app.js',import.meta.url),'utf8'));
  const sandbox={createRecordMessenger,chatHistory,console,Date,Intl,Map,Set,JSON,Math,Number,String,Array,Object,RegExp,Error,Promise,FormData,
    setInterval:()=>0,clearInterval(){},setTimeout:()=>0,
    document:{querySelector:element,addEventListener(){},activeElement:null},
    fetch:async path=>({ok:true,status:200,json:async()=>path.endsWith('/setup/status')?{required:false}:path.endsWith('/me')?{user:data.users[0],csrf:'synthetic'}:path.endsWith('/hub')?(data.hub||{}):path.endsWith('/communication')?data.communication:path.endsWith('/assistant')?data.assistant:path.endsWith('/marketing')?data.marketing:data})};
  const script=new vm.Script(`(async()=>{${source}\nreturn {marketingTab:async(tab)=>{page='marketing';await load();await marketing.action('marketing-tab',tab);return document.querySelector('#app').innerHTML;},pageAsync:async(key)=>{page=key;await load();return document.querySelector('#app').innerHTML;},page:(key)=>{page=key;render();return document.querySelector('#app').innerHTML;},studio:(entity)=>{studioEntity=entity;page='studio';render();return document.querySelector('#app').innerHTML;}};})()`);
  return script.runInNewContext(sandbox);
}
