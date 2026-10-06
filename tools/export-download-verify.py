"""Independent extraction of production ZIPs with the Python standard library."""
import binascii
import hashlib
import json
import pathlib
import struct
import sys
import zipfile

manifest = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
archive = pathlib.Path(manifest["archive"])
expected = manifest["files"]
with zipfile.ZipFile(archive) as z:
    assert z.namelist() == [f["name"] for f in expected], z.namelist()
    assert z.testzip() is None
    extracted = archive.parent / (archive.stem + "-extracted")
    extracted.mkdir(exist_ok=True)
    next_local = 0
    for info, file in zip(z.infolist(), expected):
        original = pathlib.Path(file["path"]).read_bytes()
        assert info.flag_bits == 0x800, info.flag_bits
        assert info.compress_type == zipfile.ZIP_STORED
        assert info.extract_version == 20 and info.create_version == 20
        assert info.date_time == (1980, 1, 1, 0, 0, 0)
        assert info.header_offset == next_local
        assert not info.extra and not info.comment
        assert info.file_size == info.compress_size == len(original)
        assert info.CRC == binascii.crc32(original) & 0xFFFFFFFF
        assert z.read(info) == original
        saved = pathlib.Path(z.extract(info, extracted))
        assert saved.read_bytes() == original
        with archive.open("rb") as source:
            source.seek(info.header_offset)
            header = source.read(30)
            assert header[:4] == b"PK\x03\x04"
            flags, method = struct.unpack_from("<HH", header, 6)
            version, = struct.unpack_from("<H", header, 4)
            time, date = struct.unpack_from("<HH", header, 10)
            assert (version, time, date) == (20, 0, 33)
            crc, compressed, length = struct.unpack_from("<III", header, 14)
            namesize, extrasize = struct.unpack_from("<HH", header, 26)
            assert (flags, method, crc, compressed, length, extrasize) == (0x800, 0, info.CRC, len(original), len(original), 0)
            assert source.read(namesize) == info.filename.encode("utf-8")
            next_local += 30 + namesize + len(original)
    with archive.open("rb") as source:
        source.seek(-22, 2)
        end = source.read(22)
        sig, disk, central_disk, count, total, size, offset, comment = struct.unpack("<4sHHHHIIH", end)
        assert sig == b"PK\x05\x06" and disk == central_disk == comment == 0
        assert count == total == len(expected) < 65535
        assert size < 0xFFFFFFFF and offset < 0xFFFFFFFF
        assert offset == next_local == z.start_dir
        assert offset + size + 22 == archive.stat().st_size
        source.seek(offset)
        for info in z.infolist():
            header = source.read(46)
            fields = struct.unpack("<4s6H3I5H2I", header)
            sig, made, version, flags, method, time, date, crc, compressed, length, namesize, extrasize, commentsize, disk, internal, external, local = fields
            assert (sig, made, version, flags, method, time, date) == (b"PK\x01\x02", 20, 20, 0x800, 0, 0, 33)
            assert (crc, compressed, length, local) == (info.CRC, info.compress_size, info.file_size, info.header_offset)
            assert extrasize == commentsize == disk == internal == external == 0
            assert source.read(namesize) == info.filename.encode("utf-8")
        assert source.tell() == offset + size
print(json.dumps({"archive": str(archive), "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(), "files": len(expected), "extracted": str(extracted), "scope": "Python zipfile extraction, exact bytes, CRC32, UTF-8, standard ZIP32 headers"}))
