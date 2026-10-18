/* Read the visible China Weather 8–15-day product. No network/API calls. */
(function(root) {
  'use strict';
  const weekdays={'日':0,'天':0,'一':1,'二':2,'三':3,'四':4,'五':5,'六':6};
  function resolveDates(labels, now=Date.now()) {
    const fields=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',
      year:'numeric',month:'numeric',day:'numeric'}).formatToParts(now)
      .filter(x=>x.type!=='literal').map(x=>[x.type,Number(x.value)]));
    const today=Date.UTC(fields.year,fields.month-1,fields.day);
    const parsed=labels.map(x=>x.match(/^周([一二三四五六日天])（(\d+)日）$/));
    if (parsed.some(x=>!x)) throw new Error('Unsupported date label.');
    let anchor=null;
    for(let offset=6;offset<=9;offset++) {
      const d=new Date(today+offset*86400000);
      if(d.getUTCDate()===Number(parsed[0][2])&&d.getUTCDay()===weekdays[parsed[0][1]]) {anchor=+d;break;}
    }
    if(anchor===null) throw new Error('Forecast period is stale or cannot be aligned with current query date.');
    return parsed.map((m,i)=>{
      const d=new Date(anchor+i*86400000);
      if(d.getUTCDate()!==Number(m[2])||d.getUTCDay()!==weekdays[m[1]])
        throw new Error('Nonconsecutive date or weekday mismatch.');
      return d.toISOString().slice(0,10);
    });
  }
  function read() {
    const result={source:root.location.href,checkedAt:new Date().toISOString(),status:'needs_review'};
    try {
      if(!/(^|\.)weather\.com\.cn$/.test(root.location.hostname)) throw new Error('Unsupported provider.');
      const container=root.document.getElementById('15d');
      const elements=[...(container?.querySelectorAll('ul.t > li')||[])];
      if(elements.length!==8) throw new Error('Expected eight visible daily rows.');
      const pick=(el,s)=>el.querySelector(s)?.textContent.trim()||'';
      const labels=elements.map(el=>pick(el,'.time')), dates=resolveDates(labels);
      result.title=root.document.title;
      result.daily=elements.map((el,i)=>({date:dates[i],label:labels[i],weather:pick(el,'.wea'),
        temperature:pick(el,'.tem'),wind:pick(el,'.wind'),windForce:pick(el,'.wind1')}));
      if(result.daily.some(x=>!x.weather||!x.temperature||!x.wind)) throw new Error('Incomplete daily weather row.');
      result.status='ok';result.dateResolution='query-date + forecast horizon + weekday/sequence checks';
      result.scopeWarning='Provider scenic label does not prove summit elevation; keep Windy point evidence separate.';
    } catch(err) {result.error=String(err.message||err);}
    return result;
  }
  if(typeof module!=='undefined'&&module.exports) module.exports={resolveDates};
  else return read();
})(globalThis);
