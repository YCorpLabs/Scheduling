# Encryption-key backup

`TOKEN_ENCRYPTION_KEY` encrypts stored calendar grants, guest-link recovery
copies and queued emails. Cloudflare cannot show a secret back to you, so keep
your own recoverable copy before the first deployment.

## Where to keep it

Choose one recovery path that survives the loss of your computer and of the
Cloudflare account:

- **A password manager vault** with a named owner and recovery custodians.
- **An encrypted file** in off-device storage, encrypted to a recipient whose
  fingerprint you verified through an independent channel and whose private
  key is itself recoverable separately.

Do not reuse an administrator SSH key, encrypt to an unfamiliar recipient or
upload the key to an arbitrary location.

## Making the backup

1. Generate the key into a private file and put the Worker secret from that
   same file, so the backup and the deployed value are the same bytes:

   ```sh
   umask 077
   openssl rand -base64 32 > KEY_FILE
   npx wrangler secret put TOKEN_ENCRYPTION_KEY --config wrangler.instance.generated.json < KEY_FILE
   ```

2. Save the value in your vault, or encrypt the file to your verified
   recipient, for example with
   [GnuPG](https://www.gnupg.org/documentation/manuals/gnupg/GPG-Commands.html):

   ```sh
   gpg --encrypt --recipient RECIPIENT_FINGERPRINT --output ENCRYPTED_BACKUP_FILE KEY_FILE
   ```

   Store only the encrypted file off-device.
3. Test the restore: retrieve the copy through the recovery path, decrypt it to
   a private temporary file and compare it with the original in a local step
   that prints only pass or fail. Then delete the temporary copy, and the
   plaintext `KEY_FILE` once the backup is confirmed.
4. Record the date and the recovery role that performed the test. Never record
   the key, its fingerprint or the backup location in a public place.

Never print the key or pass it as a command argument, and keep it out of shell
history, logs, clipboard tools and build variables.

## Recovery constraints

`TOKEN_ENCRYPTION_KEY` protects calendar refresh tokens, guest-link recovery
copies and frozen email payloads. Existing envelopes use the `v1` format and
bind authenticated encryption to the host. An incorrect key does not decrypt
existing data. [Cloudflare secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
cannot be read back through normal secret-management tooling after definition.

Key rotation and versioned re-encryption are not implemented. Keep a key
recoverable for as long as any retained data or backup requires it; do not
replace or discard it merely because a newer deployment exists. Restoring a
working key and rotating to a new key are different procedures. If a key is
lost, follow "Secrets and key recovery" in [operations](booking-operations.md).
