"""Copies a SQLite database consistently while its owner keeps writing to it.

Used for the 3x-ui panel database, both to cache it for the next run and to
send it to Telegram. Run as root on the runner: the panel container owns the
file and its -wal/-shm companions.

    python3 db_snapshot.py <source.db> <destination.db>
"""
import os
import sqlite3
import sys


def snapshot(source: str, destination: str) -> None:
    if not os.path.isfile(source):
        raise FileNotFoundError(f"ERR_DB_SNAPSHOT_NO_SOURCE: {source} does not exist.")
    if os.path.exists(destination):
        os.remove(destination)
    src = sqlite3.connect(source)
    dst = sqlite3.connect(destination)
    try:
        with dst:
            src.backup(dst)
    finally:
        dst.close()
        src.close()


def main(argv: list) -> int:
    if len(argv) != 3:
        print("usage: db_snapshot.py <source.db> <destination.db>", file=sys.stderr)
        return 2
    try:
        snapshot(argv[1], argv[2])
    except (OSError, sqlite3.Error) as error:
        print(f"ERR_DB_SNAPSHOT_FAILED: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
