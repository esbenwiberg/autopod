import datetime,hashlib,importlib.util,json,math,pathlib,re,time
spec=importlib.util.spec_from_file_location('dispatch','/private/tmp/autopod-rollout-134/dispatch.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
rows=[]
def check(name,path,verify):
 start=time.monotonic();v=m.api(path);result=verify(v);rows.append({'check':name,'path':re.sub(r'/pods/[^/]+/(task-execution|execution-provenance|retry-state|dispatch-preflight|validations)',r'/pods/<sample>/\1',path),'status':'verified','elapsedMs':round((time.monotonic()-start)*1000),'projection':result});return v
def health(v):
 r=v['release'];assert r['commitSha']=='089442b63e5827894da40c91c764b47ff4562073' and r['dirty'] is False and r['source']=='build';assert re.fullmatch('[a-f0-9]{64}',r['validationImplementationHash']);assert v['database']['connected'];assert v['queue']['active_sessions']==0 and v['queue']['queued_sessions']==0
 return {'release':r,'databaseConnected':True,'queue':v['queue'],'healthStatus':v['status'],'backup':v['backup'],'securityMl':v['security_ml']}
def history(v):assert isinstance(v,list) and len(v)<=10;return {'rows':len(v),'diagnosticRows':sum(bool(x.get('readDiagnostics')) for x in v)}
def cost(v):
 assert isinstance(v,dict) and math.isfinite(v['total']) and isinstance(v['byPhase'],list);assert v['telemetry']['completeness'] in ['partial','recorded'] and v['telemetry']['infrastructureCost']=='unavailable';assert len(v['sparkline'])==30
 phase=sum(x['costUsd'] for x in v['byPhase']);assert math.isclose(phase,v['total'],rel_tol=1e-8,abs_tol=1e-8);return {'total':v['total'],'phaseTotal':phase,'phaseSumMatches':math.isclose(phase,v['total'],rel_tol=1e-8,abs_tol=1e-8),'telemetryCompleteness':v['telemetry']['completeness'],'infrastructureCost':'unavailable','diagnosticCount':len(v['telemetry']['diagnostics'])}
def task(v):
 assert v['taskId'] and v['executionId'] and v['telemetry'] in ['partial','complete'];assert v['delivery']['scope']=='durable-receipts-only';assert v['merge']['liveVerified'] is False
 return {'telemetry':v['telemetry'],'deliveryScope':v['delivery']['scope'],'recordedDeliveryReceipts':v['delivery']['receiptCount'],'providerDispositionLiveVerified':False}
def page(v):assert isinstance(v['pods'],list) and len(v['pods'])<=10 and (v['nextCursor'] is None or isinstance(v['nextCursor'],str));return {'rows':len(v['pods']),'hasNext':v['nextCursor'] is not None}
def latest(v):assert 'latest' in v;return {'legacyLatestUnavailable':v['latest'] is None}
def arr(v):assert isinstance(v,list);return {'rows':len(v)}
try:
 check('full-health','/health?detail=full',health)
 pods=check('bounded-history','/pods?limit=10',history)
 check('compact-page','/pods?compact=true&page=true&limit=10',page)
 check('cost-telemetry','/pods/analytics/cost?days=30',cost)
 for p in pods[:2]:
  ident=p['id'];check('task-accounting','/pods/'+ident+'/task-execution',task);check('execution-provenance','/pods/'+ident+'/execution-provenance?schemaVersion=2',latest);check('validation-history','/pods/'+ident+'/validations',arr)
 state=json.loads(m.STATE.read_text())
 for j in state['jobs']:check('scheduled-report-list','/scheduled-jobs/'+j['id']+'/reports',arr)
 status='verified'
except Exception as e:status='incomplete';rows.append({'status':'failed','errorClass':type(e).__name__})
output={'status':status,'candidate':'089442b63e5827894da40c91c764b47ff4562073','observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'checks':rows,'historicalFailureCause':'unknown; these current checks are not retrospective diagnosis'}
pathlib.Path('/private/tmp/autopod-rollout-134/acceptance-result.json').write_text(json.dumps(output,indent=2)+'\n');print(json.dumps(output));raise SystemExit(0 if status=='verified' else 1)
