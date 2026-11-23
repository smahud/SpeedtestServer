#!/usr/bin/env python3
"""Summarize upload framing and TCP progress from bounded tcpdump PCAPs.

Uses original IP packet lengths even when snaplen truncates form payloads.
Does not retain or print form values. TCP ranges include retransmission dedup.
Supports Ethernet and Linux cooked v1/v2, IPv4 (not fragmented IP).
"""
import argparse
import datetime
import json
import re
import struct

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('pcap')
args = p.parse_args()
flows = {}
pending = {}
with open(args.pcap, 'rb') as f:
    header = f.read(24)
    endian = '<' if header[:4] in (b'\xd4\xc3\xb2\xa1', b'\x4d\x3c\xb2\xa1') else '>'
    link = struct.unpack(endian + 'I', header[20:24])[0]
    offset = {1:14, 113:16, 276:20}.get(link)
    if offset is None:
        raise SystemExit(f'Unsupported link type {link}')
    while record := f.read(16):
        sec, usec, captured, original = struct.unpack(endian + 'IIII', record)
        packet = f.read(captured)
        if len(packet) != captured:
            raise SystemExit('Truncated PCAP record: take a complete snapshot before analysis')
        ip = packet[offset:]
        if len(ip) < 40 or ip[0] >> 4 != 4 or ip[9] != 6:
            continue
        ihl = (ip[0] & 15) * 4
        tcp = ip[ihl:]
        if len(tcp) < 20:
            continue
        src = '.'.join(map(str, ip[12:16])); dst = '.'.join(map(str, ip[16:20]))
        sport, dport, seq, ack = struct.unpack('!HHII', tcp[:12])
        thl = (tcp[12] >> 4) * 4
        length = struct.unpack('!H', ip[2:4])[0] - ihl - thl
        payload = tcp[thl:]
        stamp = sec + usec / 1e6
        key = (src, sport, dst, dport)
        if length > 0 and key not in flows:
            pending.setdefault(key, []).append((seq, length, stamp))
        if payload.startswith(b'POST ') and key not in flows:
            text = payload.split(b'\r\n\r\n')[0].decode('latin1')
            cl = re.search(r'(?im)^Content-Length:\s*(\d+)', text)
            complete = b'\r\n\r\n' in payload
            flows[key] = {'client': f'{src}:{sport}', 'server': f'{dst}:{dport}',
                          'started_utc': datetime.datetime.fromtimestamp(stamp, datetime.timezone.utc).isoformat(),
                          'request_line': text.splitlines()[0], 'content_length': int(cl[1]) if cl else None,
                          'header_complete_in_first_packet': complete, 'headers': text.splitlines()[1:],
                          '_start': stamp, '_seq':seq, '_header':payload.index(b'\r\n\r\n') + 4 if complete else None,
                          '_ranges': [], 'responses': [], 'client_close_seconds': None}
            for oldseq, oldlength, oldstamp in pending.pop(key, []):
                off = (oldseq - seq) % (2**32)
                flows[key]['_ranges'].append((off, off + oldlength))
        flow = flows.get(key)
        if flow:
            off = (seq - flow['_seq']) % (2**32)
            if length > 0:
                flow['_ranges'].append((off, off + length))
                flow['last_payload_seconds'] = round(stamp - flow['_start'], 6)
            if tcp[13] & 5:
                flow['client_close_seconds'] = round(stamp - flow['_start'], 6)
        reverse = flows.get((dst, dport, src, sport))
        if reverse and tcp[13] & 16 and reverse['_header'] is not None:
            acknowledged = (ack - reverse['_seq']) % (2**32) - reverse['_header']
            if 0 <= acknowledged < 2**31:
                reverse['server_acknowledged_body_bytes'] = max(reverse.get('server_acknowledged_body_bytes', 0), acknowledged)
        if reverse and payload.startswith(b'HTTP/'):
            reverse['responses'].append({'seconds': round(stamp - reverse['_start'],6),
                                         'status':payload.split(b'\r\n')[0].decode('latin1')})

output = []
for flow in flows.values():
    ranges = sorted(flow['_ranges'])
    end = 0
    for start, finish in ranges:
        if start > end:
            break
        end = max(end, finish)
    flow['contiguous_body_bytes'] = max(0, end - flow['_header']) if flow['_header'] is not None else None
    flow['body_complete'] = (flow['contiguous_body_bytes'] == flow['content_length']) if flow['content_length'] is not None else None
    output.append({k:v for k,v in flow.items() if not k.startswith('_')})
print(json.dumps(output, indent=2))
