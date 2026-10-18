/* Candidate-wide weather completion gate and official report entry point. No network. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {summarize} = require('./summarize-readings.cjs');
const {fingerprint, localISO} = require('./make-plan.cjs');
const {instant, keyOf, WINDOW_MS} = require('./reading-validation.cjs');
const {read, write, createScope, syncScope, loadScope, prepareRuns} = require('./recommendation-scope.cjs');
const LEVELS = ['scenic-daily', 'trend', 'nearby', 'historical', 'seasonal'];
const active = c => ['A','B'].includes(c.status);
function artifact(dir, evidence) {
  if (!evidence?.file || !/^[a-f0-9]{64}$/.test(evidence.sha256 || '') ||
      typeof evidence.quote !== 'string' || evidence.quote.trim().length < 12)
    throw new Error('Evidence needs file, SHA256 and a nonempty quoted excerpt (>=12 characters)');
  const file = path.resolve(dir, evidence.file), bytes = fs.readFileSync(file);
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== evidence.sha256)
    throw new Error('Evidence file hash mismatch: ' + evidence.file);
  if (!bytes.toString('utf8').includes(evidence.quote)) throw new Error('Evidence excerpt not in file: ' + evidence.file);
}
function observed(value, scope, now) {
  const time = instant(value);
  if (!Number.isFinite(time) || time < instant(scope.createdAt) || time > now)
    throw new Error('Evidence must be observed during this task, no future or reused observations');
  return time;
}
function readRuns(dir, scope, now) {
  const rows = [], errors = [], runs = [];
  for (const run of scope.runs) {
    try {
      const runDir = path.resolve(dir, run.relativeDir);
      if (!runDir.startsWith(path.resolve(dir, 'runs') + path.sep)) throw new Error('Run outside scope');
      const state = read(path.join(runDir, 'state.json')), atlas = read(path.join(runDir, 'atlas.json'));
      if (run.request.recommendation?.scopeId !== scope.scopeId ||
          run.request.recommendation?.candidateId !== run.candidateId ||
          state.taskId !== run.request.taskId || fingerprint(state.request) !== fingerprint(run.request) ||
          fingerprint(atlas) !== state.atlasFingerprint ||
          atlas.points.some(p => fingerprint(p) !== fingerprint(scope.atlas.points.find(q => q.id === p.id))))
        throw new Error('Run request/atlas identity mismatch');
      if (Object.values(state.bindings).some(b => b.running || b.phase === 'start-intent'))
        throw new Error('Browser job is active or its start is unresolved');
      const bindings = [...Object.values(state.bindings), ...(state.retiredBindings || [])];
      const fingerprints = new Set();
      for (const b of bindings) {
        const c = b.config;
        if (!c || c.taskId !== state.taskId || fingerprint({taskId:c.taskId, shardId:c.shardId,
          points:c.points, overlays:c.overlays, verifyMode:c.verifyMode, displayTimeZone:c.displayTimeZone}) !== b.configFingerprint)
          throw new Error('Binding configuration fingerprint mismatch');
        fingerprints.add(b.configFingerprint);
      }
      const inputs = state.inputs.map(relative => {
        const file = path.resolve(runDir, relative);
        if (!file.startsWith(path.resolve(runDir, 'exports') + path.sep)) throw new Error('Receipt outside exports');
        const payload = read(file), data = payload.data;
        if (!data || data.taskId !== state.taskId || !fingerprints.has(data.configFingerprint))
          throw new Error('Unregistered receipt task/config');
        return {file, data: {...data, rows: (data.rows || []).filter(r => {
          const ts = instant(r.checkedAt);
          return fingerprints.has(r.configFingerprint) && r.configFingerprint === data.configFingerprint &&
            ts >= instant(scope.createdAt) && ts <= now;
        })}};
      });
      // Never trust saved summary counts. Revalidate original receipts, model, coordinates and read window.
      const result = summarize(atlas, inputs, run.request.dates, run.request.hours,
        {taskId: state.taskId, expectedJobs: [], maxCohortSpanMs: scope.registry.maxCohortSpanMs});
      rows.push(...result.valid);
      runs.push({run, state, result});
    } catch (e) { errors.push({run:run.relativeDir, error:e.message}); }
  }
  return {rows, errors, runs};
}
function requirementsWithFollowup(scope, valid) {
  const requirements = new Map(scope.requirements.map(r => [keyOf(r), r]));
  if (scope.registry.followup === false) return [...requirements.values()];
  const followup = scope.registry.followup || {};
  for (const c of scope.registry.candidates.filter(active)) for (const point of c.pointIds) for (const date of c.dates) {
    const primary = scope.requirements.filter(r => r.point === point && r.date === date);
    if (!primary.every(r => valid.has(keyOf(r)))) continue;
    const rows = primary.map(r => valid.get(keyOf(r))), cloud = rows.filter(r => r.overlay === 'clouds').map(r => r.value);
    if (!rows.some(r => r.overlay === 'rain' && (r.value > 0 || r.unit === 'cm')) &&
        Math.max(...cloud)-Math.min(...cloud) < (followup.cloudSpan ?? 30) && Math.max(...cloud) < (followup.cloudMax ?? 60)) continue;
    const p = scope.atlas.points.find(p => p.id === point);
    for (const hour of followup.hours || [18]) for (const overlay of ['rain','clouds']) {
      const r = {candidateId:c.id, point, date, hour, time:localISO(date,hour,p.timeZone), overlay, kind:'followup'};
      requirements.set(keyOf(r), r);
    }
  }
  return [...requirements.values()];
}
function checkFallback(dir, scope, fallback, requirements, evidence, now) {
  if (!fallback.id || !Array.isArray(fallback.slots) || !fallback.slots.length)
    throw new Error('Fallback needs ID and exact affected slots');
  observed(fallback.checkedAt, scope, now);
  const keys = fallback.slots.map(keyOf);
  if (new Set(keys).size !== keys.length || keys.some(k => !requirements.has(k)))
    throw new Error('Fallback contains duplicate or out-of-scope slots');
  const slots = keys.map(k => requirements.get(k));
  if (fallback.reason === 'beyond-168h') {
    // Recheck the moving boundary; a former beyond-window slot may now be queryable.
    if (slots.some(r => instant(r.time)-now <= WINDOW_MS)) throw new Error('Beyond-window fallback is now inside 168h or past');
  } else if (fallback.reason === 'query-failed') {
    const attempt = (evidence.attempts || []).find(a => a.id === fallback.attemptId);
    if (!attempt || !['restricted','adapter-failed','source-unavailable'].includes(attempt.reason))
      throw new Error('In-range fallback needs a recorded failed attempt');
    const at = observed(attempt.checkedAt, scope, now);
    artifact(dir, attempt.artifact);
    const affected = new Set((attempt.slots || []).map(keyOf));
    if (slots.some(r => !affected.has(keyOf(r)) || instant(r.time) < at || instant(r.time)-at > WINDOW_MS))
      throw new Error('Failure evidence does not cover these slots at an in-range attempt time');
  } else throw new Error('Unsupported fallback reason; workload, priority and expired slots are not reasons');
  const source = fallback.source, index = LEVELS.indexOf(source?.level);
  if (index < 0 || !/^https?:\/\//.test(source.url || '') || !source.geographicScope?.trim() ||
      !source.summary?.trim() || !source.limitations?.trim()) throw new Error('Incomplete fallback source and limitations');
  artifact(dir, source.artifact);
  if (source.kind !== (index<3?'forecast':source.level)) throw new Error('Source kind/level mismatch');
  if (slots.some(r => !source.pointIds?.includes(r.point) || !source.dates?.includes(r.date)))
    throw new Error('Fallback source does not explicitly cover these points/dates');
  const checked = fallback.earlierSources || [];
  for (const level of LEVELS.slice(0,index)) {
    const check = checked.find(c => c.level === level && c.outcome === 'unavailable');
    if (!check) throw new Error('Missing higher-priority source attempt: ' + level);
    observed(check.checkedAt,scope,now);
    artifact(dir, check.artifact);
  }
  return keys;
}
function checkCoverage(dir, evidenceFile = path.join(dir,'evidence.json'), now = Date.now()) {
  const scope = loadScope(dir), evidence = fs.existsSync(evidenceFile) ? read(evidenceFile) : {};
  if (evidence.scopeId && evidence.scopeId !== scope.scopeId) throw new Error('Evidence belongs to another scope');
  const attempts=evidence.attempts||[];
  if (!Array.isArray(attempts)||attempts.some(a=>!a.id)||new Set(attempts.map(a=>a.id)).size!==attempts.length)
    throw new Error('Failure attempts need unique IDs');
  const {rows, errors:runErrors} = readRuns(dir, scope, now), valid = new Map();
  for (const row of rows) {
    const k = keyOf(row), previous = valid.get(k);
    if (!previous || instant(row.checkedAt) > instant(previous.checkedAt)) valid.set(k,row);
  }
  const requirements = requirementsWithFollowup(scope,valid), wanted = new Map(requirements.map(r => [keyOf(r),r]));
  const errors = [...runErrors], fallbackKeys = new Set(), fallbackIds = new Set();
  if (scope.registry.samplingOverride) {
    try { artifact(dir,scope.registry.samplingOverride); }
    catch(e) { errors.push({error:'Sampling authorization: '+e.message}); }
  }
  for (const fallback of evidence.fallbacks || []) {
    try {
      if (fallbackIds.has(fallback.id)) throw new Error('Duplicate fallback ID');
      fallbackIds.add(fallback.id);
      if (!Array.isArray(fallback.slots)||fallback.slots.some(r=>!wanted.has(keyOf(r))))
        throw new Error('Fallback contains out-of-scope slots');
      const remaining=fallback.slots.filter(r=>!valid.has(keyOf(r)));
      // Keep historical fallback evidence; fresh Windy reads supersede it slot by slot.
      if (!remaining.length) continue;
      const keys = checkFallback(dir,scope,{...fallback,slots:remaining},wanted,evidence,now);
      if (keys.some(k => fallbackKeys.has(k))) throw new Error('Overlapping fallback coverage');
      keys.forEach(k => fallbackKeys.add(k));
    } catch (e) { errors.push({fallback:fallback.id, error:e.message}); }
  }
  for (const candidate of scope.registry.candidates.filter(c => !active(c))) {
    try { artifact(dir,candidate.exclusion); }
    catch (e) { errors.push({candidate:candidate.id, error:'Classification evidence: '+e.message}); }
  }
  // A/B -> C/D/X cannot silently discard a candidate: validate evidence even after sync.
  const cohorts = summarize(scope.atlas,[{file:'validated-runs',data:{rows:[...valid.values()]}}],
    scope.registry.travelDates,[9,12,15],{expectedJobs:[],maxCohortSpanMs:scope.registry.maxCohortSpanMs}).cohorts
    .filter(c=>scope.registry.candidates.some(candidate=>active(candidate)&&candidate.pointIds.includes(c.point)&&candidate.dates.includes(c.date)));
  for (const cohort of cohorts.filter(c=>c.needsReview)) {
    try {
      const review = (evidence.cohortReviews||[]).find(r=>r.point===cohort.point&&r.date===cohort.date);
      if (!review?.reason?.trim()) throw new Error('Wide read cohort needs documented review');
      artifact(dir,review.artifact);
    } catch (e) { errors.push({point:cohort.point,date:cohort.date,error:e.message}); }
  }
  const missing = requirements.filter(r => !valid.has(keyOf(r)) && !fallbackKeys.has(keyOf(r)));
  const candidates = scope.registry.candidates.filter(active).map(c => {
    const slots = requirements.filter(r=>r.candidateId===c.id);
    const direct = slots.filter(r=>valid.has(keyOf(r))).length;
    const fallback = slots.filter(r=>!valid.has(keyOf(r))&&fallbackKeys.has(keyOf(r))).length;
    return {id:c.id,required:slots.length,direct,fallback,missing:slots.length-direct-fallback};
  });
  const result = {scopeId:scope.scopeId,revision:scope.revision,checkedAt:new Date(now).toISOString(),
    ready:missing.length===0&&errors.length===0,candidates,requirements:requirements.length,
    direct:requirements.filter(r=>valid.has(keyOf(r))).length,
    fallback:requirements.filter(r=>!valid.has(keyOf(r))&&fallbackKeys.has(keyOf(r))).length,
    missing,errors};
  write(path.join(dir,'coverage.json'),result);
  return result;
}
function assertRanking(scope, ranking) {
  if (!Array.isArray(ranking.ranked)||!Array.isArray(ranking.excluded)) throw new Error('Report needs ranked and excluded arrays');
  if (!Array.isArray(ranking.weights)||!ranking.weights.length||ranking.weights.some(w=>!Number.isFinite(w)||w<=0))
    throw new Error('Report needs positive numeric scoring weights');
  const all = [...ranking.ranked,...ranking.excluded];
  if (new Set(all.map(r=>r.id)).size!==all.length || all.length!==scope.registry.candidates.length)
    throw new Error('Report candidate IDs must exactly match the full registry');
  const byId = new Map(all.map(r=>[r.id,r]));
  for (const candidate of scope.registry.candidates) {
    const row = byId.get(candidate.id);
    if (!row || row.status!==candidate.status || row.name!==candidate.name)
      throw new Error('Report candidate identity/status differs from registry: '+candidate.id);
    if (active(candidate)) {
      if (!ranking.ranked.includes(row)||!Number.isFinite(row.score)||row.score<0||row.score>100)
        throw new Error('Every A/B candidate needs a score: '+candidate.id);
      if (!Array.isArray(row.scores)||row.scores.length!==ranking.weights.length||row.scores.some(v=>!Number.isFinite(v)||v<0||v>10))
        throw new Error('Every scored candidate needs all subscores: '+candidate.id);
      const score=row.scores.reduce((n,v,i)=>n+v*ranking.weights[i],0)/ranking.weights.reduce((a,b)=>a+b,0)*10;
      if (Math.abs(score-row.score)>.051) throw new Error('Composite score differs from weighted subscores: '+candidate.id);
    } else if (!ranking.excluded.includes(row)||row.score!=null||row.scores!=null)
      throw new Error('C/D/X candidates must not be scored: '+candidate.id);
  }
  if (ranking.ranked.some((r,i,a)=>i>0&&a[i-1].score<r.score)) throw new Error('A/B candidates must be sorted together by score');
}
function assertReady(dir, ranking, evidenceFile, now=Date.now()) {
  const scope = loadScope(dir);
  assertRanking(scope, ranking);
  const coverage = checkCoverage(dir,evidenceFile,now);
  if (!coverage.ready) {
    const e = new Error(`Official report blocked: ${coverage.candidates.filter(c=>c.missing).length} candidates, ${coverage.missing.length} slots missing; ${coverage.errors.length} evidence errors`);
    e.coverage = coverage;
    throw e;
  }
  return coverage;
}
function writeOfficialReport(dir, ranking, markdown, outputFile, jsonFile, evidenceFile, now=Date.now()) {
  // This is the only formal writer: validation precedes all official output writes.
  const coverage = assertReady(dir,ranking,evidenceFile,now);
  const protectedFiles = [path.resolve(dir,'scope.json'),loadScope(dir).registryFile,path.resolve(evidenceFile||path.join(dir,'evidence.json'))];
  if ([outputFile,jsonFile].filter(Boolean).some(f=>protectedFiles.includes(path.resolve(f))))
    throw new Error('Report output would overwrite scope/evidence inputs');
  const stamp = `天气核验：${coverage.candidates.length}个评分候选；${coverage.direct}项Windy读数、${coverage.fallback}项有证据降级、0项待查。范围 ${coverage.scopeId}，修订 ${coverage.revision}。`;
  const result = {...ranking,weatherCoverage:coverage};
  fs.writeFileSync(outputFile,stamp+'\n\n'+markdown,'utf8');
  if (jsonFile) write(jsonFile,result);
  return coverage;
}
const esc = value => String(value??'—').replace(/\|/g,'／').replace(/[\r\n]+/g,' ');
function render(ranking) {
  const columns = [['目的地','name'],['天数','days'],['主要景观','feature'],['状态','status'],['综合分','score'],
    ['子评分','scores'],['交通/耗时','transport'],['两人往返费','fare'],['两人总花费','total'],['天气','weather'],
    ['每日通勤/强度','commute'],['逐日组合','plan'],['优势','pro'],['不足/风险','con'],['缺口/排除原因','gap']];
  const lines = ['# 目的地推荐','', '|'+columns.map(c=>c[0]).join('|')+'|','|'+columns.map(()=>'---').join('|')+'|'];
  for (const row of [...ranking.ranked,...ranking.excluded])
    lines.push('|'+columns.map(([,key])=>esc(key==='gap'?(row.gap||row.reason):Array.isArray(row[key])?row[key].join('／'):row[key])).join('|')+'|');
  return lines.join('\n');
}
function main(args) {
  const [mode,dir,...rest] = args;
  if (mode==='prepare') {
    const scope = createScope(dir,rest[0],rest[1]||path.join(__dirname,'../references/point-atlas.json'));
    return {scopeId:scope.scopeId,candidates:scope.registry.candidates.length,requirements:scope.requirements.length,runs:scope.runs.length,index:path.join(dir,'scope.json')};
  }
  if (mode==='sync') {
    const scope=syncScope(dir,rest[0]);return {scopeId:scope.scopeId,revision:scope.revision,runs:scope.runs.length,index:path.join(dir,'scope.json')};
  }
  if (mode==='resume-prepare') { const s=loadScope(dir);prepareRuns(dir,s,Date.now());return {runs:s.runs.length}; }
  if (mode==='check') return compactCoverage(checkCoverage(dir,rest[0]),dir);
  if (mode==='report') {
    const ranking=read(rest[0]);
    return compactCoverage(writeOfficialReport(dir,ranking,render(ranking),rest[1],rest[2],rest[3]),dir);
  }
  throw new Error('Usage: recommendation.cjs prepare scopeDir candidates.json [atlas.json] | sync scopeDir [atlas.json] | resume-prepare scopeDir | check scopeDir [evidence.json] | report scopeDir ranking.json output.md [output.json] [evidence.json]');
}
function compactCoverage(result,dir) {
  return {scopeId:result.scopeId,revision:result.revision,ready:result.ready,candidates:result.candidates.length,
    completeCandidates:result.candidates.filter(c=>!c.missing).length,requirements:result.requirements,
    direct:result.direct,fallback:result.fallback,missing:result.missing.length,errors:result.errors.length,
    coverageFile:path.join(dir,'coverage.json')};
}
if (require.main===module) {
  try { const result=main(process.argv.slice(2));console.log(JSON.stringify(result));if(result.ready===false)process.exitCode=1; }
  catch(e) { console.error(JSON.stringify({error:e.message}));process.exitCode=1; }
}
module.exports={artifact,checkCoverage,assertRanking,assertReady,writeOfficialReport,render,main};
