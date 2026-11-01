import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, chmodSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import {requiresRecoveryKey} from '../src/recovery.mjs';

process.umask(0o077);
const [sourceArg,targetArg]=process.argv.slice(2);
if(!sourceArg || !targetArg)throw new Error('Usage: node scripts/restore.mjs BACKUP.sqlite NEW_TARGET.sqlite');
const source=resolve(sourceArg),target=resolve(targetArg);
if(existsSync(target)||existsSync(target+'-wal')||existsSync(target+'-shm'))throw new Error('Target exists. Restore only into a NEW stopped instance.');
const expected=readFileSync(source+'.sha256','utf8').trim();
if(createHash('sha256').update(readFileSync(source)).digest('hex')!==expected)throw new Error('Backup hash mismatch');
const keyTarget=process.env.KEY_PATH || resolve(dirname(target),'server.key');
let savedKey=null;
if(existsSync(source+'.key')){
  if(existsSync(keyTarget))throw new Error('Encryption key target exists; restore to a separate directory.');
  savedKey=readFileSync(source+'.key');
  if(savedKey.length!==32||createHash('sha256').update(savedKey).digest('hex')!==readFileSync(source+'.key.sha256','utf8').trim())throw new Error('Backup encryption key integrity failed');
}
const check=new DatabaseSync(source,{readOnly:true});
const hasFactors=check.prepare("SELECT 1 FROM sqlite_master WHERE name='login_factors'").get();
const requiresKey=requiresRecoveryKey(check);
if(requiresKey&&!savedKey)throw new Error('Encrypted settings exist but the backup key sidecar is missing');
if(check.prepare('PRAGMA quick_check').get().quick_check!=='ok' || check.prepare('PRAGMA foreign_key_check').all().length)throw new Error('Backup integrity check failed');
check.close();mkdirSync(dirname(target),{recursive:true,mode:0o700});copyFileSync(source,target);chmodSync(target,0o600);
if(savedKey){mkdirSync(dirname(keyTarget),{recursive:true,mode:0o700});copyFileSync(source+'.key',keyTarget);chmodSync(keyTarget,0o600);}
const restored=new DatabaseSync(target);restored.exec('DELETE FROM sessions');restored.close();
console.log('Restored to new target; all previous sessions were revoked.');
