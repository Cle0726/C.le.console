"""Verify a Tauri updater signature using its configured Minisign public key."""
import base64
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def decode_base64(value: str) -> bytes:
    return base64.b64decode(value.strip(), validate=True)


def verify_file(artifact: Path, signature_file: Path, public_key: str) -> None:
    public_lines = decode_base64(public_key).decode('utf-8').splitlines()
    signature_lines = decode_base64(signature_file.read_text(encoding='utf-8')).decode('utf-8').splitlines()
    if len(public_lines) < 2 or len(signature_lines) < 4:
        raise ValueError('Invalid Minisign public key or signature format')
    public = decode_base64(public_lines[1])
    signed = decode_base64(signature_lines[1])
    global_signature = decode_base64(signature_lines[3])
    trusted_comment = signature_lines[2]
    if (len(public) != 42 or public[:2] not in (b'Ed', b'ED') or len(signed) != 74
            or signed[:2] not in (b'Ed', b'ED') or len(global_signature) != 64
            or public[2:10] != signed[2:10] or not trusted_comment.startswith('trusted comment: ')):
        raise ValueError('Invalid or mismatched Minisign key/signature')

    with tempfile.TemporaryDirectory(prefix='cle-updater-verify-') as directory:
        directory = Path(directory)
        key_file = directory / 'public.der'
        key_file.write_bytes(bytes.fromhex('302a300506032b6570032100') + public[10:42])
        if signed[:2] == b'ED':
            digest = hashlib.blake2b(digest_size=64)
            with artifact.open('rb') as source:
                for block in iter(lambda: source.read(1024 * 1024), b''):
                    digest.update(block)
            payload = directory / 'payload'
            payload.write_bytes(digest.digest())
        else:
            payload = artifact
        detached = directory / 'signature'
        detached.write_bytes(signed[10:74])
        global_payload = directory / 'global-payload'
        global_payload.write_bytes(signed[10:74] + trusted_comment[17:].encode('utf-8'))
        global_sig = directory / 'global-signature'
        global_sig.write_bytes(global_signature)

        for data_file, sig_file in ((payload, detached), (global_payload, global_sig)):
            result = subprocess.run(
                ['openssl', 'pkeyutl', '-verify', '-pubin', '-inkey', str(key_file),
                 '-keyform', 'DER', '-rawin', '-in', str(data_file), '-sigfile', str(sig_file)],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
            )
            if result.returncode != 0:
                raise ValueError(f'Updater signature verification failed for {artifact.name}')


def main() -> None:
    if len(sys.argv) != 3 or not os.environ.get('TAURI_UPDATER_PUBLIC_KEY', '').strip():
        raise SystemExit('Usage: TAURI_UPDATER_PUBLIC_KEY=<key> python verify_updater_signature.py <artifact> <signature>')
    verify_file(Path(sys.argv[1]), Path(sys.argv[2]), os.environ['TAURI_UPDATER_PUBLIC_KEY'].strip())
    print(f'Updater signature verified: {Path(sys.argv[1]).name}')


if __name__ == '__main__':
    main()
