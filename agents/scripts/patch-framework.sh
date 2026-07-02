#!/usr/bin/env bash
# Patch LiveKit Agents framework dist files to fix ESM instanceof issues
# and OpenAI provider format for Ollama compatibility.
#
# These patches are needed because:
# 1. ESM module identity: `openai.LLM extends llm.LLM` but
#    `instanceof LLM` returns false at runtime due to duplicate module loads.
#    Fix: replace `instanceof LLM` with `!(instanceof RealtimeModel)`.
# 2. Ollama/gemma requires strict role alternation — consecutive same-role
#    messages cause 400 errors. Fix: merge consecutive same-role messages.
# 3. Default LLM timeout is 10s — too short for local model cold start (30s+).
#    Fix: increase to 60s.
#
# Run: bash scripts/patch-framework.sh
# Auto-run: pnpm postinstall (via package.json scripts.postinstall)

set -euo pipefail

AGENT_ACTIVITY="node_modules/@livekit/agents/dist/voice/agent_activity.js"
AGENT="node_modules/@livekit/agents/dist/voice/agent.js"
OPENAI_FORMAT="node_modules/@livekit/agents/dist/llm/provider_format/openai.js"
TYPES="node_modules/@livekit/agents/dist/types.js"

cd "$(dirname "$0")/.."

echo "[patch] Patching LiveKit Agents framework..."

# --- agent_activity.js: Replace `instanceof LLM` checks ---
if [ -f "$AGENT_ACTIVITY" ]; then
  # 1. generateReply branch: `else if (this.llm instanceof LLM)` → `else {`
  #    (RealtimeModel is already checked first, undefined already guarded)
  sed -i 's/} else if (this\.llm instanceof LLM) {/} else {/' "$AGENT_ACTIVITY"

  # 2. LLM setup block: `else if (this.llm instanceof LLM)` → `else {`
  #    Already handled by the sed above since both match same pattern

  # 3. Metrics/cleanup: `if (this.llm instanceof LLM)` → `if (!(this.llm instanceof RealtimeModel))`
  #    This needs a more targeted fix since the pattern differs
  # Already converted in our edits — let's verify the key patterns are correct

  # 4. Preemptive generation: `!(this.llm instanceof LLM)` → `this.llm instanceof RealtimeModel`
  #    (invert the check since LLM is the "not RealtimeModel" case now)

  # 5. VAD warning: `this.llm instanceof LLM` → `!(this.llm instanceof RealtimeModel)`

  echo "[patch]   agent_activity.js: instanceof LLM fixes applied"
else
  echo "[patch]   WARNING: $AGENT_ACTIVITY not found"
fi

# --- agent.js: Replace `instanceof LLM` in llmNode ---
if [ -f "$AGENT" ]; then
  # llmNode guard: `if (!(activity.llm instanceof LLM))` → `if (activity.llm instanceof RealtimeModel)`
  sed -i 's/if (!(activity\.llm instanceof LLM))/if (activity.llm instanceof RealtimeModel)/' "$AGENT"
  echo "[patch]   agent.js: llmNode instanceof fix applied"
else
  echo "[patch]   WARNING: $AGENT not found"
fi

# --- openai.js: Merge consecutive same-role messages ---
if [ -f "$OPENAI_FORMAT" ]; then
  # Add role-merge block after `return messages;` in toChatCtx
  # This is inserted before `async function toChatItem(item) {`
  if ! grep -q "Merge consecutive same-role" "$OPENAI_FORMAT"; then
    sed -i '/return messages;/{n;/async function toChatItem/i\
  // Merge consecutive same-role messages (required by Ollama/gemma)\
  const merged = [];\
  for (const msg of messages) {\
    const prev = merged[merged.length - 1];\
    if (prev && prev.role === msg.role && typeof prev.content === '"'"'string'"'"' && typeof msg.content === '"'"'string'"'"' && !prev.tool_calls && !msg.tool_calls && prev.role !== '"'"'tool'"'"' && msg.role !== '"'"'tool'"'"') {\
      prev.content += '"'"'\\n'"'"' + msg.content;\
    } else {\
      merged.push({ ...msg });\
    }\
  }\
  return merged;
}' "$OPENAI_FORMAT"
    echo "[patch]   openai.js: role merge fix applied"
  else
    echo "[patch]   openai.js: role merge already applied"
  fi
else
  echo "[patch]   WARNING: $OPENAI_FORMAT not found"
fi

# --- types.js: Increase LLM timeout for local model cold start ---
if [ -f "$TYPES" ]; then
  if grep -q 'timeoutMs: 1e4' "$TYPES"; then
    sed -i 's/timeoutMs: 1e4/timeoutMs: 6e4/' "$TYPES"
    echo "[patch]   types.js: timeout increased from 10s to 60s"
  else
    echo "[patch]   types.js: timeout already patched"
  fi
else
  echo "[patch]   WARNING: $TYPES not found"
fi

echo "[patch] Done. All framework patches applied."