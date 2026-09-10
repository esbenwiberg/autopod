import contextlib,copy,importlib.util,io,json,pathlib,tempfile
spec=importlib.util.spec_from_file_location('dispatch','/private/tmp/autopod-rollout-133/dispatch.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
job={'id':'fixture','enabled':True,'nextRunAt':'2026-09-04T09:00:00Z','catchupPending':True};profile={'name':'fixture','issueWatcherEnabled':True};config={'enabled':True,'generation':4,'activation':'persistent','authorizedUntil':None,'decisionTarget':{'providerAccountId':'fixture','model':'fixed'},'budgets':{},'profileScope':None}
initial=m.subset(config);calls=[]
def api(path,method='GET',body=None):
 calls.append((method,path,body))
 if path.startswith('/maintenance/'):
  return {'active':None if method=='DELETE' else {'expiresAt':'2099-01-01T00:00:00Z'}}
 if path=='/scheduled-jobs':return [copy.deepcopy(job)]
 if path=='/profiles':return [copy.deepcopy(profile)]
 if path=='/podsitter':return {'configuration':copy.deepcopy(config)}
 if path in ['/podsitter/disable','/podsitter/enable']:
  config['enabled']=path.endswith('enable');config['generation']+=1;return copy.deepcopy(config)
 if path=='/scheduled-jobs/fixture':
  if body:job.update(body)
  return copy.deepcopy(job)
 if path=='/profiles/fixture':
  if body:profile.update(body)
  return copy.deepcopy(profile)
 raise AssertionError('unexpected mutation path')
m.api=api
with tempfile.TemporaryDirectory() as d,contextlib.redirect_stdout(io.StringIO()):
 m.STATE=pathlib.Path(d)/'state.json';m.main('inspect');m.main('pause')
 assert not job['enabled'] and not profile['issueWatcherEnabled'] and not config['enabled'];assert job['catchupPending'];assert m.subset(config)==initial
 m.main('restore');assert job['enabled'] and profile['issueWatcherEnabled'] and config['enabled'];assert m.subset(config)==initial;assert json.loads(m.STATE.read_text())['operations']==[]
assert all('trigger' not in c[1] and 'catchup' not in c[1] for c in calls)
print('Dispatch pause/restore preserves overdue catchup, provider binding, authorization and existing enabled settings; no work trigger.')
