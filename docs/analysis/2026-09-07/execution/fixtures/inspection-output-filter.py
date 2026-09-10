import copy
import hashlib
import json


def reduce_output(record):
    result = copy.deepcopy(record)
    result['transport'] = {'byteLimit': 3500, 'omittedMigrationFiles': 0,
                           'omittedBackupFiles': 0, 'omittedErrors': 0}
    migrations = result.get('migrationFiles', [])
    if migrations:
        result['migrationManifestSha256'] = hashlib.sha256(
            json.dumps(migrations, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        result['migrationFileCount'] = len(migrations)
    def encode():
        return json.dumps(result, separators=(',', ':'), allow_nan=False)
    while len(encode().encode()) > 3500:
        if migrations:
            migrations.pop(0)
            result['transport']['omittedMigrationFiles'] += 1
            continue
        inventories = result.get('backupInventory', [])
        largest = max(inventories, key=lambda x: len(x.get('latestFiles', [])), default={})
        if largest.get('latestFiles'):
            largest['latestFiles'].pop()
            result['transport']['omittedBackupFiles'] += 1
            continue
        errors = result.get('logEvidence', {}).get('errors', [])
        if errors:
            errors.pop(0)
            result['transport']['omittedErrors'] += 1
            continue
        return json.dumps({'payloadVersion': 2, 'status': 'transport_output_limit'})
    return encode()
