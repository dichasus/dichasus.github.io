#!/usr/bin/env python3
"""Plan or download selected DICHASUS recordings into ~/Downloads.

CSI files are included with --include-csi. Add --download to fetch the selection.
"""

import argparse
import hashlib
import json
import os
import re
import urllib.parse
import urllib.request
from pathlib import Path

API = "https://darus.uni-stuttgart.de/api"
DOI = "doi:10.18419/darus-4062"


def select_files(version, routes, include_csi=False, include_offsets=True):
    wanted = {"spec.json"}
    for route in routes:
        if include_offsets:
            wanted.add(f"reftx-offsets-dichasus-{route}.json")
        if include_csi:
            wanted.add(f"dichasus-{route}.tfrecords")
    files = [
        entry["dataFile"]
        for entry in version["files"]
        if entry["dataFile"]["filename"] in wanted
    ]
    missing = wanted - {file["filename"] for file in files}
    if missing:
        raise ValueError(
            f'Dataset version does not contain: {", ".join(sorted(missing))}'
        )
    return sorted(files, key=lambda file: file["filename"])


def file_digest(path, algorithm):
    digest = hashlib.new(algorithm.lower().replace("-", ""))
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def download_file(file, destination, opener=urllib.request.urlopen):
    name = file["filename"]
    if Path(name).name != name:
        raise ValueError("Unsafe dataset filename")
    target = destination / name
    checksum = file.get("checksum", {})
    algorithm = checksum.get("type", "MD5")
    expected_digest = checksum.get("value", file.get("md5"))
    if not expected_digest:
        raise ValueError(f"{name}: dataset metadata has no checksum")
    expected_size = file["filesize"]
    if target.exists():
        if (
            target.stat().st_size == expected_size
            and file_digest(target, algorithm).lower() == expected_digest.lower()
        ):
            print(f"Already verified: {name}", flush=True)
            return target
        raise FileExistsError(
            f"{target} exists but does not match this dataset version; move it aside before downloading"
        )
    temporary = target.with_suffix(target.suffix + ".part")
    received = temporary.stat().st_size if temporary.exists() else 0
    if received > expected_size:
        raise ValueError(f"{temporary}: partial file exceeds expected size")
    digest = hashlib.new(algorithm.lower().replace("-", ""))
    if received:
        with temporary.open("rb") as previous:
            while block := previous.read(1024 * 1024):
                digest.update(block)
        if received == expected_size:
            if digest.hexdigest().lower() != expected_digest.lower():
                raise ValueError(f"{name}: checksum mismatch in existing partial file")
            os.replace(temporary, target)
            print(f"Verified completed partial file: {name}", flush=True)
            return target
        print(f"Resuming {name} at {received:,} bytes", flush=True)
    next_progress = (received // (256 * 1024 * 1024) + 1) * 256 * 1024 * 1024
    url = f"{API}/access/datafile/{file['id']}"
    request = (
        urllib.request.Request(url, headers={"Range": f"bytes={received}-"})
        if received
        else url
    )
    with opener(request, timeout=60) as response:
        if received:
            expected_range = f"bytes {received}-{expected_size - 1}/{expected_size}"
            if (
                getattr(response, "status", None) != 206
                or response.headers.get("Content-Range") != expected_range
            ):
                raise ValueError(
                    f"{name}: server did not honor resume range; partial file preserved"
                )
        with temporary.open("ab" if temporary.exists() else "xb") as stream:
            while True:
                block = response.read(1024 * 1024)
                if not block:
                    break
                stream.write(block)
                digest.update(block)
                received += len(block)
                if received >= next_progress:
                    print(
                        f"{name}: {received / 1024**3:.2f}/{expected_size / 1024**3:.2f} GiB",
                        flush=True,
                    )
                    next_progress += 256 * 1024 * 1024
    if received != expected_size:
        raise ValueError(f"{name}: expected {expected_size} bytes, received {received}")
    if digest.hexdigest().lower() != expected_digest.lower():
        raise ValueError(f"{name}: checksum mismatch")
    os.replace(temporary, target)
    print(f"Verified: {name}", flush=True)
    return target


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", choices=["adxx", "dcxx"], default="adxx")
    parser.add_argument("--routes", nargs="+")
    parser.add_argument("--version")
    parser.add_argument(
        "--destination", type=Path
    )
    parser.add_argument("--include-csi", action="store_true")
    parser.add_argument("--download", action="store_true")
    args = parser.parse_args()
    args.version = args.version or ("3.0" if args.dataset == "adxx" else "1.0")
    args.routes = args.routes or (["ad10", "ad11"] if args.dataset == "adxx" else ["dc01", "dc10", "dc20"])
    args.destination = args.destination or Path.home() / f"Downloads/dichasus-{args.dataset}"
    doi = DOI if args.dataset == "adxx" else "doi:10.18419/darus-3831"
    if not re.fullmatch(r"\d+\.\d+", args.version):
        parser.error("version must have the form 3.0")
    url = f'{API}/datasets/:persistentId/versions/{args.version}?{urllib.parse.urlencode({"persistentId": doi})}'
    with urllib.request.urlopen(url, timeout=30) as response:
        version = json.load(response)["data"]
    available = {entry["dataFile"]["filename"] for entry in version["files"]}
    if any(f"dichasus-{route}.tfrecords" not in available for route in args.routes):
        parser.error("A selected recording is not available in this dataset version")
    files = select_files(version, args.routes, args.include_csi, include_offsets=args.dataset == "adxx")
    total = sum(file["filesize"] for file in files)
    print(f"DICHASUS {args.dataset} version {args.version} → {args.destination.expanduser()}")
    for file in files:
        print(f"  {file['filename']}: {file['filesize'] / 1024**2:,.2f} MiB")
    print(f"Total selected: {total / 1024**3:.3f} GiB")
    if not args.download:
        print("Plan only. Add --download to retrieve and verify these files.")
        return
    destination = args.destination.expanduser()
    destination.mkdir(parents=True, exist_ok=True)
    for file in files:
        download_file(file, destination)
    manifest = {"doi": doi, "version": args.version, "files": files}
    content = json.dumps(manifest, indent=2) + "\n"
    (
        destination / f'download-manifest-{args.version}-{"-".join(args.routes)}.json'
    ).write_text(content)
    (destination / "download-manifest.json").write_text(content)


if __name__ == "__main__":
    main()
