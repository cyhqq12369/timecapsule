#!/usr/bin/env python3
"""gTTS worker for Railway (no API key needed, free)"""
import sys
import os

text = sys.argv[1] if len(sys.argv) > 1 else ""
output = sys.argv[2] if len(sys.argv) > 2 else ""

if not text or not output:
    print("Usage: tts_worker.py <text> <output.mp3>")
    sys.exit(1)

try:
    from gtts import gTTS
    tts = gTTS(text=text, lang='zh-cn')
    tts.save(output)
    size = os.path.getsize(output)
    print(f"OK:{size}")
    sys.exit(0)
except Exception as e:
    print(f"ERR:{e}", file=sys.stderr)
    sys.exit(1)
