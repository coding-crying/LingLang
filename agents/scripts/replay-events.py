#!/usr/bin/env python3
"""
Replay tutor-events.jsonl as a clean, color-coded terminal stream.
Shows agentic decision-making flow: user input → LLM → planner → processor → SRS → reply.

Usage:
  # Replay last session from file:
  python3 scripts/replay-events.py

  # Follow live (like tail -f):
  python3 scripts/replay-events.py --follow

  # Filter to specific event types:
  python3 scripts/replay-events.py --only user,agent,planner,processor

  # Last N events:
  python3 scripts/replay-events.py --last 50
"""

import json
import sys
import time
import os
import argparse
from datetime import datetime, timezone

# --- Colors ---
BOLD = "\033[1m"
DIM = "\033[2m"
RED = "\033[31m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
BLUE = "\033[34m"
MAGENTA = "\033[35m"
CYAN = "\033[36m"
WHITE = "\033[37m"
RESET = "\033[0m"

EVENT_COLORS = {
    "user": CYAN,
    "agent": GREEN,
    "planner": MAGENTA,
    "processor": YELLOW,
    "session": BLUE,
    "error": RED,
    "instructions": DIM,
    "activity": DIM,
    "services": DIM,
    "agent.llm": DIM,
    "agent.tts": DIM,
    "agent.stt": DIM,
}

# Events to show by default (others are collapsed/hidden)
IMPORTANT_TYPES = {
    "session.start", "session.start.done", "services.created",
    "user.transcript", "session.user_input_transcribed",
    "agent.reply",
    "agent.state_change", "session.agent_state_changed",
    "planner.nudge", "planner.raw", "planner.update.start", "planner.update.done",
    "processor.analysis", "processor.raw",
    "instructions.refresh",
    "session.error",
    "session.metrics_collected",
    "session.say.initial_greeting",
    "session.start.begin",
}

# Event type prefixes for --only filter groups
GROUP_MAP = {
    "user": {"user.transcript", "session.user_input_transcribed"},
    "agent": {"agent.reply", "agent.state_change", "session.agent_state_changed"},
    "planner": {"planner.nudge", "planner.raw", "planner.update.start", "planner.update.done"},
    "processor": {"processor.analysis", "processor.raw"},
    "error": {"session.error"},
    "metrics": {"session.metrics_collected"},
    "state": {"agent.state_change", "session.agent_state_changed"},
    "instructions": {"instructions.refresh"},
    "all": None,  # show everything
}


def get_color(event_type: str) -> str:
    prefix = event_type.split(".")[0]
    if prefix in EVENT_COLORS:
        return EVENT_COLORS[prefix]
    for key, color in EVENT_COLORS.items():
        if event_type.startswith(key):
            return color
    return WHITE


def format_ts(ts_ms: int) -> str:
    dt = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)
    return dt.strftime("%H:%M:%S")


def format_elapsed(ts_ms: int, first_ts: int) -> str:
    elapsed = (ts_ms - first_ts) / 1000
    return f"{elapsed:7.1f}s"


def truncate(text: str, max_len: int = 120) -> str:
    text = text.replace("\n", " ").strip()
    if len(text) > max_len:
        return text[:max_len - 1] + "…"
    return text


def format_data(event_type: str, data: dict, verbose: bool) -> str:
    """Format event data for display based on type."""

    if event_type == "user.transcript":
        text = data.get("text", "")
        is_final = data.get("isFinal", False)
        final_mark = "◆" if is_final else "◇"
        return f"{final_mark} {text}"

    elif event_type == "session.user_input_transcribed":
        text = data.get("user_transcript", data.get("text", ""))
        return f"◇ {text}"

    elif event_type == "agent.reply":
        text = data.get("text", "")
        if verbose:
            return text
        return truncate(text, 200)

    elif event_type in ("agent.state_change", "session.agent_state_changed"):
        if isinstance(data, dict):
            fr = data.get("from", data.get("old_state", "?"))
            to = data.get("to", data.get("new_state", "?"))
            return f"{fr} → {to}"
        return str(data)

    elif event_type == "planner.nudge":
        reason = data.get("reason", "")
        nudge = data.get("nudge", data.get("message", ""))
        if verbose:
            return f"[{reason}]\n{nudge}"
        return f"[{reason}] {truncate(nudge, 100)}"

    elif event_type == "planner.raw":
        if not verbose:
            return "(expand with --verbose)"
        prompt = data.get("prompt", "")
        response = data.get("response", "")
        return f"PROMPT:\n{truncate(prompt, 500)}\nRESPONSE:\n{truncate(response, 500)}"

    elif event_type == "processor.analysis":
        utterance = data.get("utterance", "")
        errors = data.get("errors", [])
        struct_errors = data.get("structuredErrors", [])
        hints = data.get("grammarHints", [])
        lexeme_count = data.get("lexemeCount", 0)
        srs_count = data.get("srsUpdateCount", data.get("srsUpdates", []))
        srs_num = srs_count if isinstance(srs_count, int) else len(srs_count)

        if verbose:
            parts = [f'"{utterance}"']
            if errors:
                parts.append(f"errors: {json.dumps(errors, ensure_ascii=False)}")
            if struct_errors:
                parts.append(f"structuredErrors: {json.dumps(struct_errors, ensure_ascii=False)}")
            if hints:
                parts.append(f"hints: {json.dumps(hints, ensure_ascii=False)}")
            parts.append(f"lexemes={lexeme_count} srs={srs_num}")
            return "\n".join(parts)

        parts = [f'"{utterance}"']
        if errors or struct_errors:
            n = len(errors) + len(struct_errors)
            parts.append(f"{n} err")
        if hints:
            parts.append(f"{len(hints)} hint{'s' if len(hints) != 1 else ''}")
        parts.append(f"{lexeme_count} lex")
        parts.append(f"{srs_num} SRS")
        return " | ".join(parts)

    elif event_type == "processor.raw":
        if not verbose:
            return "(expand with --verbose)"
        prompt = data.get("prompt", "")
        response = data.get("response", "")
        return f"PROMPT:\n{truncate(prompt, 500)}\nRESPONSE:\n{truncate(response, 500)}"

    elif event_type == "session.error":
        msg = data.get("message", data.get("error", data.get("detail", "")))
        if not msg:
            msg = json.dumps(data, ensure_ascii=False)
        return truncate(str(msg), 200)

    elif event_type == "session.metrics_collected":
        m = data
        if not isinstance(m, dict):
            return str(m)
        ttft = m.get("ttftMs", m.get("ttft_ms"))
        dur = m.get("durationMs", m.get("duration_ms"))
        tps = m.get("tokensPerSecond", m.get("tokens_per_second"))
        model = m.get("modelName", m.get("model", ""))
        label = m.get("label", m.get("type", ""))
        cancelled = m.get("cancelled", False)
        parts = [label]
        if model:
            parts.append(model)
        if ttft is not None and ttft > 0:
            parts.append(f"TTFT {ttft/1000:.1f}s")
        if dur is not None:
            parts.append(f"dur {dur/1000:.1f}s")
        if tps is not None and tps > 0:
            parts.append(f"{tps:.1f} tok/s")
        if cancelled:
            parts.append("CANCELLED")
        return " | ".join(parts)

    elif event_type == "instructions.refresh":
        if verbose:
            return truncate(str(data.get("instructions", str(data))), 300)
        return "(updated)"

    elif event_type == "session.start":
        uid = data.get("userId", "")
        lang = data.get("language", "")
        mode = data.get("mode", "")
        return f"user={uid} lang={lang} mode={mode}"

    elif event_type == "services.created":
        return data.get("detail", str(data))

    elif event_type == "session.say.initial_greeting":
        text = data.get("text", str(data))
        return truncate(text, 150)

    elif event_type == "planner.update.start":
        reason = data.get("reason", "")
        return f"reason={reason}" if reason else ""

    elif event_type == "planner.update.done":
        return ""

    else:
        if verbose:
            return truncate(json.dumps(data, ensure_ascii=False), 200)
        return ""


def render_event(event: dict, first_ts: int, verbose: bool, show: bool) -> str:
    ts = event.get("ts", 0)
    event_type = event.get("type", "unknown")
    data = event.get("data", {})

    if not show:
        return ""

    color = get_color(event_type)
    time_str = format_ts(ts)
    elapsed = format_elapsed(ts, first_ts)
    formatted = format_data(event_type, data, verbose)

    if not formatted and not verbose:
        return ""

    # Type badge
    type_parts = event_type.split(".")
    badge = type_parts[-1] if len(type_parts) > 1 else event_type

    line = f"{DIM}{time_str}{RESET} {DIM}{elapsed}{RESET} {color}{BOLD}{badge:20s}{RESET} {formatted}"
    return line


def parse_events(filepath: str, last_n: int = None, only_types: set = None, verbose: bool = False):
    events = []
    with open(filepath, "r") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
                events.append(event)
            except json.JSONDecodeError:
                pass

    if not events:
        print(f"{RED}No events found in {filepath}{RESET}")
        return

    if last_n:
        events = events[-last_n:]

    first_ts = events[0].get("ts", 0)

    # Determine which types to show
    if only_types is not None:
        show_types = only_types
    elif verbose:
        show_types = None  # show all
    else:
        show_types = IMPORTANT_TYPES

    for event in events:
        event_type = event.get("type", "")
        if show_types is not None and event_type not in show_types:
            continue
        line = render_event(event, first_ts, verbose, True)
        if line:
            print(line)


def follow_events(filepath: str, only_types: set = None, verbose: bool = False):
    """Follow file like tail -f, rendering new events as they arrive."""
    # First, show last 20 events for context
    events = []
    with open(filepath, "r") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                pass

    if events:
        first_ts = events[0].get("ts", 0)
        recent = events[-20:]
        if only_types:
            recent = [e for e in recent if e.get("type") in only_types]
        elif not verbose:
            recent = [e for e in recent if e.get("type") in IMPORTANT_TYPES]

        print(f"{DIM}--- Last 20 events ---{RESET}")
        for event in recent:
            line = render_event(event, first_ts, verbose, True)
            if line:
                print(line)
        print(f"{DIM}--- Following live ---{RESET}")

    # Now follow
    last_size = os.path.getsize(filepath) if os.path.exists(filepath) else 0
    first_ts = events[0].get("ts", 0) if events else int(time.time() * 1000)

    with open(filepath, "r") as f:
        f.seek(last_size)
        while True:
            line = f.readline()
            if line:
                line = line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                    event_type = event.get("type", "")
                    if only_types and event_type not in only_types:
                        continue
                    if not verbose and not only_types and event_type not in IMPORTANT_TYPES:
                        continue
                    rendered = render_event(event, first_ts, verbose, True)
                    if rendered:
                        print(rendered)
                        sys.stdout.flush()
                except json.JSONDecodeError:
                    pass
            else:
                time.sleep(0.2)


def main():
    parser = argparse.ArgumentParser(description="View LingLang tutor event stream")
    parser.add_argument("--file", "-f", default="/tmp/tutor-events.jsonl", help="Event file path")
    parser.add_argument("--follow", "-F", action="store_true", help="Follow live (tail -f mode)")
    parser.add_argument("--verbose", "-v", action="store_true", help="Show all event types + full data")
    parser.add_argument("--last", "-n", type=int, help="Show last N events")
    parser.add_argument("--only", "-o", type=str, help="Comma-separated groups: user,agent,planner,processor,error,metrics,state,instructions,all")
    args = parser.parse_args()

    if not os.path.exists(args.file):
        print(f"{RED}File not found: {args.file}{RESET}")
        sys.exit(1)

    only_types = None
    if args.only:
        groups = args.only.split(",")
        only_types = set()
        for g in groups:
            g = g.strip()
            if g in GROUP_MAP:
                if GROUP_MAP[g] is None:
                    only_types = None  # all
                    break
                only_types.update(GROUP_MAP[g])
            else:
                print(f"{RED}Unknown group: {g}. Available: {', '.join(GROUP_MAP.keys())}{RESET}")
                sys.exit(1)

    if args.follow:
        try:
            follow_events(args.file, only_types, args.verbose)
        except KeyboardInterrupt:
            print(f"\n{DIM}Stopped.{RESET}")
    else:
        parse_events(args.file, args.last, only_types, args.verbose)


if __name__ == "__main__":
    main()
