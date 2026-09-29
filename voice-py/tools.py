"""Gemini-callable tools, backed by the Node internal API.

These mirror the llm.tool() registrations in ../agents/src/tools/db-tools.ts.
The handlers do nothing but HTTP-call /internal/tools/* — all the querying,
FSRS interpretation and curriculum logic stays in TypeScript.

THE DESCRIPTIONS ARE PROMPT ENGINEERING, NOT DOCUMENTATION.

Every `description` below is copied verbatim from db-tools.ts. They are what
the model reads when deciding whether to call a tool, and they were tuned
against live sessions. Do not "improve", shorten or paraphrase them while
porting — a reworded description changes tool-selection behavior as surely as
changing the model would. If db-tools.ts changes, change these to match; they
are duplicated across a language boundary and nothing enforces that they stay
in sync.

BLOCKING vs NON-BLOCKING

Pipecat lets a tool declare whether the pipeline waits for it. All five here
are fast reads the model needs before it can speak sensibly, so all five
block. The Processor is the opposite — it writes FSRS state, takes seconds,
and nothing in the reply depends on it, so it must NOT be registered as a
blocking tool. It runs off the voice path.
"""

from __future__ import annotations

from typing import Any

from loguru import logger
from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.services.llm_service import FunctionCallParams

from internal_api import InternalAPI


def build_tools(api: InternalAPI, user_id: str) -> ToolsSchema:
    """Builds the tool schema for one learner's session.

    `user_id` is bound here rather than passed by the model. The Node tools
    read it from the LiveKit run context for the same reason: a user id is
    session identity, and letting a model supply it would mean a hallucinated
    id could read or write another learner's vocabulary.
    """

    async def _reply(params: FunctionCallParams, fn) -> None:
        """Runs a call, turning any failure into a result the model can speak to."""
        try:
            await params.result_callback(await fn())
        except Exception as e:  # noqa: BLE001 - surfaced to the model, not swallowed
            logger.error(f"tool {params.function_name} failed: {e}")
            await params.result_callback({"error": "That lookup failed. Carry on without it."})

    async def lookup_lexeme(params: FunctionCallParams) -> None:
        args = params.arguments
        await _reply(params, lambda: api.get("/tools/lexeme", {
            "userId": user_id,
            "lemma": args.get("lemma"),
            "language": args.get("language"),
        }))

    async def get_due_reviews(params: FunctionCallParams) -> None:
        await _reply(params, lambda: api.get("/tools/due-reviews", {
            "userId": user_id,
            "limit": params.arguments.get("limit", 10),
        }))

    async def get_vocab_overview(params: FunctionCallParams) -> None:
        await _reply(params, lambda: api.get("/tools/vocab-overview", {"userId": user_id}))

    async def get_semantic_neighbors(params: FunctionCallParams) -> None:
        args = params.arguments
        await _reply(params, lambda: api.get("/tools/semantic-neighbors", {
            "lemma": args.get("lemma"),
            "language": args.get("language"),
            "limit": args.get("limit", 5),
        }))

    async def get_active_goals(params: FunctionCallParams) -> None:
        await _reply(params, lambda: api.get("/tools/active-goals", {"userId": user_id}))

    return ToolsSchema(standard_tools=[
        FunctionSchema(
            name="lookup_lexeme",
            description=(
                "Look up a word (lemma) in the vocabulary database. Returns the translation, "
                "part of speech, and the learner's current FSRS memory state (stability, "
                "difficulty, due date, etc.). Use this to check if a word exists and how well "
                "the learner knows it."
            ),
            properties={
                "lemma": {
                    "type": "string",
                    "description": 'The word to look up (dictionary form, e.g. "привет", "casa")',
                },
                "language": {
                    "type": "string",
                    "description": "ISO 639-1 language code (ru, es, fr, pt, ar, en)",
                },
            },
            required=["lemma", "language"],
            handler=lookup_lexeme,
        ),
        FunctionSchema(
            name="get_due_reviews",
            description=(
                "Get the learner's vocabulary words that are due for spaced repetition review "
                "right now. These are words the learner has seen before that need practice. "
                "Returns up to 10 due words with their FSRS state (stability, difficulty, state)."
            ),
            properties={
                "limit": {"type": "integer", "description": "Max words to return (default 10)"},
            },
            required=[],
            handler=get_due_reviews,
        ),
        FunctionSchema(
            name="get_vocab_overview",
            description=(
                "Get a summary of the learner's vocabulary progress. Returns total words, "
                "breakdown by FSRS state (New/Learning/Review/Relearning), average stability, "
                "weakest words, and next curriculum words to introduce."
            ),
            properties={},
            required=[],
            handler=get_vocab_overview,
        ),
        FunctionSchema(
            name="get_semantic_neighbors",
            description=(
                "Find semantically related words to a given word using vector similarity "
                "(pgvector). Useful for finding words that could reinforce or confuse the "
                "learner. Returns neighbor words with their distance (lower = more similar)."
            ),
            properties={
                "lemma": {"type": "string", "description": "The word to find neighbors for"},
                "language": {"type": "string", "description": "ISO 639-1 language code"},
                "limit": {"type": "integer", "description": "Max neighbors to return (default 5)"},
            },
            required=["lemma", "language"],
            handler=get_semantic_neighbors,
        ),
        FunctionSchema(
            name="get_active_goals",
            description=(
                "Get the learner's current active teaching goals. These are words the system "
                "has identified as needing remediation (struggling) or new vocabulary to "
                "introduce. Each goal has a priority and optional grammar context."
            ),
            properties={},
            required=[],
            handler=get_active_goals,
        ),
    ])
