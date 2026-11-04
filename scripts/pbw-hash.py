#!/usr/bin/env python3
"""Print a hash of a Pebble .pbw that ignores only its build time.

Builds of the same sources differ only in pebble-app.bin's build time (offset
0x7C, 4 bytes) and manifest.json's generatedAt and per-part timestamp and crc,
so two builds hash equal when nothing else changed. Usage:

    python3 scripts/pbw-hash.py build/luped-cgm.pbw
"""
import hashlib
import json
import sys
import zipfile


def pbw_hash(path):
    archive = zipfile.ZipFile(path)
    total = hashlib.sha256()
    for name in sorted(archive.namelist()):
        data = archive.read(name)
        if name.endswith("pebble-app.bin"):
            data = data[:0x7C] + b"\0\0\0\0" + data[0x80:]
        elif name.endswith("manifest.json"):
            manifest = json.loads(data)
            manifest.pop("generatedAt", None)
            for part in manifest.get("application", {}), manifest.get("resources", {}):
                for key in ("timestamp", "crc"):
                    part.pop(key, None)
            data = json.dumps(manifest, sort_keys=True).encode()
        total.update(name.encode() + b" " + hashlib.sha256(data).hexdigest().encode() + b"\n")
    return total.hexdigest()


if __name__ == "__main__":
    for path in sys.argv[1:]:
        print(pbw_hash(path), path)
