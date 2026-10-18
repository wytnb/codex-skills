const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const workflow=require('./workflow.cjs');
const source=fs.readFileSync(require.resolve('./run-browser-batch.js'),'utf8');
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'windy-driver-test-')),previousCwd=process.cwd();
const skillDir=path.dirname(__dirname);
let clock=Date.parse('2026-10-18T02:00:00Z');
class ClockDate extends Date{constructor(...args){super(...(args.length?args:[clock]));}static now(){return clock;}}
function fastTimeout(fn,ms){return setTimeout(()=>{clock+=ms;fn();},Math.max(1,ms/1000));}
const point={id:'p',destinationId:'d',lat:27,lon:118,timeZone:'Asia/Shanghai',terrainElevationM:100,verifiedAt:'2026-10-18',verification:'named map and terrain'};
function fixture(name,mode){
 const runDir=name;workflow.prepare({pointIds:['p'],dates:['2026-10-23'],hours:[9],followup:false},{points:[point]},runDir,clock);
 let current=null,rows=[],initCalls=0,failed=false;const browserCalls=[],results=[];
 const helper={
  status:()=>current,
  init(config){initCalls++;rows=workflow.jobsFor(config).map(j=>({...j,taskId:config.taskId,shardId:config.shardId,configFingerprint:config.configFingerprint,model:'ecmwf',status:'ok',lat:27,lon:118,value:0,unit:j.overlay==='rain'?'mm':'%',...(j.overlay==='rain'?{periodHours:3}:{}),checkedAt:new ClockDate().toISOString()}));current={version:'2.3.0',taskId:config.taskId,shardId:config.shardId,configFingerprint:config.configFingerprint,done:0,total:rows.length,state:'ready',background:null,metrics:{startedAt:config.windowAnchor}};},
  start(){const partial=mode==='partial'&&rows.length>1;current.done=partial?1:rows.length;current.state=partial?'running':'complete';current.background={id:current.taskId+'-'+current.shardId,running:partial};return current;},
  recordsSince(after){return {...current,from:after,after:current.done,rows:rows.slice(after,current.done)};},
  checkpoint(){return {...current,rows};}
 };
 const ctx=vm.createContext({get WindyQuery(){return current?helper:undefined;}});
 const tools={
  async exec_command({cmd}){
   const parts=[...cmd.matchAll(/'((?:[^']|'')*)'/g)].map(m=>m[1].replaceAll("''","'")),args=parts.slice(1);
   if(mode==='ingest-timeout'&&args[0]==='ingest'&&!failed){failed=true;return new Promise(()=>{});}
   try{return {exit_code:0,output:JSON.stringify(workflow.main(args))};}catch(e){return {exit_code:1,output:e.message};}
  },
  async apply_patch(patch){
   const file=patch.match(/\*\*\* Add File: (.+)/)[1],data=patch.split('\n').filter(l=>l.startsWith('+')).map(l=>l.slice(1)).join('\n');
   fs.writeFileSync(file,data);return {};
  },
  async mcp__chrome_devtools__evaluate_script(args){
   browserCalls.push(clock);
   if(args.format==='script'){current=null;Object.defineProperty(ctx,'WindyQuery',{value:helper,writable:true,configurable:true});return response({ready:true});}
   let value=vm.runInContext('('+args.function+')()',ctx);
   if(mode==='start-timeout'&&args.function.includes('WindyQuery.init(')&&!failed){failed=true;current.state='running';current.background.running=true;return new Promise(()=>{});}
   return response(value);
  }
 };
 function response(value){return {content:[{type:'text',text:'```json\n'+JSON.stringify(value)+'\n```'}]};}
 async function run(){const fn=new AsyncFunction('tools','text','load','setTimeout','clearTimeout','Date',source);await fn(tools,r=>results.push(r),()=>({runDir,skillDir,pageIds:[1],budgetMs:45000}),fastTimeout,clearTimeout,ClockDate);return results.at(-1);}
 return {run,results,browserCalls,get initCalls(){return initCalls;},get current(){return current;},finish(){current.done=rows.length;current.state='complete';current.background.running=false;},hide(){current=null;Object.defineProperty(ctx,'WindyQuery',{value:undefined,writable:true,configurable:true});}};
}
(async()=>{
 process.chdir(temp);
 const normal=fixture('normal','normal');await normal.run();assert.equal(normal.initCalls,1);assert.equal(workflow.load('normal').summary.validRows,2);await normal.run();assert.equal(normal.initCalls,1);
 const partial=fixture('partial','partial');await partial.run();assert.equal(workflow.load('partial').bindings[1].cursor,1);partial.finish();await partial.run();assert.equal(partial.initCalls,1);assert.equal(workflow.load('partial').metrics.exportedRows,2);
 const lost=fixture('lost','partial');await lost.run();const originalTask=workflow.load('lost').taskId;lost.hide();await lost.run();assert.equal(lost.initCalls,2);assert.equal(workflow.load('lost').taskId,originalTask);assert.equal(workflow.load('lost').metrics.exportedRows,2);assert.equal(workflow.load('lost').summary.validRows,2);
 const timeout=fixture('timeout','start-timeout');assert.equal((await timeout.run()).kind,'observation-timeout');await timeout.run();assert.equal(timeout.initCalls,1);
 const uncertain=fixture('uncertain','start-timeout');await uncertain.run();uncertain.hide();assert.equal((await uncertain.run()).kind,'start-uncertain');assert.equal(uncertain.initCalls,1);
 const orphan=fixture('orphan','ingest-timeout');assert.equal((await orphan.run()).kind,'observation-timeout');await orphan.run();assert.equal(orphan.initCalls,1);assert.equal(workflow.load('orphan').summary.validRows,2);assert.equal(workflow.load('orphan').metrics.exportedRows,2);
 for(const f of [normal,partial,lost,timeout,uncertain,orphan])for(let i=1;i<f.browserCalls.length;i++)assert(f.browserCalls[i]-f.browserCalls[i-1]>=5100,'Repeated page calls must stay paced');
 console.log('PASS: driver cold start, session-reset incremental save, no duplicate initialization, bounded start/ingest timeouts, uncertain-start stop, orphan receipt recovery, cross-invocation page pacing.');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{process.chdir(previousCwd);assert(path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep+'windy-driver-test-'));fs.rmSync(temp,{recursive:true,force:true});});
