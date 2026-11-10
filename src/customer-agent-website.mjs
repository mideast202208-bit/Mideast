import {parse} from 'parse5';
import {approvedWebsiteUrl} from './customer-agent-policy.mjs';
import {fail} from './service.mjs';

const excluded=new Set(['script','style','template','noscript','svg','iframe','nav','header','footer','button','form']);
const clean=value=>String(value??'').replace(/\s+/gu,' ').trim();

function extract(html){
  let title='',description='';
  const paragraphs=[];
  const content=node=>node.nodeName==='#text'?node.value:excluded.has(node.tagName)?'':(node.childNodes??[]).map(content).join('');
  function visit(node){
    if(excluded.has(node.tagName)||node.attrs?.some(a=>a.name==='hidden'||a.name==='aria-hidden'&&a.value==='true'))return;
    if(node.tagName==='title')title=clean(content(node));
    if(node.tagName==='meta'&&node.attrs?.some(a=>a.name==='name'&&a.value.toLowerCase()==='description'))description=clean(node.attrs.find(a=>a.name==='content')?.value);
    if(node.tagName==='p'||/^h[1-4]$/.test(node.tagName??'')){
      const line=clean(content(node));
      if(line&&!paragraphs.includes(line))paragraphs.push(line);
    }
    for(const child of node.childNodes??[])visit(child);
  }
  visit(parse(html));
  const excerpt=[...new Set([description,...paragraphs].filter(Boolean))].join('\n');
  if(!excerpt)fail(422,'الصفحة لا تعرض نصًا قابلًا للاستيراد؛ أضف الإجابة بعد مراجعتها يدويًا');
  return {title:(title||paragraphs[0]||'صفحة من موقع الشركة').slice(0,160),excerpt:excerpt.slice(0,5000)};
}

export async function previewWebsiteKnowledge(value,transport=fetch){
  if(!approvedWebsiteUrl(value))fail(400,'اختر صفحة عامة من موقع ميدل إيست الرسمي');
  let url=new URL(value).href,response;
  const signal=AbortSignal.timeout(10000);
  try{
    response=await transport(url,{headers:{Accept:'text/html'},redirect:'manual',signal});
    if([301,302,307,308].includes(response.status)){
      const location=response.headers.get('location');
      const next=location&&new URL(location,url).href;
      if(!next||!approvedWebsiteUrl(next))fail(422,'الصفحة تحوّل إلى عنوان خارج موقع الشركة');
      await response.body?.cancel();
      url=next;
      response=await transport(url,{headers:{Accept:'text/html'},redirect:'error',signal});
    }
    if(!response.ok||!response.headers.get('content-type')?.toLowerCase().startsWith('text/html')||!response.body)fail(422,'الصفحة غير متاحة كنص عام');
    const chunks=[];
    let total=0;
    for await(const chunk of response.body){
      total+=chunk.length;
      if(total>2*1024*1024)fail(413,'الصفحة أكبر من الحد المسموح');
      chunks.push(Buffer.from(chunk));
    }
    return {url,...extract(Buffer.concat(chunks).toString('utf8'))};
  }catch(error){
    if(error.status)throw error;
    fail(502,'تعذر جلب صفحة الموقع الآن');
  }
}
