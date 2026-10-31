import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createRecoveryBundle} from '../src/recovery.mjs';
process.umask(0o077);
const path=resolve(process.env.DB_PATH||'data/mid-east.sqlite'),db=new DatabaseSync(path,{readOnly:true});
try{
 const key=process.env.APP_ENCRYPTION_KEY?Buffer.from(process.env.APP_ENCRYPTION_KEY,'hex'):readFileSync(process.env.KEY_PATH||resolve(dirname(path),'server.key'));
 const result=await createRecoveryBundle(db,key,{directory:process.env.BACKUP_DIR||'backups',sourceRoot:resolve(new URL('..',import.meta.url).pathname),publicKey:process.env.BACKUP_PUBLIC_KEY?.replaceAll('\\n','\n'),env:process.env});
 console.log(JSON.stringify({filename:result.filename,bytes:result.bytes,sha256:result.sha256,schema_version:result.schema_version}));
}finally{db.close();}
