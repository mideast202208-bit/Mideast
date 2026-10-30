import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { resolve } from 'node:path';
import { openDatabase } from '../src/db.mjs';
import { hashPassword } from '../src/security.mjs';
import { uid, now } from '../src/service.mjs';
import { installEducationWorkspace } from '../src/education.mjs';

process.umask(0o077);
if(!stdin.isTTY)throw new Error('Run setup in an interactive terminal; passwords must not be passed as arguments.');
const db=openDatabase(process.env.DB_PATH || resolve('data/mid-east.sqlite'));
if(db.prepare('SELECT id FROM users LIMIT 1').get())throw new Error('An administrator already exists. Setup does not replace accounts.');
const prompt=createInterface({input:stdin,output:stdout});
const name=(await prompt.question('Company owner display name: ')).trim();
const email=(await prompt.question('Administrator email: ')).trim().toLowerCase();
prompt.close();
function hidden(label){
  stdout.write(label);stdin.setRawMode(true);stdin.resume();
  return new Promise((resolve,reject)=>{
    let value='';
    const read=chunk=>{
      for(const char of chunk.toString()){
        if(char==='\u0003'){cleanup();reject(new Error('Cancelled'));return;}
        if(char==='\r'||char==='\n'){cleanup();stdout.write('\n');resolve(value);return;}
        if(char==='\u007f'||char==='\b')value=value.slice(0,-1);
        else if(char>=' ' && value.length<256)value+=char;
      }
    };
    const cleanup=()=>{stdin.off('data',read);stdin.setRawMode(false);stdin.pause();};
    stdin.on('data',read);
  });
}
try{
  if(!name || name.length>200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new Error('Valid name and email required.');
  const password=await hidden('Password (12+ characters, hidden): ');
  if(password!==await hidden('Confirm password (hidden): '))throw new Error('Passwords do not match.');
  const encoded=await hashPassword(password);
  const ownerId=uid();
  db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?)').run(ownerId,name,email,encoded,'admin',1,now());
  db.prepare('INSERT INTO settings VALUES(?,?)').run('company_name','ميد إيست');
  db.prepare('INSERT INTO settings VALUES(?,?)').run('currency','EGP');
  installEducationWorkspace(db,{id:ownerId,role:'admin'});
  console.log('Administrator created. Password was not printed or stored in source.');
}finally{db.close();}
