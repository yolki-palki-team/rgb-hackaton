import json
import stat
import tempfile
import unittest
from pathlib import Path

from credentials import PREFIX, load_tokens, provision


class CredentialTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.state = Path(self.temporary.name) / "private"

    def test_repeat_and_add_preserve_every_existing_token(self):
        original = provision(self.state, ["participant-1", "participant-2"])
        self.assertEqual(original, provision(self.state, ["participant-1"]))
        updated = provision(self.state, ["participant-3", "participant-3"])
        self.assertEqual(len(updated), 3)
        self.assertTrue(original.items() <= updated.items())
        self.assertEqual(load_tokens(self.state / "market.env"), updated)
        self.assertEqual(stat.S_IMODE((self.state / "market.env").stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.state.stat().st_mode), 0o700)

    def test_rejects_empty_and_invalid_id_before_creating_state(self):
        for owners in ([], ["ok", "bad\nID"], ["space here"], ["x" * 201]):
            with self.assertRaises(ValueError):
                provision(self.state, owners)
        self.assertFalse(self.state.exists())

    def test_damaged_credentials_are_never_regenerated(self):
        provision(self.state, ["participant-1"])
        path = self.state / "market.env"
        path.write_text(PREFIX + "{broken")
        with self.assertRaises(ValueError):
            provision(self.state, ["participant-2"])
        self.assertEqual(path.read_text(), PREFIX + "{broken")

    def test_accepts_previous_manual_deployment_format(self):
        provision(self.state, ["operator"])
        path = self.state / "market.env"
        previous = {"a" * 64: "custom-owner"}
        path.write_text(PREFIX + json.dumps(previous) + "\n")
        updated = provision(self.state, ["another-owner"])
        self.assertTrue(previous.items() <= updated.items())

    def test_refuses_publicly_readable_or_symlink_credentials(self):
        provision(self.state, ["participant-1"])
        path = self.state / "market.env"
        path.chmod(0o644)
        with self.assertRaises(ValueError):
            load_tokens(path)
        path.chmod(0o600)
        link = self.state / "link.env"
        link.symlink_to(path)
        with self.assertRaises(ValueError):
            load_tokens(link)


class DependencyTests(unittest.TestCase):
    def test_deployment_versions_match_application(self):
        root = Path(__file__).resolve().parent.parent
        application = json.loads((root / "package.json").read_text())
        deployment = json.loads((root / "deploy/package.json").read_text())
        versions = application["dependencies"] | application["devDependencies"]
        for group in ("dependencies", "devDependencies"):
            for package, version in deployment[group].items():
                self.assertEqual(version, versions[package], package)


if __name__ == "__main__":
    unittest.main()
