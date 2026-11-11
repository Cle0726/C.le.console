"""Offline Minisign test vectors; no production keys or network access."""
import base64
from pathlib import Path
import tempfile
import unittest

from verify_updater_signature import verify_file


PUBLIC = '''untrusted comment: minisign public key E7620F1842B4E81F
RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3
'''
LEGACY = '''untrusted comment: signature from minisign secret key
RWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=
trusted comment: timestamp:1555779966\tfile:test
QtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==
'''
PREHASHED = '''untrusted comment: signature from minisign secret key
RUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=
trusted comment: timestamp:1556193335\tfile:test
y/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==
'''


class SignatureTests(unittest.TestCase):
    def check_signature(self, signature: str, body: bytes = b'test') -> None:
        with tempfile.TemporaryDirectory(prefix='cle-signature-test-') as directory:
            root = Path(directory)
            (root / 'artifact').write_bytes(body)
            (root / 'artifact.sig').write_bytes(base64.b64encode(signature.encode()))
            verify_file(root / 'artifact', root / 'artifact.sig', base64.b64encode(PUBLIC.encode()).decode())

    def test_legacy_and_prehash_vectors(self):
        self.check_signature(LEGACY)
        self.check_signature(PREHASHED)

    def test_tampered_payload_and_comment(self):
        with self.assertRaises(ValueError):
            self.check_signature(PREHASHED, b'Test')
        with self.assertRaises(ValueError):
            self.check_signature(PREHASHED.replace('timestamp:1556193335', 'timestamp:1556193336'))


if __name__ == '__main__':
    unittest.main()
