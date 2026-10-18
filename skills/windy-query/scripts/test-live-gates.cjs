const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
async function scenario(mode){
 let clock=Date.parse('2026-10-18T00:00:00+08:00'),stamp=Date.parse('2026-10-22T00:00:00+08:00'),writes=0,reads=0,callback=()=>{};
 class ClockDate extends Date{constructor(...args){super(...(args.length?args:[clock]));}static now(){return clock;}}
 const el=value=>({get innerText(){return typeof value==='function'?value():value;},getClientRects:()=>[{}]});
 const picker=el(()=>{reads++;return mode==='restricted'?'Premium':mode==='loading'&&reads===1?'云\n加载中':'云\n50 %\n?';});
 const q=s=>s==='.box-text'?el(()=>{const p=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',day:'numeric',hour:'numeric',minute:'2-digit',hourCycle:'h23'}).formatToParts(stamp).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));return '周五 '+p.day+' - '+p.hour+':'+p.minute;}):s==='.picker'?picker:s==='.picker__title'?el('云'):s==='a.selected[data-ident="clouds"]'?el('云'):null;
 const context={Date:ClockDate,Intl,performance:{now:()=>clock},setTimeout:(fn,ms)=>{clock+=ms;queueMicrotask(fn);},getComputedStyle:()=>({visibility:'visible',display:'block',opacity:'1'}),location:{hostname:'www.windy.com',href:'https://www.windy.com/'},document:{body:{},querySelector:q,querySelectorAll:()=>[]},MutationObserver:class{constructor(fn){callback=fn;}observe(){}disconnect(){}},W:{store:{get:k=>({product:'ecmwf',overlay:'clouds',pickerLocation:{lat:27,lon:118},timestamp:stamp})[k],set:(k,v)=>{if(k==='timestamp'){writes++;stamp=v-((mode==='once'&&writes===1||mode==='persistent')?3600000:0);callback([{target:{nodeType:1,closest:()=>({})}}]);}}},map:{map:{latLngToContainerPoint(){},setView(){}}}}};
 vm.runInNewContext(fs.readFileSync(require.resolve('./windy-batch.js'),'utf8'),context);
 context.WindyQuery.init({points:[{id:'p',lat:27,lon:118,terrainElevationM:100,verifiedAt:'2026-10-18',verification:'map and terrain'}],times:['2026-10-23T09:00:00+08:00'],overlays:['clouds'],verifyMode:'fast'});
 const r=await context.WindyQuery.step();return{r,writes,reads,helper:context.WindyQuery};
}
(async()=>{
 const fixed=await scenario('once');assert.equal(fixed.r.done,1);assert.equal(fixed.r.rows[0].timeCorrection,true);assert.equal(fixed.writes,2);
 const firstStart=fixed.helper.start(),secondStart=fixed.helper.start();assert.equal(firstStart.background.id,secondStart.background.id);assert.notEqual(firstStart.background.attemptId,secondStart.background.attemptId);
 const bad=await scenario('persistent');assert.equal(bad.r.state,'needs_review');assert.equal(bad.r.done,0);assert.equal(bad.writes,2);
 const loaded=await scenario('loading');assert.equal(loaded.r.done,1);assert.equal(loaded.r.rows[0].settleReads,2);
 const restricted=await scenario('restricted');assert.equal(restricted.r.state,'needs_review');assert.equal(restricted.r.done,0);assert.equal(restricted.reads,1);
 console.log('PASS: one clock correction succeeds, persistent mismatch pauses without a row, transient loading has one extra read, restriction stops immediately.');
})().catch(e=>{console.error(e);process.exitCode=1;});
