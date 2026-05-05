#!/usr/bin/env python3
"""Edge TTS worker for Railway (free, works in China)"""
import sys
import asyncio
import os

text = sys.argv[1] if len(sys.argv) > 1 else ""
output = sys.argv[2] if len(sys.argv) > 2 else ""

if not text or not output:
    print("Usage: tts_worker.py <text> <output.mp3>")
    sys.exit(1)

async def main():
    try:
        import edge_tts
        # 使用晓晓的声音（温暖女声）
        communicate = edge_tts.Communicate(text, voice="zh-CN-XiaoxiaoNeural")
        await communicate.save(output)
        size = os.path.getsize(output)
        print(f"OK:{size}")
        sys.exit(0)
    except Exception as e:
        print(f"ERR:{e}", file=sys.stderr)
        sys.exit(1)

asyncio.run(main())
