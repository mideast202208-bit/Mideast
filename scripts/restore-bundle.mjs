import {readFileSync} from 'node:fs';
import {restoreRecoveryBundle} from '../src/recovery.mjs';
process.umask(0o077);
const [source,target]=process.argv.slice(2);if(!source||!target||!process.env.RECOVERY_PRIVATE_KEY_FILE)throw new Error('Usage: RECOVERY_PRIVATE_KEY_FILE=... node scripts/restore-bundle.mjs ENCRYPTED.mebak NEW_DIRECTORY');
try{const r=await restoreRecoveryBundle(source,target,readFileSync(process.env.RECOVERY_PRIVATE_KEY_FILE),process.env.RECOVERY_KEY_PASSPHRASE);console.log(JSON.stringify({...r,table_counts:undefined}));}catch{console.error('Restore refused. Check encrypted file integrity, recovery key and NEW empty destination.');process.exitCode=1;}
