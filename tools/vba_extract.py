"""Minimal OLE2 reader + MS-OVBA decompressor to dump VBA module source."""
import struct, sys, os, re

def read_ole(path):
    data = open(path, 'rb').read()
    hdr = data[:512]
    assert hdr[:8] == bytes.fromhex('D0CF11E0A1B11AE1')
    sec_shift = struct.unpack('<H', hdr[30:32])[0]
    mini_shift = struct.unpack('<H', hdr[32:34])[0]
    ssz = 1 << sec_shift
    msz = 1 << mini_shift
    n_fat = struct.unpack('<I', hdr[44:48])[0]
    dir_start = struct.unpack('<I', hdr[48:52])[0]
    mini_cutoff = struct.unpack('<I', hdr[56:60])[0]
    minifat_start = struct.unpack('<I', hdr[60:64])[0]
    difat_start = struct.unpack('<I', hdr[68:72])[0]
    n_difat = struct.unpack('<I', hdr[72:76])[0]
    difat = list(struct.unpack('<109I', hdr[76:512]))
    def sec(i):
        off = 512 + i * ssz
        return data[off:off + ssz]
    s = difat_start
    for _ in range(n_difat):
        vals = struct.unpack('<%dI' % (ssz // 4), sec(s))
        difat += vals[:-1]; s = vals[-1]
    fat = []
    for i in difat[:n_fat]:
        fat += struct.unpack('<%dI' % (ssz // 4), sec(i))
    def chain(start):
        out = []; s = start
        while s < 0xFFFFFFFA:
            out.append(s); s = fat[s]
        return out
    def stream(start):
        return b''.join(sec(i) for i in chain(start))
    d = stream(dir_start)
    entries = []
    for i in range(len(d) // 128):
        e = d[i*128:(i+1)*128]
        nl = struct.unpack('<H', e[64:66])[0]
        name = e[:max(nl-2,0)].decode('utf-16le', 'ignore')
        typ = e[66]
        l, r, c = struct.unpack('<III', e[68:80])
        start = struct.unpack('<I', e[116:120])[0]
        size = struct.unpack('<Q', e[120:128])[0] & 0xFFFFFFFF
        entries.append(dict(name=name, type=typ, left=l, right=r, child=c, start=start, size=size))
    root = entries[0]
    ministream = stream(root['start'])
    minifat = []
    if minifat_start < 0xFFFFFFFA:
        mf = stream(minifat_start)
        minifat = list(struct.unpack('<%dI' % (len(mf)//4), mf))
    def read_entry(e):
        if e['size'] < mini_cutoff:
            out = []; s = e['start']
            while s < 0xFFFFFFFA:
                out.append(ministream[s*msz:(s+1)*msz]); s = minifat[s]
            return b''.join(out)[:e['size']]
        return stream(e['start'])[:e['size']]
    # build paths
    paths = {}
    def walk(idx, prefix):
        if idx == 0xFFFFFFFF or idx >= len(entries): return
        e = entries[idx]
        walk(e['left'], prefix); walk(e['right'], prefix)
        p = prefix + '/' + e['name']
        paths[p] = e
        if e['type'] in (1, 5): walk(e['child'], p)
    walk(root['child'], '')
    return paths, read_entry

def decompress(buf):
    assert buf[0] == 1
    out = bytearray(); i = 1
    while i < len(buf):
        hdr = struct.unpack('<H', buf[i:i+2])[0]
        size = (hdr & 0x0FFF) + 3
        compressed = hdr & 0x8000
        chunk = buf[i+2:i+size]; i += size
        if not compressed:
            out += chunk[:4096]; continue
        dstart = len(out); j = 0
        while j < len(chunk):
            flags = chunk[j]; j += 1
            for bit in range(8):
                if j >= len(chunk): break
                if not (flags >> bit) & 1:
                    out.append(chunk[j]); j += 1
                else:
                    tok = struct.unpack('<H', chunk[j:j+2])[0]; j += 2
                    dlen = len(out) - dstart
                    bc = max((dlen - 1).bit_length(), 4)
                    lmask = 0xFFFF >> bc
                    off = (tok >> (16 - bc)) + 1
                    ln = (tok & lmask) + 3
                    for _ in range(ln):
                        out.append(out[-off])
    return bytes(out)

def modules(paths, read_entry):
    dirk = [p for p in paths if p.lower().endswith('/vba/dir')][0]
    base = dirk[:-3]
    d = decompress(read_entry(paths[dirk]))
    i = 0; mods = []; cur = {}
    while i < len(d):
        rid, sz = struct.unpack('<HI', d[i:i+6]); i += 6
        if rid == 9: sz = 6  # PROJECTVERSION quirk
        val = d[i:i+sz]; i += sz
        if rid == 0x19: cur = {'name': val.decode('latin1')}
        elif rid == 0x1A: cur['stream'] = val.decode('latin1')
        elif rid == 0x31: cur['offset'] = struct.unpack('<I', val)[0]
        elif rid == 0x2B: mods.append(cur)
    for m in mods:
        key = base + m['stream']
        key = next(p for p in paths if p.lower() == key.lower())
        raw = read_entry(paths[key])
        yield m['name'], decompress(raw[m['offset']:]).decode('cp1252', 'replace')

if __name__ == '__main__':
    paths, re_ = read_ole(sys.argv[1])
    os.makedirs(sys.argv[2], exist_ok=True)
    for name, src in modules(paths, re_):
        open(os.path.join(sys.argv[2], name + '.bas'), 'w').write(src)
        print(name, len(src.splitlines()))
