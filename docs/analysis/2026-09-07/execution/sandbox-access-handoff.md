# Sandbox access prerequisite: historical administrator handoff

**Resolved at checkpoint 126:** after the user enabled PIM, the intended disk-image GET returned 200. Do not execute this old grant/revocation proposal. No assignment was created by this task; preserve independently supplied access. The remaining request is the [exact image import/canary](exact-image-canary-packet.md). The dated CP125 evidence below is retained.

The September 10 read-only check still returns HTTP 403 for disk-image metadata on `autopod-spike-neu`. The current user is `d-ewi@contextand.com`, object ID `cef0aeed-b5d3-442e-b5d7-85e0526bd5e7`. Direct/inherited/group assignment discovery returned Contributor and Session Executor access; the effective permissions endpoint excludes `Microsoft.Authorization/*/Write` and `/Delete`. This account cannot apply or revoke the missing role assignment itself. No grant was attempted.

Microsoft documents **Container Apps SandboxGroup Data Owner** for sandbox data-plane operations at group scope ([official Bicep quickstart](https://learn.microsoft.com/en-us/azure/container-apps/sandboxes-quickstart-bicep)). The live queried definition grants sandbox read/write/delete/action data permissions. The similarly named SandboxGroup Contributor supplies control-plane actions and no data actions; it does not resolve this prerequisite. A role is a capability grant, not authorization for this agent to perform unapproved sandbox mutations.

## Exact target and impact

- Recipient: User `cef0aeed-b5d3-442e-b5d7-85e0526bd5e7` (`d-ewi@contextand.com`).
- Built-in role: `c24cf47c-5077-412d-a19c-45202126392c` (Container Apps SandboxGroup Data Owner).
- Scope: `/subscriptions/06bb959b-9458-41a6-bdf5-77cc12feaab9/resourceGroups/ewi-sandboxes/providers/Microsoft.App/sandboxGroups/autopod-spike-neu`.
- Proposed assignment ID: `/subscriptions/06bb959b-9458-41a6-bdf5-77cc12feaab9/resourceGroups/ewi-sandboxes/providers/Microsoft.App/sandboxGroups/autopod-spike-neu/providers/Microsoft.Authorization/roleAssignments/5c297db9-e883-575b-9ab9-a453bc04e9c7`.
- Impact: sandbox data read/write/delete/action capability within this existing group. No subscription-wide grant, new custom role or changes to other assignments.
- Expiry: this standard assignment has no automatic expiration. Remove only this exact newly created assignment after the separately authorized acceptance work. Existing equivalent or inherited assignments must be preserved.
- Spend: this grant allocates no sandbox or model execution. Image import/storage/transfer and the actual canary remain separately scoped and approved.

## Commands for an authorized Azure administrator

These are prepared commands, not executed commands or authority to switch credentials. An administrator must review and explicitly authorize/apply the grant. First check for an existing applicable assignment; if suitable access was supplied independently, preserve it and rerun only the bounded read. Do not create a duplicate or remove another assignment.

```sh
az role assignment list \
  --assignee cef0aeed-b5d3-442e-b5d7-85e0526bd5e7 \
  --scope /subscriptions/06bb959b-9458-41a6-bdf5-77cc12feaab9/resourceGroups/ewi-sandboxes/providers/Microsoft.App/sandboxGroups/autopod-spike-neu \
  --role c24cf47c-5077-412d-a19c-45202126392c \
  --include-inherited --include-groups --fill-principal-name false \
  --query '[].{id:id,principalId:principalId,scope:scope,roleDefinitionId:roleDefinitionId}' \
  --output json
```

Only if the approved assignment is absent, create it once:

```sh
az role assignment create \
  --name 5c297db9-e883-575b-9ab9-a453bc04e9c7 \
  --assignee-object-id cef0aeed-b5d3-442e-b5d7-85e0526bd5e7 \
  --assignee-principal-type User \
  --role c24cf47c-5077-412d-a19c-45202126392c \
  --scope /subscriptions/06bb959b-9458-41a6-bdf5-77cc12feaab9/resourceGroups/ewi-sandboxes/providers/Microsoft.App/sandboxGroups/autopod-spike-neu \
  --description 'Autopod durable execution acceptance; remove this exact grant after authorized canary completion' \
  --output json
```

Record the returned assignment identity and match principal, role and scope. A timed-out or uncertain create response requires a read of that exact identity, not another create. After propagation, rerun the bounded disk-image metadata GET. Do not treat a granted role or HTTP 200 as actual-image acceptance: resolve the matching ready image, finalize its command/oracle and total-spend packet, then obtain separate canary approval.

For removal after completion, first verify that the exact assignment above was created for this request and still matches its principal/role/scope. An authorized administrator can then remove only it:

```sh
az role assignment delete --ids /subscriptions/06bb959b-9458-41a6-bdf5-77cc12feaab9/resourceGroups/ewi-sandboxes/providers/Microsoft.App/sandboxGroups/autopod-spike-neu/providers/Microsoft.Authorization/roleAssignments/5c297db9-e883-575b-9ab9-a453bc04e9c7
```

Verify that this exact ID is absent. If an equivalent assignment predated this request or an administrator used another independently managed assignment, do not delete it.

## Evidence and remaining work

[Current principal](receipts/checkpoint-125-principal.json), [assignments including groups](receipts/checkpoint-125-assignments.json), [effective permissions](receipts/checkpoint-125-permissions.json), [sandbox role definitions](receipts/checkpoint-125-sandbox-roles.json), [fresh HTTP status](receipts/checkpoint-125-readiness.json), [request identity](receipts/checkpoint-125-access-request.json).

The actual hosted snapshot upgrade and cleanup already passed at checkpoint 124; no repeat is needed for that proof. Exact loaded/rollback release identity and archived evidence from the actual historical failing history/cost requests remain separate external prerequisites. No deployment/restart/publication, role grant, sandbox allocation or paid provider call has been authorized by this handoff.
