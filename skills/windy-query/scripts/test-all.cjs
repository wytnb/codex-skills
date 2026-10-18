const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const tests=fs.readdirSync(__dirname).filter(f=>/^test-.+\.cjs$/.test(f)&&f!=='test-all.cjs').sort();
for(const test of tests){const r=spawnSync(process.execPath,[path.join(__dirname,test)],{encoding:'utf8'});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');if(r.status!==0){process.exitCode=1;break;}}
if(!process.exitCode)console.log('PASS: '+tests.length+' test groups.');
