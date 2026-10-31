import {generateKeyPairSync} from 'node:crypto';
import {writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
process.umask(0o077);
const folder=resolve(process.argv[2]||'');if(!process.argv[2]||!process.env.RECOVERY_KEY_PASSPHRASE||process.env.RECOVERY_KEY_PASSPHRASE.length<20)throw new Error('Specify a NEW directory and provide a 20+ character RECOVERY_KEY_PASSPHRASE through a secure local environment. Never pass it as a command-line argument.');
if(existsSync(folder))throw new Error('Target directory exists');mkdirSync(folder,{recursive:true,mode:0o700});
const keys=generateKeyPairSync('rsa',{modulusLength:3072,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem',cipher:'aes-256-cbc',passphrase:process.env.RECOVERY_KEY_PASSPHRASE}});
writeFileSync(join(folder,'backup-public.pem'),keys.publicKey,{mode:0o600,flag:'wx'});writeFileSync(join(folder,'recovery-private.pem'),keys.privateKey,{mode:0o600,flag:'wx'});console.log('Recovery key pair created. Keep the encrypted private key and passphrase offline; install only the public key on Render.');
