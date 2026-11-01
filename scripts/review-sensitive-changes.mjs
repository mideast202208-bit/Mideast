import {execFileSync} from 'node:child_process';
import {appendFileSync} from 'node:fs';
const files=execFileSync('git',['diff','--name-only','HEAD^','HEAD'],{encoding:'utf8'}).trim().split('\n');
const sensitive=files.filter(p=>/^(src\/(security|server|db|migrations|integration-settings|recovery|backup|startup|storage)|deploy\/|\.github\/)/.test(p));
const message=sensitive.length?'Owner review required before production for security, persistence or deployment changes.\n\n'+sensitive.map(p=>'- '+p).join('\n'):'No matching sensitive paths in this commit.';
if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,message+'\n');console.log(message);
