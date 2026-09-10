import datetime,hashlib,importlib.util,json,os,pathlib,re,sys,urllib.error
spec=importlib.util.spec_from_file_location('dispatch','/private/tmp/autopod-rollout-134/dispatch.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
ROOT=pathlib.Path('/private/tmp/autopod-rollout-134');STATE=ROOT/'canary-state.json';MARKER='AUTOPOD_GOAL_133_MCP_SMOKE_20260910'
def main(mode):
 if mode=='create':
  assert not STATE.exists(),'single creation already attempted'
  profile=m.api('/profiles/dataverse-harness/editor')['resolved'];expected={'defaultRuntime':'codex','defaultModel':'gpt-5.6-sol','providerAccountId':'openai-private','executionTarget':'sandbox'}
  assert all(profile[k]==v for k,v in expected.items()),'canary binding changed'
  health=m.api('/health')['release'];assert health['commitSha']=='089442b63e5827894da40c91c764b47ff4562073' and health['dirty'] is False
  body={'profileName':'dataverse-harness','runtime':'codex','model':'gpt-5.6-sol','executionTarget':'sandbox','tokenBudget':32000,'options':{'agentMode':'auto','output':'none','validate':False,'promotable':False},'task':f'Authorized operational MCP smoke test only. Do not implement changes, edit repository files, install packages, create a PR, contact external services, run validation, or ask another model. Use the available Autopod report_task_summary MCP tool once, with actualSummary exactly "{MARKER}", how "Operational smoke only; no repository changes or delivery.", and deviations []. Then return exactly "{MARKER}" and finish. If the MCP tool is unavailable, report that failure plainly and stop.'}
  body['linkedPodId']='useful-dormouse'
  body['intentionalRerun']={'ofPodId':'useful-dormouse','requestKey':'goal-134-mcp-after-receiver-fix','reason':'Executing continuing user canary authorization after deploying the reproduced receiver rejection fix 089442b6. The first attempt remains failed and its exact sandbox deletion is verified. Repeat only the same MCP smoke task and retain linked task accounting.'}
  state={'candidate':health['commitSha'],'intentAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'binding':expected,'tokenBudget':32000,'elapsedCapSeconds':600,'estimatedSpend':'One existing-profile sandbox and a small subscription-bound Codex turn; exact provider and infrastructure billing unavailable. Token budget is admission accounting, not a hard dollar cap.','payloadSHA256':hashlib.sha256(json.dumps(body,sort_keys=True).encode()).hexdigest(),'marker':MARKER,'status':'create_intent'}
  STATE.write_text(json.dumps(state,indent=2)+'\n');os.chmod(STATE,0o600)
  result=m.api('/pods','POST',body);assert isinstance(result,dict) and re.fullmatch('[A-Za-z0-9_-]{1,80}',result['id']);state['id']=result['id'];state['status']=result['status'];STATE.write_text(json.dumps(state,indent=2)+'\n');print(json.dumps({'id':result['id'],'status':result['status'],'tokenBudget':32000,'elapsedCapSeconds':600}))
 elif mode=='observe':
  s=json.loads(STATE.read_text());p=m.api('/pods/'+s['id']);v=m.api('/pods/'+s['id']+'/task-execution');pro=m.api('/pods/'+s['id']+'/execution-provenance?schemaVersion=2')
  summary=p.get('taskSummary') or {};actual=summary.get('actualSummary') if isinstance(summary,dict) else None
  out={'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'id':s['id'],'status':p['status'],'error':p.get('failureReason'),'summaryMarkerPresent':actual==MARKER,'summaryKeys':list(summary) if isinstance(summary,dict) else [],'taskAccounting':{k:v.get(k) for k in ['agentRunCount','providerAttemptCount','recordedInputTokens','recordedOutputTokens','recordedCostUsd','delivery','telemetry']},'provenance':pro,'containerId':p.get('containerId')}
  (ROOT/'canary-observation.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out))
 else:raise ValueError('mode')
if __name__=='__main__':
 try:main(sys.argv[1])
 except urllib.error.HTTPError as e:print(json.dumps({'status':'http_error','httpStatus':e.code}));raise SystemExit(1)
 except Exception as e:print(json.dumps({'status':'incomplete','errorClass':type(e).__name__}));raise SystemExit(1)
