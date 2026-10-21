import os
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

from db_snapshot import main, snapshot  # noqa: E402


class SnapshotTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.live = os.path.join(self.tmp.name, "live.db")
        self.copy = os.path.join(self.tmp.name, "copy.db")

    def test_copies_committed_rows_while_a_write_is_open(self):
        writer = sqlite3.connect(self.live)
        self.addCleanup(writer.close)
        writer.execute("pragma journal_mode=wal")
        writer.execute("create table clients(id text)")
        writer.executemany("insert into clients values (?)", [(str(i),) for i in range(100)])
        writer.commit()
        writer.execute("insert into clients values ('uncommitted')")

        snapshot(self.live, self.copy)

        copy = sqlite3.connect(self.copy)
        self.addCleanup(copy.close)
        self.assertEqual(copy.execute("select count(*) from clients").fetchone()[0], 100)
        self.assertEqual(copy.execute("pragma integrity_check").fetchone()[0], "ok")

    def test_overwrites_an_existing_destination(self):
        sqlite3.connect(self.live).close()
        with open(self.copy, "w", encoding="utf-8") as file:
            file.write("not a database")
        snapshot(self.live, self.copy)
        copy = sqlite3.connect(self.copy)
        self.addCleanup(copy.close)
        self.assertEqual(copy.execute("pragma integrity_check").fetchone()[0], "ok")

    def test_missing_source_is_an_error(self):
        self.assertEqual(main(["db_snapshot.py", self.live, self.copy]), 1)
        self.assertEqual(main(["db_snapshot.py"]), 2)


if __name__ == "__main__":
    unittest.main()
