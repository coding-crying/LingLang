#!/usr/bin/env python3
"""Mints a browser join link for a Pipecat test room.

The normal LingLang flow can't be used to test this service. `/api/token`
names rooms `linglang-${userId}-${mode}` AND dispatches the Node tutor into
them (`createDispatch(roomName, 'linglang-tutor')`), so joining that way puts
two agents in one room, both answering. This mints a plain participant token
for an arbitrary room instead — no dispatch, so the Pipecat bot is the only
agent present.

Credentials are read from ../agents/.env.local. Nothing is printed except the
URL, and the token in it is scoped to one room and expires.

    ./join.py --room linglang-pipecat-test
"""

from __future__ import annotations

import argparse
import os
import pathlib
import sys
import urllib.parse

from dotenv import load_dotenv

HERE = pathlib.Path(__file__).parent
load_dotenv(HERE / ".env.local")
load_dotenv(HERE.parent / "agents" / ".env.local")


def main() -> int:
    parser = argparse.ArgumentParser(description="Mint a browser join link for a test room")
    parser.add_argument("--room", default=os.environ.get("LIVEKIT_ROOM", "linglang-pipecat-test"))
    parser.add_argument("--identity", default="human")
    parser.add_argument("--ttl-minutes", type=int, default=60)
    args = parser.parse_args()

    url = os.environ.get("LIVEKIT_URL")
    key = os.environ.get("LIVEKIT_API_KEY")
    secret = os.environ.get("LIVEKIT_API_SECRET")
    if not (url and key and secret):
        print("LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET not found.", file=sys.stderr)
        print("Checked voice-py/.env.local and agents/.env.local.", file=sys.stderr)
        return 2

    from datetime import timedelta

    from livekit import api

    token = (
        api.AccessToken(key, secret)
        .with_identity(args.identity)
        .with_name(args.identity)
        .with_ttl(timedelta(minutes=args.ttl_minutes))
        .with_grants(api.VideoGrants(room_join=True, room=args.room))
        .to_jwt()
    )

    q = urllib.parse.urlencode({"liveKitUrl": url, "token": token})
    print(f"\nroom: {args.room}   (expires in {args.ttl_minutes}m)\n")
    print("Open this, allow the mic, and talk:\n")
    print(f"  https://meet.livekit.io/custom?{q}\n")
    print("Start the bot in the same room first:\n")
    print(f"  .venv/bin/python bot.py --room {args.room} --user-id <userId>\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
