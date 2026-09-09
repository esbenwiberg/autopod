# Checkpoint 114: clear recovered native rerun errors

The [checkpoint-112 native rerun screenshot](receipts/checkpoint-112-native-rerun.png) shows a successful distinct execution receipt alongside the previous lost-response error. The dispatch card now clears that error only after `createIntentionalRerun` returns successfully. Failed requests still preserve the immutable draft and show the failure; fresh preflight and provider gates are unchanged.

The native matrix oracle now requires the prior error to be absent after the success receipt. That new UI assertion remains **unrun** because Xcode could not activate the temporary app in the latest attempt; no visual GREEN is claimed. The existing screenshot is the observed defect evidence, not a fabricated automated RED. The actual Swift package passes 356 tests in eight suites after this one-line change. [Receipt](receipts/checkpoint-114-swift-tests.txt). A clean full pipeline follows on the committed candidate.

The five checkpoint-113 mobile flows remain unchanged. The temporary browser tab was closed; four exact task-owned fixture servers were stopped and their exits observed, and the native matrix child listener is gone. Native interaction needs an available foreground desktop before another attempt. The user was asked whether the Mac is unlocked; no answer is inferred from elapsed time.

Current native scan/decision/reconciliation/history/readiness acceptance, historical broad-API causal evidence, current loaded-release provenance and actual-image sandbox capability remain open. No cloud role change, canary, source publication or deployment is authorized by this checkpoint. The goal remains incomplete.
