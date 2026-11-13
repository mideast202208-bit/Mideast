import {cp,readdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const origin = new URL(process.env.GUIDE_ORIGIN || process.env.RENDER_EXTERNAL_URL).origin;
await cp('published-guide','guide-dist',{recursive:true});
async function visit(directory) {
  for (const entry of await readdir(directory,{withFileTypes:true})) {
    const path = join(directory,entry.name);
    if (entry.isDirectory()) await visit(path);
    else if (/\.(?:html|xml|txt|css|js)$/.test(path)) {
      const file = await readFile(path,'utf8');
      if (file.includes('https://guide-render.invalid')) {
        await writeFile(path,file.replaceAll('https://guide-render.invalid',origin));
      }
    }
  }
}
await visit('guide-dist');
