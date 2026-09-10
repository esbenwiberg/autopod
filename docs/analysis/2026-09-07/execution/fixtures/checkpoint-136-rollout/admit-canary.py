import importlib.util,json,pathlib,datetime
spec=importlib.util.spec_from_file_location('dispatch','/private/tmp/autopod-rollout-136/dispatch-retry.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
s=json.loads(m.STATE.read_text());assert len(s['operations'])==4 and 'drain' in s['operations']
assert m.api('/health')['release']['commitSha']=='425ff91cd5e6347b32d21b69804ea4c02008bc8e'
p=m.api('/maintenance/hosted-deploy-drain','DELETE');assert p['active'] is None
s['operations'].remove('drain');m.save(s)
out={'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'status':'canary_admitted','drainInactive':True,'automaticDispatchSourcesRemainPaused':3}
pathlib.Path('/private/tmp/autopod-rollout-136/canary-admission.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out))
