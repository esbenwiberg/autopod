import importlib.util,json,pathlib,datetime
s=importlib.util.spec_from_file_location('d','/private/tmp/autopod-rollout-134/dispatch.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
p=m.api('/pods/middle-tahr');assert p['status']=='validated' and p['containerId']=='12b21a50-930d-4a0c-8e3a-d99f872e73b4'
v=m.api('/pods/middle-tahr/kill','POST',{});p=m.api('/pods/middle-tahr');out={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'status':p['status'],'containerId':p['containerId'],'scope':'End only the completed canary workload and request its normal cleanup; retain events and failed MCP outcome.'}
pathlib.Path('/private/tmp/autopod-rollout-134/canary-stop.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out))
