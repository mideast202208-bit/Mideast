import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readiness } from '../src/operations.mjs';
const path=process.env.DB_PATH||resolve('data/mid-east.sqlite');
if(!existsSync(path)){console.error('No database exists. Set up the application first.');process.exit(1);}
const db=new DatabaseSync(path,{readOnly:true});
try{
  const names={accessToken:'META_ACCESS_TOKEN',phoneId:'META_PHONE_NUMBER_ID',appSecret:'META_APP_SECRET',verifyToken:'META_VERIFY_TOKEN',intakeUser:'META_INTAKE_USER_ID'};
  const presence=Object.fromEntries(Object.entries(names).map(([key,env])=>[key,db.prepare('SELECT value FROM settings WHERE key=?').get('wa.'+key)?.value||process.env[env]]));
  console.log(JSON.stringify(readiness(db,presence),null,2));
}finally{db.close();}
