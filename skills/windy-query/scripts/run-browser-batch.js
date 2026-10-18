/* functions.exec AsyncFunction entry. Cursors persist on disk.
   Deadlines bound observation, not an in-flight tool or the browser queue. */
const cfg=load('windy-run-config');
if(!cfg?.runDir||!cfg?.skillDir)throw new Error('runDir and skillDir required');
if(cfg.runDir.includes('..')||/^[\\/]|:/.test(cfg.runDir))throw new Error('runDir must be workspace-relative');
const startMs=Date.now(),budgetMs=Math.min(55000,Math.max(1000,cfg.budgetMs??45000));
const quote=s=>"'"+String(s).replaceAll("'","''")+"'";
const deadline=async(factory,phase)=>{
 const left=budgetMs-(Date.now()-startMs);if(left<=0)throw Object.assign(new Error('Observation budget exhausted: '+phase),{kind:'observation-timeout'});
 let timer;
 try{return await Promise.race([factory(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('Observation timed out: '+phase),{kind:'observation-timeout'})),left);})]);}finally{clearTimeout(timer);}
};
const cli=async(mode,...args)=>{
 const r=await deadline(()=>tools.exec_command({cmd:['node',quote(cfg.skillDir+'/scripts/workflow.cjs'),quote(mode),quote(cfg.runDir),...args.map(quote)].join(' '),max_output_tokens:30000}), 'disk:'+mode);
 if(r.exit_code!==0)throw Object.assign(new Error(r.output?.slice(0,500)||'Workflow I/O failed'),{kind:'disk-or-config'});
 try{return JSON.parse(r.output);}catch(e){throw Object.assign(new Error('Workflow response parse failed'),{kind:'disk-or-config'});}
};
const decode=r=>{const message=r.content?.filter(c=>c.type==='text').map(c=>c.text).join('\n')||'',m=message.match(/```json\s*\n([\s\S]*?)\n```/);if(r.isError||!m)throw Object.assign(new Error(message.slice(0,300)),{kind:'browser-response'});return JSON.parse(m[1]);};
const lastCalls=new Map();
async function evaluate(pageId,source,format='function'){
 const last=lastCalls.get(pageId)||0,delay=Math.max(0,5100-(Date.now()-last));
 if(delay)await deadline(()=>new Promise(r=>setTimeout(r,delay)),'page-spacing');
 if(Date.now()-startMs>=budgetMs)throw Object.assign(new Error('Budget exhausted before browser call'),{kind:'observation-timeout'});
 lastCalls.set(pageId,Date.now());
 return decode(await deadline(()=>tools.mcp__chrome_devtools__evaluate_script({pageId,waitForStableDom:false,function:source,format}),'browser:'+pageId));
}
async function save(pageId,data,archive=false){
 const file=cfg.runDir+'/'+(archive?'archive/':'exports/')+Date.now()+'-'+pageId+'-'+Math.random().toString(36).slice(2,9)+'.json';
 const r=await deadline(()=>tools.apply_patch('*** Begin Patch\n*** Add File: '+file+'\n+'+JSON.stringify({pageId,observedAt:new Date().toISOString(),data})+'\n*** End Patch'),'disk:receipt');
 if(r?.isError||typeof r==='string'&&/error|failed/i.test(r))throw Object.assign(new Error('Receipt save failed'),{kind:'disk-or-config'});
 if(!archive)await cli('ingest',file);
 return file;
}
let activePage=null;
const observationId=Date.now()+'-'+Math.random().toString(36).slice(2,8);
try{
 let snapshot=await cli('snapshot');
 await cli('event','observation-start',observationId,budgetMs);
 for(const [page,b]of Object.entries(snapshot.bindings))if(b.lastBrowserObservedAt)lastCalls.set(Number(page),Date.parse(b.lastBrowserObservedAt));
 const pages=cfg.pageIds||[cfg.pageId||1];
 if(!pages.length||new Set(pages).size!==pages.length)throw Object.assign(new Error('Unique pageIds required'),{kind:'disk-or-config'});
 if(pages.length<snapshot.configs.length)throw Object.assign(new Error('Provide one verified page per pending shard'),{kind:'disk-or-config'});
 const outputs=[];
 let helperSource=null;
 for(let i=0;i<pages.length;i++){
  const page=Number(pages[i]);activePage=page;
  let config=snapshot.configs[i];if(!config)continue;
  let binding=snapshot.bindings[page],live=await evaluate(page,'() => globalThis.WindyQuery?.status() || null');
  const identity=live?.taskId===snapshot.taskId&&live?.configFingerprint===config.configFingerprint;
  if(live?.background?.running||live?.state==='running')if(!identity)throw Object.assign(new Error('Active different task/config; preserve it'),{kind:'page-identity'});
  if(identity){
   if(!binding||binding.configFingerprint!==config.configFingerprint)binding=await cli('bind',page,config.shardId);
   if(live.done<binding.cursor)throw Object.assign(new Error('Page lost persisted rows: recovery required'),{kind:'page-identity'});
   if(live.version!=='2.3.0')throw Object.assign(new Error('Managed helper version mismatch'),{kind:'page-identity'});
   if(live.state==='ready'&&!live.background?.running)live=await evaluate(page,'() => WindyQuery.start()');
  }else{
   if(binding?.configFingerprint===config.configFingerprint&&binding.phase==='start-intent')throw Object.assign(new Error('Uncertain previous start: await its tool result and verify page, then release-intent explicitly; no automatic relaunch'),{kind:'start-uncertain'});
   if(live?.total){
    if(live.state!=='complete')throw Object.assign(new Error('Different incomplete task on page; preserve/resolve it'),{kind:'page-identity'});
    await save(page,await evaluate(page,'() => WindyQuery.checkpoint()'),true);
   }
   binding=await cli('bind',page,config.shardId);
   if(binding.cursor){const recovered=await cli('recover-page',page);config=recovered.config;binding=recovered.binding;}
   else config=await cli('configuration',config.shardId);
   helperSource??=await cli('helper');
   await evaluate(page,helperSource,'script');
   live=await evaluate(page,'() => {WindyQuery.init('+JSON.stringify(config)+');return WindyQuery.start();}');
  }
  const after=binding.cursor,wait=Math.min(25000,Math.max(0,cfg.waitMs??0));
  if(wait)await deadline(()=>new Promise(r=>setTimeout(r,wait)),'observation-wait');
  const delta=await evaluate(page,'() => WindyQuery.recordsSince('+after+')');
  if(delta.taskId!==snapshot.taskId||delta.configFingerprint!==config.configFingerprint)throw Object.assign(new Error('Task changed between status and delta'),{kind:'page-identity'});
  await save(page,delta);
  outputs.push({page,done:delta.done,total:delta.total,state:delta.state,added:delta.rows.length,error:delta.error});
 }
 snapshot=await cli('snapshot');
 const allObserved=Object.values(snapshot.bindings).every(b=>!b.running&&b.state==='complete'&&b.cursor===b.total);
 const result=allObserved?{pages:outputs,workflow:await cli('reconcile')}:{pages:outputs,taskId:snapshot.taskId,status:snapshot.status,elapsedMs:Date.now()-startMs};
 await cli('event','observation-complete',observationId);
 text(result);
}catch(error){
 if(error.kind!=='observation-timeout'&&Date.now()-startMs<budgetMs-1500){try{await cli('event','observation-failed',observationId,error.kind||'driver');}catch(_){} }
 text({observation:'failed',kind:error.kind||'driver',page:activePage,error:String(error.message||error),elapsedMs:Date.now()-startMs,action:'Observe the same page and persisted task identity next; do not refresh or launch another queue.'});
}
