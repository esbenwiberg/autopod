#!/bin/sh
# DO NOT RUN without approval of this exact source/upload/isolated-upgrade packet.
set -eu
resource_id=/subscriptions/06bb959b-9458-41a6-bdf5-77cc12feaab9/resourceGroups/ewi-sandboxes/providers/Microsoft.Compute/virtualMachines/autopod-daemon
observed_vm_id=$(az vm show --ids "$resource_id" --query vmId --output tsv --only-show-errors)
[ "$observed_vm_id" = '3addc9bc-4812-4892-98d6-c40d5ab893c0' ] || exit 1
az vm run-command invoke --ids "$resource_id" --command-id RunShellScript --scripts @/private/tmp/autopod-upgrade-transport-123/hosted-upgrade.sh --only-show-errors --output json
