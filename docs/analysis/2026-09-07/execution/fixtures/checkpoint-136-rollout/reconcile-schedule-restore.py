import importlib.util,json,datetime,pathlib
spec=importlib.util.spec_from_file_location('dispatch','/private/tmp/autopod-rollout-136/dispatch.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
s=json.loads(m.STATE.read_text());assert len(s['jobs'])==1;j=s['jobs'][0];p=m.api('/scheduled-jobs/'+j['id']);assert p['enabled'] is False and p['catchupPending'] is False
assert datetime.datetime.fromisoformat(p['nextRunAt'].replace('Z','+00:00'))>datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(minutes=30)
out={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'status':'preserve_newer_schedule_window','old':{'nextRunAt':j['nextRunAt'],'catchupPending':j['catchupPending']},'new':{'nextRunAt':p['nextRunAt'],'catchupPending':p['catchupPending']},'reason':'Schedule catch-up changed while maintenance was paused. Preserve the observed future window and restore only the original enabled setting; do not restore the old overdue decision.'}
pathlib.Path('/private/tmp/autopod-rollout-136/schedule-reconciliation.json').write_text(json.dumps(out,indent=2)+'\n')
j['nextRunAt']=p['nextRunAt'];j['catchupPending']=p['catchupPending'];m.save(s);m.main('restore')
