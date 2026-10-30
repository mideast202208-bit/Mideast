import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,readFileSync,rmSync,readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDatabase } from '../src/db.mjs';
import { createSnapshot,maybeSnapshot } from '../src/backups.mjs';
import { encryptSecret,decryptSecret } from '../src/integration-settings.mjs';
test('encrypted settings and MFA remain recoverable with key sidecar and periodic backup does not duplicate',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'mid-east-key-backup-')),key=Buffer.alloc(32,8),db=openDatabase(':memory:');
  try{
    db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?)').run('qa-owner','Owner','owner@example.test','synthetic','admin',1,new Date().toISOString());
    const cipher=encryptSecret('synthetic-access-token',key);db.prepare('INSERT INTO settings VALUES(?,?)').run('wa.accessToken',cipher);
    await assert.rejects(()=>createSnapshot(db,null,folder));
    const env={BACKUP_INTERVAL_HOURS:'24',BACKUP_DIR:join(folder,'snapshots')};
    const first=await maybeSnapshot(db,key,env);assert.ok(first);assert.equal(await maybeSnapshot(db,key,env),undefined);
    assert.equal(readdirSync(env.BACKUP_DIR).filter(n=>n.endsWith('.sqlite')).length,1);
    const restoredPath=join(folder,'restored','mid-east.sqlite');
    execFileSync(process.execPath,['scripts/restore.mjs',first,restoredPath],{cwd:new URL('..',import.meta.url)});
    const restored=openDatabase(restoredPath);try{
      const savedKey=readFileSync(join(folder,'restored','server.key'));
      assert.deepEqual(savedKey,key);assert.equal(decryptSecret(restored.prepare("SELECT value FROM settings WHERE key='wa.accessToken'").get().value,savedKey),'synthetic-access-token');
    }finally{restored.close();}
  }finally{db.close();rmSync(folder,{recursive:true,force:true});}
});
