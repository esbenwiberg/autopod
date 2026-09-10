import importlib.util,json,pathlib,datetime
s=importlib.util.spec_from_file_location('d','/private/tmp/autopod-rollout-136/dispatch-retry.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
p=m.api('/pods/pregnant-hyena');assert p['status']=='paused' and p['containerId']=='3cef3850-b1df-47db-b572-5ca793283344'
assert p['taskSummary']['actualSummary']=='AUTOPOD_GOAL_133_MCP_SMOKE_20260910'
v=m.api('/pods/pregnant-hyena/kill','POST',{});p=m.api('/pods/pregnant-hyena');out={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'status':p['status'],'containerId':p['containerId'],'summaryPreserved':p['taskSummary']['actualSummary']=='AUTOPOD_GOAL_133_MCP_SMOKE_20260910','scope':'End only the budget-paused successful MCP smoke and request normal cleanup; retain summary, events and actual token accounting.'}
pathlib.Path('/private/tmp/autopod-rollout-136/canary-stop.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out))
