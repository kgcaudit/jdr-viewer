#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
IROAD JDR extractor (reverse-engineered)

Validated against the supplied sample 00000000.jdr.
Extracts:
  - channel 0/1 H.264 Annex-B elementary streams
  - PCM audio as WAV (8 kHz, 16-bit mono)
  - GPS records as CSV
  - G-sensor records as CSV
  - text/JSON summary and SHA-256
  - optional packet index CSV
  - optional MP4 muxing when ffmpeg is installed

This is not an official IROAD format specification. JDR variants from other
models/firmware may require adjustments.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import mmap
import shutil
import struct
import subprocess
import sys
import wave
from dataclasses import dataclass, asdict
from datetime import datetime
from pathlib import Path
from typing import BinaryIO, Iterable, Optional

# JEB1 DWORD 0x4A454231 appears on disk as little-endian ASCII bytes "1BEJ".
JEB_MAGIC = b"1BEJ"
JEB_HEADER_SIZE = 0x200
PACKET_HEADER_SIZE = 28
INDEX_ENTRY_SIZE = 12


def u32(buf, off: int) -> int:
    return struct.unpack_from("<I", buf, off)[0]


def parse_systemtime(buf, off: int) -> datetime:
    """Read a Windows SYSTEMTIME (8 x uint16, 16 bytes)."""
    year, month, _dow, day, hour, minute, second, ms = struct.unpack_from("<8H", buf, off)
    return datetime(year, month, day, hour, minute, second, ms * 1000)


def ddmm_to_degrees(value: float) -> float:
    """Convert NMEA ddmm.mmmm / dddmm.mmmm to signed decimal degrees."""
    if value == 0:
        return 0.0
    sign = -1.0 if value < 0 else 1.0
    value = abs(value)
    degrees = int(value // 100)
    minutes = value - (degrees * 100)
    return sign * (degrees + minutes / 60.0)


def sha256_file(path: Path, chunk_size: int = 1024 * 1024) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while True:
            chunk = f.read(chunk_size)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


@dataclass
class Packet:
    block_no: int
    packet_no: int
    offset: int
    tag: str
    size: int
    aux: int
    timestamp: datetime
    payload_offset: int


@dataclass
class BlockInfo:
    block_no: int
    header_offset: int
    packet_count: int
    video_ch0_count: int
    video_ch1_count: int
    audio_count: int
    gps_count: int
    sensor_count: int
    index_offset: int
    start_time: str
    end_time: str
    gps_hint: str
    index_mismatches: int = 0


def find_jeb_headers(buf) -> list[int]:
    """Locate strongly validated JEB1 headers."""
    headers: list[int] = []
    pos = 0
    file_size = len(buf)

    while True:
        i = buf.find(JEB_MAGIC, pos)
        if i < 0:
            break
        pos = i + len(JEB_MAGIC)

        if i + JEB_HEADER_SIZE > file_size:
            continue

        try:
            # Header-size sentinel observed in the original viewer parser/sample.
            if u32(buf, i + 0x1FC) != JEB_HEADER_SIZE:
                continue

            count = u32(buf, i + 0x04)
            index_offset = u32(buf, i + 0xB8)

            if not (0 < count < 10_000_000):
                continue
            if not (0 <= index_offset < file_size):
                continue
            if index_offset + count * INDEX_ENTRY_SIZE > file_size:
                continue

            headers.append(i)
        except (struct.error, ValueError):
            continue

    return headers


def parse_block(buf, jeb_offset: int, block_no: int) -> tuple[list[Packet], BlockInfo]:
    count = u32(buf, jeb_offset + 0x04)
    index_offset = u32(buf, jeb_offset + 0xB8)
    pos = jeb_offset + JEB_HEADER_SIZE
    packets: list[Packet] = []

    for packet_no in range(count):
        if pos + PACKET_HEADER_SIZE > len(buf):
            raise ValueError(f"Packet header outside file at 0x{pos:X}")

        tag_bytes = bytes(buf[pos : pos + 4])
        tag = tag_bytes.decode("ascii", "replace")
        size = u32(buf, pos + 4)
        aux = u32(buf, pos + 8)
        timestamp = parse_systemtime(buf, pos + 12)
        payload_offset = pos + PACKET_HEADER_SIZE
        end = payload_offset + size

        if end > len(buf):
            raise ValueError(f"Packet payload outside file at 0x{pos:X}, size={size}")

        packets.append(
            Packet(
                block_no=block_no,
                packet_no=packet_no,
                offset=pos,
                tag=tag,
                size=size,
                aux=aux,
                timestamp=timestamp,
                payload_offset=payload_offset,
            )
        )
        pos = end

    mismatches = 0
    for n, packet in enumerate(packets):
        idx = index_offset + n * INDEX_ENTRY_SIZE
        if idx + INDEX_ENTRY_SIZE > len(buf):
            mismatches += 1
            break

        idx_tag = bytes(buf[idx : idx + 4]).decode("ascii", "replace")
        idx_size = u32(buf, idx + 4)
        idx_pos = u32(buf, idx + 8)
        if (idx_tag, idx_size, idx_pos) != (packet.tag, packet.size, packet.offset):
            mismatches += 1

    def safe_time(offset: int) -> str:
        try:
            return parse_systemtime(buf, offset).isoformat(sep=" ", timespec="milliseconds")
        except Exception:
            return ""

    gps_hint = bytes(buf[jeb_offset + 0xF8 : jeb_offset + 0x140])
    gps_hint = gps_hint.split(b"\x00", 1)[0].decode("ascii", "ignore")

    info = BlockInfo(
        block_no=block_no,
        header_offset=jeb_offset,
        packet_count=count,
        video_ch0_count=u32(buf, jeb_offset + 0x08),
        video_ch1_count=u32(buf, jeb_offset + 0x0C),
        audio_count=u32(buf, jeb_offset + 0x48),
        gps_count=u32(buf, jeb_offset + 0x88),
        sensor_count=u32(buf, jeb_offset + 0x8C),
        index_offset=index_offset,
        start_time=safe_time(jeb_offset + 0x94),
        end_time=safe_time(jeb_offset + 0xA4),
        gps_hint=gps_hint,
        index_mismatches=mismatches,
    )
    return packets, info


def is_video(packet: Packet, channel: int) -> bool:
    prefix = f"{channel:02d}"
    return len(packet.tag) >= 3 and packet.tag.startswith(prefix) and packet.tag[2] == "V"


def extract_h264(buf, packets: Iterable[Packet], channel: int, path: Path) -> int:
    written = 0
    with path.open("wb") as f:
        for p in packets:
            if is_video(p, channel):
                f.write(buf[p.payload_offset : p.payload_offset + p.size])
                written += p.size
    return written


def extract_audio_wav(buf, packets: Iterable[Packet], path: Path) -> int:
    """Merge AD packets in file/timeline order into PCM S16LE 8 kHz mono WAV."""
    frame_bytes = 0
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(8000)
        for p in packets:
            if len(p.tag) >= 4 and p.tag[2:4] == "AD":
                payload = bytes(buf[p.payload_offset : p.payload_offset + p.size])
                w.writeframesraw(payload)
                frame_bytes += len(payload)
    return frame_bytes


def extract_gps_csv(buf, packets: Iterable[Packet], path: Path) -> int:
    count = 0
    with path.open("w", newline="", encoding="utf-8-sig") as f:
        cw = csv.writer(f)
        cw.writerow(
            [
                "packet_time_local",
                "tag",
                "gps_year",
                "gps_month",
                "gps_day",
                "gps_hour",
                "gps_minute",
                "gps_second",
                "pdop",
                "hdop",
                "vdop",
                "latitude_nmea",
                "longitude_nmea",
                "latitude_deg",
                "longitude_deg",
                "altitude_m",
                "speed_kmh",
            ]
        )

        for p in packets:
            if len(p.tag) < 4 or p.tag[2:4] != "GP" or p.size < 96:
                continue

            payload = buf[p.payload_offset : p.payload_offset + p.size]
            ints = struct.unpack_from("<10i", payload, 0)
            pdop, hdop, vdop, lat, lon, alt, speed = struct.unpack_from("<7d", payload, 40)

            cw.writerow(
                [
                    p.timestamp.isoformat(sep=" ", timespec="milliseconds"),
                    p.tag,
                    ints[1],
                    ints[2],
                    ints[3],
                    ints[4],
                    ints[5],
                    ints[6],
                    pdop,
                    hdop,
                    vdop,
                    lat,
                    lon,
                    ddmm_to_degrees(lat),
                    ddmm_to_degrees(lon),
                    alt,
                    speed,
                ]
            )
            count += 1
    return count


def extract_gsensor_csv(buf, packets: Iterable[Packet], path: Path) -> int:
    count = 0
    with path.open("w", newline="", encoding="utf-8-sig") as f:
        cw = csv.writer(f)
        cw.writerow(
            [
                "packet_time_local",
                "tag",
                "aux_or_sample_index",
                "x_raw",
                "y_raw",
                "z_raw",
                "x_g_est",
                "y_g_est",
                "z_g_est",
            ]
        )

        for p in packets:
            if len(p.tag) < 4 or p.tag[2:4] != "SE" or p.size < 12:
                continue
            x, y, z = struct.unpack_from("<3i", buf, p.payload_offset)
            cw.writerow(
                [
                    p.timestamp.isoformat(sep=" ", timespec="milliseconds"),
                    p.tag,
                    p.aux,
                    x,
                    y,
                    z,
                    x / 1024.0,
                    y / 1024.0,
                    z / 1024.0,
                ]
            )
            count += 1
    return count


def write_packet_csv(packets: Iterable[Packet], path: Path) -> None:
    with path.open("w", newline="", encoding="utf-8-sig") as f:
        cw = csv.writer(f)
        cw.writerow(
            [
                "block_no",
                "packet_no",
                "offset_hex",
                "tag",
                "payload_size",
                "aux",
                "timestamp",
                "payload_offset_hex",
            ]
        )
        for p in packets:
            cw.writerow(
                [
                    p.block_no,
                    p.packet_no,
                    f"0x{p.offset:X}",
                    p.tag,
                    p.size,
                    p.aux,
                    p.timestamp.isoformat(sep=" ", timespec="milliseconds"),
                    f"0x{p.payload_offset:X}",
                ]
            )


def estimate_fps(packets: Iterable[Packet], channel: int) -> float:
    """Estimate the nominal frame rate from packet timestamps.

    The sample alternates 33/34 ms frame intervals. Using the median alone would
    incorrectly yield ~30.303 fps, so the long-span average is preferred.
    """
    timestamps = [p.timestamp.timestamp() for p in packets if is_video(p, channel)]
    if len(timestamps) < 2:
        return 30.0

    elapsed = timestamps[-1] - timestamps[0]
    if elapsed <= 0:
        return 30.0
    fps = (len(timestamps) - 1) / elapsed
    if not (5.0 <= fps <= 120.0):
        return 30.0

    # Snap close estimates to common nominal rates for cleaner FFmpeg timestamps.
    common = (23.976, 24.0, 25.0, 29.97, 30.0, 50.0, 59.94, 60.0)
    nearest = min(common, key=lambda x: abs(x - fps))
    if abs(nearest - fps) / nearest < 0.01:
        return nearest
    return fps


def find_ffmpeg(explicit: Optional[str]) -> Optional[str]:
    if explicit:
        p = Path(explicit)
        if p.is_file():
            return str(p)
        found = shutil.which(explicit)
        return found
    return shutil.which("ffmpeg")


def make_mp4(ffmpeg: str, h264: Path, wav: Path, mp4: Path, fps: float) -> tuple[bool, str]:
    """Mux H.264 + WAV into MP4. Video is stream-copied; audio becomes AAC."""
    cmd = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-fflags",
        "+genpts",
        "-r",
        f"{fps:.6f}",
        "-i",
        str(h264),
        "-i",
        str(wav),
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-shortest",
        "-movflags",
        "+faststart",
        str(mp4),
    ]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if proc.returncode == 0:
        return True, ""
    return False, proc.stderr.strip()


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Extract video/audio/GPS/G-sensor data from reverse-engineered IROAD JDR files."
    )
    ap.add_argument("jdr", type=Path, help="Input .jdr file")
    ap.add_argument("-o", "--outdir", type=Path, default=None, help="Output directory")
    ap.add_argument("--mp4", action="store_true", help="Also create MP4 files if ffmpeg is available")
    ap.add_argument("--ffmpeg", default=None, help="Path/name of ffmpeg executable")
    ap.add_argument("--packet-csv", action="store_true", help="Write all packet metadata to CSV")
    ap.add_argument(
        "--strict-index",
        action="store_true",
        help="Abort if any JDR 12-byte index entry does not match parsed packet data",
    )
    args = ap.parse_args()

    src = args.jdr.expanduser().resolve()
    if not src.is_file():
        print(f"ERROR: input file not found: {src}", file=sys.stderr)
        return 2

    outdir = (args.outdir or src.with_name(src.stem + "_extracted")).resolve()
    outdir.mkdir(parents=True, exist_ok=True)

    digest = sha256_file(src)

    with src.open("rb") as fh:
        with mmap.mmap(fh.fileno(), 0, access=mmap.ACCESS_READ) as buf:
            jebs = find_jeb_headers(buf)
            if not jebs:
                print("ERROR: no valid JEB1 block found. This JDR variant may not be supported.", file=sys.stderr)
                return 3

            all_packets: list[Packet] = []
            blocks: list[BlockInfo] = []
            for block_no, jeb in enumerate(sorted(jebs)):
                packets, info = parse_block(buf, jeb, block_no)
                all_packets.extend(packets)
                blocks.append(info)

            # File order is preferred because JEB blocks and their packet records are sequential.
            all_packets.sort(key=lambda p: (p.block_no, p.packet_no))

            mismatch_total = sum(b.index_mismatches for b in blocks)
            if args.strict_index and mismatch_total:
                print(f"ERROR: index mismatch count = {mismatch_total}", file=sys.stderr)
                return 4

            ch0 = outdir / f"{src.stem}_ch0.h264"
            ch1 = outdir / f"{src.stem}_ch1.h264"
            wav = outdir / f"{src.stem}_audio.wav"
            gps = outdir / f"{src.stem}_gps.csv"
            gsensor = outdir / f"{src.stem}_gsensor.csv"

            video0_bytes = extract_h264(buf, all_packets, 0, ch0)
            video1_bytes = extract_h264(buf, all_packets, 1, ch1)
            audio_bytes = extract_audio_wav(buf, all_packets, wav)
            gps_rows = extract_gps_csv(buf, all_packets, gps)
            sensor_rows = extract_gsensor_csv(buf, all_packets, gsensor)

            if args.packet_csv:
                write_packet_csv(all_packets, outdir / f"{src.stem}_packets.csv")

            tag_counts: dict[str, int] = {}
            for p in all_packets:
                tag_counts[p.tag] = tag_counts.get(p.tag, 0) + 1

            first_time = min((p.timestamp for p in all_packets), default=None)
            last_time = max((p.timestamp for p in all_packets), default=None)
            duration = (last_time - first_time).total_seconds() if first_time and last_time else 0.0
            fps0 = estimate_fps(all_packets, 0)
            fps1 = estimate_fps(all_packets, 1)

            summary = {
                "input_file": str(src),
                "input_size_bytes": src.stat().st_size,
                "sha256": digest,
                "jdr_format_status": "reverse-engineered; validated on supplied sample, not an official specification",
                "jeb_blocks": [asdict(b) for b in blocks],
                "valid_packets": len(all_packets),
                "index_mismatches": mismatch_total,
                "packet_tag_counts": dict(sorted(tag_counts.items())),
                "first_packet_time": first_time.isoformat(sep=" ", timespec="milliseconds") if first_time else None,
                "last_packet_time": last_time.isoformat(sep=" ", timespec="milliseconds") if last_time else None,
                "duration_seconds": duration,
                "estimated_fps": {"channel_0": fps0, "channel_1": fps1},
                "output": {
                    "ch0_h264": str(ch0),
                    "ch0_bytes": video0_bytes,
                    "ch1_h264": str(ch1),
                    "ch1_bytes": video1_bytes,
                    "audio_wav": str(wav),
                    "audio_pcm_bytes": audio_bytes,
                    "gps_csv": str(gps),
                    "gps_rows": gps_rows,
                    "gsensor_csv": str(gsensor),
                    "gsensor_rows": sensor_rows,
                },
                "format_notes": {
                    "packet_header": "28 bytes: tag[4], payload_size u32, aux u32, Windows SYSTEMTIME[16]",
                    "video": "00VI/00VP and 01VI/01VP; H.264 Annex-B in validated sample",
                    "audio": "AD payload; PCM signed 16-bit little-endian, 8000 Hz mono in validated sample",
                    "gps": "GP payload; binary struct; lat/lon interpreted as NMEA ddmm.mmmm; speed interpreted as km/h",
                    "gsensor": "SE payload; 3 x signed int32; /1024 g scaling is an estimate from the validated sample",
                },
            }

    mp4_messages: list[str] = []
    if args.mp4:
        ffmpeg = find_ffmpeg(args.ffmpeg)
        if not ffmpeg:
            mp4_messages.append("ffmpeg not found: raw H.264/WAV were extracted, but MP4 files were not created.")
        else:
            for channel, h264, fps, label in (
                (0, outdir / f"{src.stem}_ch0.h264", summary["estimated_fps"]["channel_0"], "front"),
                (1, outdir / f"{src.stem}_ch1.h264", summary["estimated_fps"]["channel_1"], "rear"),
            ):
                if h264.stat().st_size == 0:
                    mp4_messages.append(f"channel {channel}: no video data; MP4 skipped")
                    continue
                mp4 = outdir / f"{src.stem}_{label}.mp4"
                ok, msg = make_mp4(ffmpeg, h264, outdir / f"{src.stem}_audio.wav", mp4, fps)
                if ok:
                    summary["output"][f"channel_{channel}_mp4"] = str(mp4)
                else:
                    mp4_messages.append(f"channel {channel} MP4 failed: {msg}")

    summary["mp4_messages"] = mp4_messages
    json_path = outdir / f"{src.stem}_summary.json"
    txt_path = outdir / f"{src.stem}_summary.txt"
    json_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

    text_lines = [
        f"Input: {src}",
        f"Size: {src.stat().st_size:,} bytes",
        f"SHA-256: {digest}",
        f"JEB blocks: {len(summary['jeb_blocks'])}",
        f"Packets: {summary['valid_packets']:,}",
        f"Index mismatches: {summary['index_mismatches']}",
        f"Time: {summary['first_packet_time']} .. {summary['last_packet_time']}",
        f"Duration: {summary['duration_seconds']:.3f} sec",
        f"Estimated FPS: CH0={summary['estimated_fps']['channel_0']:.3f}, CH1={summary['estimated_fps']['channel_1']:.3f}",
        "Tags: " + ", ".join(f"{k}={v}" for k, v in summary["packet_tag_counts"].items()),
        "",
        "Outputs:",
        f"  {summary['output']['ch0_h264']}",
        f"  {summary['output']['ch1_h264']}",
        f"  {summary['output']['audio_wav']}",
        f"  {summary['output']['gps_csv']}",
        f"  {summary['output']['gsensor_csv']}",
    ]
    for key in ("channel_0_mp4", "channel_1_mp4"):
        if key in summary["output"]:
            text_lines.append(f"  {summary['output'][key]}")
    if mp4_messages:
        text_lines.extend(["", "MP4 notes:"] + [f"  - {x}" for x in mp4_messages])

    txt_path.write_text("\n".join(text_lines) + "\n", encoding="utf-8")

    print(f"Done: {outdir}")
    print(f"SHA-256: {digest}")
    if mismatch_total:
        print(f"WARNING: index mismatches = {mismatch_total}")
    for msg in mp4_messages:
        print(f"WARNING: {msg}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
