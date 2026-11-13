import {mkdir,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';

const legacy = 'https://middle-east-student-guide.mideast202208.chatgpt.site';
const source = new URL(process.env.GUIDE_SOURCE || legacy).origin;
const destination = new URL(process.env.GUIDE_ORIGIN || process.env.RENDER_EXTERNAL_URL).origin;
const output = 'published-guide';
const resources = ['/assets/style.css','/assets/premium.css','/assets/search.js','/assets/guide-navigation.css'];
const errors = [];

async function read(route) {
  const response = await fetch(new URL(route,source),{signal:AbortSignal.timeout(30000),redirect:'error'});
  if (!response.ok) throw new Error(route+' returned HTTP '+response.status);
  return response.text();
}
function replaceOrigins(text) {
  return text.replaceAll(source,destination).replaceAll(legacy,destination);
}
async function write(path,value) {
  const file = join(output,path);
  await mkdir(dirname(file),{recursive:true});
  await writeFile(file,value);
}

const sitemap = await read('/sitemap.xml');
const routes = [...new Set(Array.from(sitemap.matchAll(/<loc>([^<]+)<\/loc>/g),match=>{
  const url = new URL(match[1]);
  if (url.origin!==source || !/^\/(?:[a-z0-9-]+\/)*$/.test(url.pathname)) throw new Error('Unexpected sitemap route');
  return url.pathname;
}))];
if (routes.filter(path=>path.startsWith('/universities/')).length < 1300) throw new Error('Incomplete university index');

const pages = [...new Set(['/',...routes])];
const paths = [...pages,...resources];
let next = 0;
await Promise.all(Array.from({length:14},async()=>{
  while (next < paths.length) {
    const path = paths[next++];
    try {
      const body = await read(path);
      if (path.endsWith('/') && !/<html\b/i.test(body)) throw new Error('Expected HTML');
      if (resources.includes(path) && /<html\b/i.test(body)) throw new Error('Expected static asset');
      await write(path.endsWith('/') ? path.slice(1)+'index.html' : path.slice(1),replaceOrigins(body));
    } catch (error) {
      errors.push(error.message);
    }
  }
}));
if (errors.length) throw new Error(errors.length+' pages or assets could not be copied. '+errors.slice(0,12).join(' | '));
await write('sitemap.xml',replaceOrigins(sitemap));
await write('robots.txt','User-agent: *\nAllow: /\nSitemap: '+destination+'/sitemap.xml\n');
console.log('Published '+pages.length+' HTML pages and '+resources.length+' guide assets.');
