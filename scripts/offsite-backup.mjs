import {runOffsiteBackup} from '../src/drive-backup.mjs';
try{console.log(JSON.stringify(await runOffsiteBackup(process.env)));}catch(error){console.error(/^[A-Z0-9_]+$/.test(error.message)?error.message:'OFFSITE_BACKUP_FAILED');process.exitCode=1;}
