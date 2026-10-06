"""Minimal little-endian NBT reader/writer used for .mcstructure files and test worlds.

Values are represented as (tag_type, value) tuples so round-trips are lossless.
"""
import struct

TAG_END, TAG_BYTE, TAG_SHORT, TAG_INT, TAG_LONG, TAG_FLOAT, TAG_DOUBLE = 0, 1, 2, 3, 4, 5, 6
TAG_BYTE_ARRAY, TAG_STRING, TAG_LIST, TAG_COMPOUND, TAG_INT_ARRAY, TAG_LONG_ARRAY = 7, 8, 9, 10, 11, 12


class Reader:
    def __init__(self, data, pos=0):
        self.d = data
        self.p = pos

    def take(self, fmt):
        size = struct.calcsize(fmt)
        v = struct.unpack_from('<' + fmt, self.d, self.p)
        self.p += size
        return v[0]

    def string(self):
        n = self.take('H')
        s = self.d[self.p:self.p + n].decode('utf-8')
        self.p += n
        return s

    def payload(self, t):
        if t == TAG_BYTE: return self.take('b')
        if t == TAG_SHORT: return self.take('h')
        if t == TAG_INT: return self.take('i')
        if t == TAG_LONG: return self.take('q')
        if t == TAG_FLOAT: return self.take('f')
        if t == TAG_DOUBLE: return self.take('d')
        if t == TAG_BYTE_ARRAY:
            n = self.take('i'); v = list(self.d[self.p:self.p + n]); self.p += n; return v
        if t == TAG_STRING: return self.string()
        if t == TAG_LIST:
            et = self.take('b'); n = self.take('i')
            return (et, [self.payload(et) for _ in range(n)])
        if t == TAG_COMPOUND:
            out = {}
            while True:
                ct = self.take('b')
                if ct == TAG_END:
                    return out
                name = self.string()
                out[name] = (ct, self.payload(ct))
        if t == TAG_INT_ARRAY:
            n = self.take('i'); return [self.take('i') for _ in range(n)]
        if t == TAG_LONG_ARRAY:
            n = self.take('i'); return [self.take('q') for _ in range(n)]
        raise ValueError('bad tag %d' % t)

    def root(self):
        t = self.take('b')
        name = self.string()
        return name, (t, self.payload(t))


class Writer:
    def __init__(self):
        self.parts = []

    def put(self, fmt, v):
        self.parts.append(struct.pack('<' + fmt, v))

    def string(self, s):
        b = s.encode('utf-8')
        self.put('H', len(b))
        self.parts.append(b)

    def payload(self, t, v):
        if t == TAG_BYTE: self.put('b', v)
        elif t == TAG_SHORT: self.put('h', v)
        elif t == TAG_INT: self.put('i', v)
        elif t == TAG_LONG: self.put('q', v)
        elif t == TAG_FLOAT: self.put('f', v)
        elif t == TAG_DOUBLE: self.put('d', v)
        elif t == TAG_BYTE_ARRAY:
            self.put('i', len(v)); self.parts.append(bytes(x & 0xFF for x in v))
        elif t == TAG_STRING: self.string(v)
        elif t == TAG_LIST:
            et, items = v
            self.put('b', et if items else (et or TAG_END)); self.put('i', len(items))
            for it in items:
                self.payload(et, it)
        elif t == TAG_COMPOUND:
            for name, (ct, cv) in v.items():
                self.put('b', ct); self.string(name); self.payload(ct, cv)
            self.put('b', TAG_END)
        elif t == TAG_INT_ARRAY:
            self.put('i', len(v))
            for x in v: self.put('i', x)
        elif t == TAG_LONG_ARRAY:
            self.put('i', len(v))
            for x in v: self.put('q', x)
        else:
            raise ValueError('bad tag %d' % t)

    def root(self, name, tv):
        t, v = tv
        self.put('b', t); self.string(name); self.payload(t, v)
        return b''.join(self.parts)


def loads(data):
    return Reader(data).root()


def dumps(name, tv):
    return Writer().root(name, tv)


# Convenience constructors
def byte(v): return (TAG_BYTE, v)
def short(v): return (TAG_SHORT, v)
def int_(v): return (TAG_INT, v)
def long(v): return (TAG_LONG, v)
def float_(v): return (TAG_FLOAT, v)
def string(v): return (TAG_STRING, v)
def compound(d): return (TAG_COMPOUND, d)
def list_(et, items): return (TAG_LIST, (et, items))


def read_level_dat(path):
    data = open(path, 'rb').read()
    version, length = struct.unpack_from('<ii', data, 0)
    name, root = loads(data[8:8 + length])
    return version, name, root


def write_level_dat(path, version, name, root):
    body = dumps(name, root)
    open(path, 'wb').write(struct.pack('<ii', version, len(body)) + body)
