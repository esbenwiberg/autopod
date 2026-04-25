# Autopod Secrets Key — Backup & Rotation Runbook

The secrets key (`~/.autopod/secrets.key`) is a 32-byte random AES-256-GCM key that protects all stored credentials. **If this file is lost and no backup exists, every stored credential is permanently unrecoverable.** There is no key-escrow mechanism.

---

## What the key protects

The following SQLite columns in the `profiles` table are encrypted with AES-256-GCM using this key:

| Column | Contains |
|---|---|
| `provider_credentials` | Anthropic/MAX/Foundry API keys |
| `ado_pat` | Azure DevOps Personal Access Token |
| `github_pat` | GitHub Personal Access Token |
| `registry_pat` | Private container registry PAT |

Each ciphertext is stored as `hex(iv):hex(authTag):hex(ciphertext)`. The GCM auth tag covers both the IV and ciphertext, so tampering is detected on decryption.

---

## Backup procedure

### Offline encrypted backup (recommended)

Perform after initial setup and after every key rotation.

```bash
# 1. Export the key as a GPG-encrypted file.
#    Use a key that is stored separately from the autopod host (e.g. a team YubiKey or offline key).
gpg --encrypt --recipient your-key-id \
    --output ~/backups/autopod-secrets-key-$(date +%Y%m%d).gpg \
    ~/.autopod/secrets.key

# 2. Verify the backup round-trips correctly.
gpg --decrypt ~/backups/autopod-secrets-key-$(date +%Y%m%d).gpg | \
    diff - ~/.autopod/secrets.key && echo "OK"

# 3. Move the backup off the autopod host (e.g. to a USB drive, a separate Azure Key Vault secret,
#    or a secrets manager that is NOT accessible from the autopod runtime environment).
```

### Storing in Azure Key Vault (alternative)

```bash
# Store the raw key bytes as a base64 secret.
az keyvault secret set \
    --vault-name <your-vault> \
    --name autopod-secrets-key \
    --value "$(base64 < ~/.autopod/secrets.key)"

# Restrict access: only the person performing a rotation should be able to read this secret.
# The autopod daemon itself must NOT have Key Vault read access at runtime —
# that would undermine the separation of the key from the encrypted data.
```

### Restoring from backup

```bash
# GPG backup:
gpg --decrypt autopod-secrets-key-YYYYMMDD.gpg > ~/.autopod/secrets.key
chmod 600 ~/.autopod/secrets.key
chown autopod:autopod ~/.autopod/secrets.key

# Azure Key Vault backup:
az keyvault secret show --vault-name <vault> --name autopod-secrets-key \
    --query value -o tsv | base64 -d > ~/.autopod/secrets.key
chmod 600 ~/.autopod/secrets.key
chown autopod:autopod ~/.autopod/secrets.key
```

---

## Key rotation procedure

Rotate the key when:
- A team member with access to the key leaves.
- The key file may have been exposed (wrong permissions, disk image shared, etc.).
- As a matter of policy (e.g. annually).

**This is a live-database operation. Take a full database backup first.**

### Step 1 — Back up the database

```bash
cp /data/autopod.db /data/autopod.db.pre-rotation-$(date +%Y%m%d)
# Keep this backup until you have verified the rotation succeeded.
```

### Step 2 — Generate the new key

```bash
# Write the new key to a temporary location — do NOT overwrite the live key yet.
node -e "require('crypto').randomBytes(32)" > /tmp/autopod-new-key.tmp
chmod 600 /tmp/autopod-new-key.tmp
```

### Step 3 — Re-encrypt all credentials in a single transaction

Run this script as the daemon user while the daemon is **stopped**:

```js
// rotate-key.mjs
// Usage: node rotate-key.mjs <old-key-path> <new-key-path>
import { readFileSync, writeFileSync } from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function makeKey(path) {
  const key = readFileSync(path);
  return {
    encrypt(plain) {
      const iv = randomBytes(IV_LENGTH);
      const c = createCipheriv(ALGORITHM, key, iv);
      const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
      const tag = c.getAuthTag();
      return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
    },
    decrypt(cipher) {
      const [ivHex, tagHex, dataHex] = cipher.split(':');
      const iv = Buffer.from(ivHex, 'hex');
      const tag = Buffer.from(tagHex, 'hex');
      const data = Buffer.from(dataHex, 'hex');
      const d = createDecipheriv(ALGORITHM, key, iv);
      d.setAuthTag(tag);
      return d.update(data) + d.final('utf8');
    },
  };
}

const [, , oldKeyPath, newKeyPath] = process.argv;
const oldKey = makeKey(oldKeyPath);
const newKey = makeKey(newKeyPath);

const db = new Database(process.env.DB_PATH ?? '/data/autopod.db');

const reencrypt = (val) => {
  if (!val) return val;
  try { return newKey.encrypt(oldKey.decrypt(val)); }
  catch { return val; } // already plain JSON (pre-encryption rows) — re-encrypt as-is
};

const profiles = db.prepare('SELECT id, provider_credentials, ado_pat, github_pat, registry_pat FROM profiles').all();

const update = db.prepare(
  'UPDATE profiles SET provider_credentials=?, ado_pat=?, github_pat=?, registry_pat=? WHERE id=?'
);

db.transaction(() => {
  for (const row of profiles) {
    update.run(
      reencrypt(row.provider_credentials),
      reencrypt(row.ado_pat),
      reencrypt(row.github_pat),
      reencrypt(row.registry_pat),
      row.id,
    );
    process.stdout.write(`rotated profile ${row.id}\n`);
  }
})();

db.close();
process.stdout.write('rotation complete\n');
```

```bash
# Stop the daemon first.
systemctl stop autopod  # or: docker stop autopod

# Run the rotation script.
node rotate-key.mjs ~/.autopod/secrets.key /tmp/autopod-new-key.tmp
```

### Step 4 — Swap the key file

```bash
# Only swap after the script exits successfully.
mv /tmp/autopod-new-key.tmp ~/.autopod/secrets.key
chmod 600 ~/.autopod/secrets.key
chown autopod:autopod ~/.autopod/secrets.key
```

### Step 5 — Verify and restart

```bash
# Restart the daemon — it will read the new key.
systemctl start autopod  # or: docker start autopod

# Verify the daemon starts and credentials decrypt correctly by listing profiles.
curl -H "Authorization: Bearer $TOKEN" http://localhost:3100/api/profiles
# Should return profiles without error (credentials are decrypted lazily on read).
```

### Step 6 — Back up the new key

Follow the backup procedure above using the new key file before discarding the old backup.

### Step 7 — Destroy the pre-rotation database backup

Once you have confirmed the rotated credentials are working:

```bash
rm /data/autopod.db.pre-rotation-YYYYMMDD
```

The pre-rotation backup contains data encrypted with the old key. Keep it only as long as needed to roll back.

---

## Emergency: key file lost, no backup

If the key file is gone and no backup exists:

1. **Stop the daemon** — running without the key means all credential reads will fail with a decryption error.
2. **Delete all affected profile credentials** via a direct SQLite update:
   ```sql
   UPDATE profiles SET provider_credentials=NULL, ado_pat=NULL, github_pat=NULL, registry_pat=NULL;
   ```
3. **Generate a new key** — the daemon will create `~/.autopod/secrets.key` automatically on next startup.
4. **Re-enter all credentials** through the CLI or API.

There is no other recovery path. Prevent this scenario with the offline backup procedure.

---

## Permissions quick-reference

```bash
# Fix wrong permissions (daemon will refuse to start with wider modes):
chmod 600 ~/.autopod/secrets.key
chown $(id -un):$(id -gn) ~/.autopod/secrets.key

# Verify:
stat ~/.autopod/secrets.key
# Expected output includes: Access: (0600/-rw-------)
```
