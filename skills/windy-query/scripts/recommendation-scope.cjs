/* Full candidate scope is independent of individual Windy runs. No network. */
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {makePlan, localISO, fingerprint} = require('./make-plan.cjs');
const {keyOf, instant} = require('./reading-validation.cjs');

const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function write(file, data) {
  const temp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(data, null, 2));
  fs.renameSync(temp, file);
}
function unique(values, label) {
  if (!Array.isArray(values) || !values.length || new Set(values).size !== values.length)
    throw new Error(label + ' must be a nonempty, unique array');
  return values;
}
function validateRegistry(registry, atlas) {
  if (registry.version !== 1) throw new Error('Candidate registry version must be 1');
  unique(registry.candidates?.map(c => c.id), 'candidate IDs');
  unique(atlas.points?.map(p => p.id), 'atlas point IDs');
  unique(registry.travelDates, 'travelDates');
  for (const date of registry.travelDates) localISO(date, 12, 'UTC');
  const followup = registry.followup ?? {};
  if (followup !== false) {
    unique(followup.hours || [18], 'followup hours');
    if ((followup.hours || [18]).some(h=>!Number.isInteger(h)||h<0||h>23) ||
        ['cloudSpan','cloudMax'].some(k=>followup[k]!=null&&(!Number.isFinite(followup[k])||followup[k]<0||followup[k]>100)))
      throw new Error('Invalid followup sampling policy');
  }
  if (registry.maxCohortSpanMs!=null&&(!Number.isFinite(registry.maxCohortSpanMs)||registry.maxCohortSpanMs<=0))
    throw new Error('Invalid cohort review limit');
  const reduced = followup===false || !(followup.hours||[18]).includes(18) ||
    (followup.cloudSpan??30)>30 || (followup.cloudMax??60)>60 || (registry.maxCohortSpanMs??1800000)>1800000;
  if (reduced && (!registry.samplingOverride?.reason?.trim()||!registry.samplingOverride?.file))
    throw new Error('Reduced sampling/review requires documented user authorization');
  const points = new Map(atlas.points.map(p => [p.id, p]));
  const all = [];
  for (const candidate of registry.candidates) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(candidate.id) || !candidate.name?.trim())
      throw new Error('Invalid candidate ID/name');
    if (!['A', 'B', 'C', 'D', 'X'].includes(candidate.status))
      throw new Error('Invalid candidate status: ' + candidate.id);
    if (!['A', 'B'].includes(candidate.status)) {
      if (!candidate.exclusion?.reason?.trim() || !candidate.exclusion?.file)
        throw new Error('Excluded/unresolved candidates need classification evidence: ' + candidate.id);
      continue;
    }
    unique(candidate.pointIds, candidate.id + ' pointIds');
    unique(candidate.dates, candidate.id + ' dates');
    const hours = candidate.hours || [9, 12, 15];
    unique(hours, candidate.id + ' hours');
    if (![9, 12, 15].every(h => hours.includes(h)))
      throw new Error('Recommendation sampling must include 9/12/15: ' + candidate.id);
    for (const id of candidate.pointIds) {
      const p = points.get(id);
      if (!p || p.destinationId !== candidate.id)
        throw new Error('Missing point or destination mismatch: ' + candidate.id + '/' + id);
      if ((atlas.unresolved || []).some(u => u.id === id))
        throw new Error('Unresolved geographic point: ' + id);
      for (const date of candidate.dates) {
        if (!registry.travelDates.includes(date)) throw new Error('Date outside travel scope: ' + date);
        for (const hour of hours) for (const overlay of ['rain', 'clouds']) {
          all.push({candidateId: candidate.id, point: id, date, hour,
            time: localISO(date, hour, p.timeZone), overlay});
        }
      }
    }
  }
  return all;
}
function loadScope(dir) {
  const scope = read(path.join(dir, 'scope.json'));
  const registry = read(scope.registryFile);
  if (fingerprint(registry) !== scope.registryFingerprint)
    throw new Error('Candidate registry changed; sync the complete scope before reporting');
  if (fingerprint(scope.registry) !== scope.registryFingerprint ||
      fingerprint(scope.atlas) !== scope.atlasFingerprint)
    throw new Error('Scope snapshot changed');
  const requirements = validateRegistry(scope.registry, scope.atlas);
  if (fingerprint(requirements) !== fingerprint(scope.requirements))
    throw new Error('Requirement matrix differs from the full candidate registry');
  return scope;
}
function planRuns(scope, previousKeys = new Set(), now = Date.now()) {
  const fresh = scope.requirements.filter(r => !previousKeys.has(keyOf(r)));
  // Group delta slots by point/date. Existing slots are never silently removed or repeated.
  const groups = new Map();
  for (const r of fresh) {
    const k = r.point + '|' + r.date;
    if (!groups.has(k)) groups.set(k, {candidateId: r.candidateId, point: r.point, date: r.date, hours: new Set()});
    groups.get(k).hours.add(r.hour);
  }
  const pointSchedules = new Map();
  for (const group of groups.values()) {
    const hours = [...group.hours].sort((a,b)=>a-b), k = group.point+'|'+hours.join(',');
    if (!pointSchedules.has(k)) pointSchedules.set(k,{candidateId:group.candidateId,point:group.point,hours,dates:[]});
    pointSchedules.get(k).dates.push(group.date);
  }
  const batches = new Map();
  for (const schedule of pointSchedules.values()) {
    schedule.dates.sort();
    const k = schedule.candidateId+'|'+schedule.hours.join(',')+'|'+schedule.dates.join(',');
    if (!batches.has(k)) batches.set(k,{...schedule,pointIds:[]});
    batches.get(k).pointIds.push(schedule.point);
  }
  const prepared = [];
  for (const group of batches.values()) {
    const request = {pointIds: group.pointIds, dates: group.dates, hours: group.hours,
      followup: scope.registry.followup ?? {}, shards: 1,
      displayTimeZone: scope.registry.displayTimeZone || 'Asia/Shanghai',
      verifyMode: scope.registry.verifyMode || 'fast',
      recommendation: {scopeId: scope.scopeId, candidateId: group.candidateId}};
    const plan = makePlan(scope.atlas, request, now);
    prepared.push({candidateId: group.candidateId, relativeDir: path.join('runs', plan.taskId), request: {...request, taskId: plan.taskId}});
  }
  return prepared;
}
function createScope(dir, registryFile, atlasFile, now = Date.now()) {
  if (fs.existsSync(dir) && fs.readdirSync(dir).length)
    throw new Error('Scope requires a new or empty directory');
  const registry = read(registryFile), atlas = read(atlasFile);
  const requirements = validateRegistry(registry, atlas);
  const scope = {version: 1, scopeId: 'scope-' + randomUUID(), createdAt: new Date(now).toISOString(),
    revision: 1, registryFile: path.resolve(registryFile), registryFingerprint: fingerprint(registry),
    registry, atlas, atlasFingerprint: fingerprint(atlas), requirements, runs: [], history: []};
  const runs = planRuns(scope, new Set(), now);
  fs.mkdirSync(dir, {recursive: true});
  // Save the entire denominator before the first browser job is started.
  scope.runs = runs;
  write(path.join(dir, 'scope.json'), scope);
  prepareRuns(dir, scope, now);
  return scope;
}
function prepareRuns(dir, scope, now) {
  const {prepare} = require('./workflow.cjs');
  for (const run of scope.runs) {
    const runDir = path.join(dir, run.relativeDir);
    if (!fs.existsSync(path.join(runDir, 'state.json'))) prepare(run.request, scope.atlas, runDir, now);
  }
}
function syncScope(dir, atlasFile, now = Date.now()) {
  const old = read(path.join(dir, 'scope.json'));
  if (fingerprint(old.registry) !== old.registryFingerprint || fingerprint(old.atlas) !== old.atlasFingerprint)
    throw new Error('Scope snapshot changed');
  const registry = read(old.registryFile), atlas = atlasFile ? read(atlasFile) : old.atlas;
  const requirements = validateRegistry(registry, atlas);
  for (const date of old.registry.travelDates)
    if (!registry.travelDates.includes(date)) throw new Error('Cannot shrink travel dates');
  for (const key of ['followup','maxCohortSpanMs','samplingOverride'])
    if (fingerprint(registry[key]??null)!==fingerprint(old.registry[key]??null))
      throw new Error('Cannot change sampling/review policy while syncing candidates');
  const byId = new Map(registry.candidates.map(c => [c.id, c]));
  for (const candidate of old.registry.candidates) {
    const next = byId.get(candidate.id);
    if (!next) throw new Error('Cannot remove candidate from scope: ' + candidate.id);
    // Reclassification is supported, but must retain the original candidate and documentary evidence.
    if (['A','B'].includes(next.status)) {
      for (const r of [...old.requirements,...old.history.flatMap(h=>h.requirements)].filter(r => r.candidateId === candidate.id))
        if (!requirements.some(n => n.candidateId === r.candidateId && keyOf(n) === keyOf(r)))
          throw new Error('Cannot shrink point/date/hour coverage: ' + candidate.id);
    }
  }
  const used = new Set(old.requirements.map(r => r.point));
  for (const id of used) {
    const previous = old.atlas.points.find(p => p.id === id), next = atlas.points.find(p => p.id === id);
    if (fingerprint(previous) !== fingerprint(next)) throw new Error('Existing point changed; use an explicit geographic correction task: ' + id);
  }
  const scope = {...old, revision: old.revision + 1, registry, registryFingerprint: fingerprint(registry),
    atlas, atlasFingerprint: fingerprint(atlas), requirements,
    history: [...old.history, {at: new Date(now).toISOString(), registryFingerprint: old.registryFingerprint,
      registry: old.registry, requirements: old.requirements}]};
  scope.runs = [...old.runs, ...planRuns(scope, new Set(old.runs.flatMap(run => {
    return run.request.pointIds.flatMap(id => {
      const p = old.atlas.points.find(p => p.id === id);
      return run.request.dates.flatMap(date => run.request.hours.flatMap(hour => ['rain','clouds'].map(overlay =>
        keyOf({point:p.id, time:localISO(date,hour,p.timeZone), overlay}))));
    });
  })), now)];
  write(path.join(dir, 'scope.json'), scope);
  prepareRuns(dir, scope, now);
  return scope;
}
module.exports = {read, write, unique, validateRegistry, createScope, syncScope, loadScope, prepareRuns};
