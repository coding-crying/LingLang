import os
import tempfile
import unittest
from pathlib import Path
from runtime import persistent_secrets

class RuntimeTests(unittest.TestCase):
    def test_secrets_persist_and_are_private(self):
        with tempfile.TemporaryDirectory() as root:
            first=persistent_secrets(Path(root),{})
            second=persistent_secrets(Path(root),{})
            self.assertEqual(first,second)
            self.assertEqual(len(set(first.values())),3)
            self.assertTrue(all(len(v)>=32 for v in first.values()))
            self.assertEqual(os.stat(Path(root)/'secrets.json').st_mode & 0o777,0o600)
    def test_existing_corrupt_secret_file_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as root:
            path=Path(root)/'secrets.json';path.write_text('{}')
            with self.assertRaises(ValueError):persistent_secrets(Path(root),{})
            self.assertEqual(path.read_text(),'{}')
