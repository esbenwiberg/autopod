import importlib.util,json,pathlib,urllib.request,datetime
s=importlib.util.spec_from_file_location('d','/private/tmp/autopod-rollout-134/dispatch.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
m.api('/health');out={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'checks':[]}
for method,params in [('initialize',{'protocolVersion':'2025-03-26','capabilities':{},'clientInfo':{'name':'goal-134-read-only-probe','version':'1'}}),('tools/list',{})]:
 req=urllib.request.Request(m.ORIGIN+'/mcp/middle-tahr',data=json.dumps({'jsonrpc':'2.0','id':1,'method':method,'params':params}).encode(),headers={'Authorization':'Bearer '+m._token,'Content-Type':'application/json','Accept':'application/json, text/event-stream'})
 with urllib.request.build_opener(m.NoRedirect()).open(req,timeout=10) as r:
  raw=r.read(262145);assert len(raw)<=262144;out['checks'].append({'method':method,'status':r.status,'bodyLength':len(raw),'summaryToolListed':b'report_task_summary' in raw,'rpcError':b'"error":' in raw})
pathlib.Path('/private/tmp/autopod-rollout-134/mcp-public-read.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out))
