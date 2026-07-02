#!/usr/bin/env -S node-22 --import tsx
/**
 * matrix-call-bot.ts
 *
 * Signs in to Matrix as the LingLang bot account, watches for `m.call.invite`
 * events (Element Call group calls, MSC3401/Matrix-LiveKit), and dispatches
 * the LingLang LiveKit agent into a LiveKit Cloud room matching the call.
 *
 * The bot is a thin bridge:
 *   1. Element client on matrix.senilelines.com calls the bot
 *   2. Bot receives m.call.invite
 *   3. Bot mints a LiveKit Cloud JWT for the call's LiveKit room
 *   4. Bot calls LiveKit's AgentDispatchClient to send our agent
 *   5. The LingLang agent (already registered to the room) joins
 *   6. User talks in Russian; agent responds
 *
 * The agent is unchanged — this script just routes Matrix calls to it.
 *
 * Run with:
 *   pnpm dev:matrix-bot    # or: tsx agents/src/scripts/matrix-call-bot.ts
 */

import * as dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';

import { EventType, createClient, type MatrixEvent } from 'matrix-js-sdk';
import { ClientEvent } from 'matrix-js-sdk/lib/client';
import { RoomEvent } from 'matrix-js-sdk/lib/models/room';
import { RoomStateEvent } from 'matrix-js-sdk/lib/models/room-state';
import { AccessToken, RoomServiceClient, AgentDispatchClient } from 'livekit-server-sdk';
import pino from 'pino';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// env lives at agents/.env.local
dotenv.config({ path: resolve(__dirname, '../../.env.local'), override: false });

const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: process.env.NODE_ENV === 'production'
    ? undefined
    : { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' } },
}).child({ component: 'matrix-call-bot' });

const HOMESERVER = process.env.MATRIX_HOMESERVER ?? 'https://matrix.senilelines.com';
const BOT_USER_ID = process.env.MATRIX_BOT_USER_ID ?? '@linglang:matrix.senilelines.com';
const BOT_PASSWORD = process.env.MATRIX_BOT_PASSWORD;
const BOT_ACCESS_TOKEN = process.env.MATRIX_BOT_ACCESS_TOKEN;
const LIVEKIT_URL = process.env.LIVEKIT_URL!;          // e.g. wss://lingo-xxx.livekit.cloud
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY!;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET!;
const AGENT_NAME = process.env.LINGLANG_AGENT_NAME ?? 'linglang-tutor';

if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
  log.error({ LIVEKIT_URL: !!LIVEKIT_URL, LIVEKIT_API_KEY: !!LIVEKIT_API_KEY, LIVEKIT_API_SECRET: !!LIVEKIT_API_SECRET },
    'missing LiveKit credentials in env');
  process.exit(1);
}
if (!BOT_PASSWORD && !BOT_ACCESS_TOKEN) {
  log.error('set MATRIX_BOT_PASSWORD or MATRIX_BOT_ACCESS_TOKEN');
  process.exit(1);
}

/** Map a Matrix room ID + call id to a LiveKit room name. Unique per call. */
function matrixRoomToLivekitRoom(matrixRoomId: string, callId: string): string {
  const safe = matrixRoomId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `call-${safe}-${callId.slice(0, 8)}`;
}

/**
 * Compute the LiveKit room name exactly the way `lk-jwt-service` (the
 * official Element Matrix LiveKit JWT service) does.
 *
 * Source: https://github.com/element-hq/lk-jwt-service/blob/main/helper.go
 *
 *   func LiveKitRoomAliasFor(matrixRoom, matrixRtcSlot string) LiveKitRoomAlias {
 *       hash := sha256.Sum256(marshalStrings([]string{matrixRoom, matrixRtcSlot}))
 *       return LiveKitRoomAlias(unpaddedBase64.EncodeToString(hash[:]))
 *   }
 *
 * Where `marshalStrings` is `json.Marshal([]string{...})` (NO spaces, Go
 * default) and the slot for the legacy /sfu/get endpoint is hardcoded
 * `"m.call#ROOM"`.
 *
 * Both the user (joining via Element's lk-jwt-service) and the agent
 * (joining via AgentDispatch) need the same room name or they'll never
 * meet.
 */
function livekitRoomAliasForMatrixRoom(matrixRoomId: string): string {
  // Go's encoding/json marshals []string without spaces, e.g.
  //   ["!abc:server","m.call#ROOM"]
  const json = `[${JSON.stringify(matrixRoomId)},${JSON.stringify('m.call#ROOM')}]`.replace(/\s/g, '');
  // Node's crypto module for SHA-256 + base64
  const hash = createHash('sha256').update(json).digest();
  return hash.toString('base64').replace(/=+$/, '');
}

/** Mint a LiveKit Cloud JWT for a user joining a room. */
async function mintUserToken(roomName: string, identity: string, displayName?: string): Promise<string> {
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity,
    name: displayName ?? identity,
    ttl: 60 * 60, // 1h
  });
  at.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });
  return await at.toJwt();
}

/**
 * Publish the bot's own MSC3401 call membership state event so Element
 * renders the agent as a call participant. Element's MatrixRTC call UI
 * shows participants based on `org.matrix.msc3401.call.member` state events
 * in the room. Without one from the bot, the user sees only themselves
 * even though the agent is in the LiveKit room and producing audio.
 *
 * State key format (from Element source): `_<userId>_<deviceId>_m.call`
 * Content mirrors the user's call event: `foci_preferred` points at the
 * same LiveKit room and `focus_active` claims it.
 */
async function publishBotMembership(matrixRoomId: string, lkRoom: string, callerMxid: string): Promise<void> {
  const deviceId = process.env.MATRIX_BOT_DEVICE_ID ?? 'LGLBOT';
  const stateKey = `_${BOT_USER_ID}_${deviceId}_m.call`;
  // Inherit the user's call intent if present; default to audio.
  let intent = 'audio';
  try {
    const callerStateKey = `_${callerMxid}_`; // device id varies; we scan via room state
    const room = clientRef?.getRoom(matrixRoomId);
    if (room) {
      for (const ev of room.currentState.getStateEvents('org.matrix.msc3401.call.member') ?? []) {
        const c = ev.getContent() as Record<string, any> | undefined;
        if (c?.['m.call.intent']) { intent = c['m.call.intent']; break; }
      }
    }
    void callerStateKey; // suppress unused-var lint
  } catch { /* default to audio */ }
  const content = {
    application: 'm.call',
    call_id: '',
    scope: 'm.room',
    device_id: deviceId,
    membershipID: `${BOT_USER_ID}:${deviceId}`,
    expires: 14400000, // 4h
    'm.call.intent': intent,
    focus_active: {
      type: 'livekit',
      focus_selection: 'oldest_membership',
    },
    foci_preferred: [
      {
        livekit_alias: lkRoom,
        type: 'livekit',
        livekit_service_url: 'https://rtc.senilelines.com/livekit/jwt',
      },
    ],
  };
  try {
    await clientRef?.sendStateEvent(matrixRoomId, 'org.matrix.msc3401.call.member', content, stateKey);
    log.info({ matrixRoomId, stateKey, lkRoom, intent }, 'published bot MSC3401 membership');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err: msg, stateKey }, 'failed to publish bot MSC3401 membership (Element may not show agent)');
  }
}

/** Ref to the matrix client, set in main(), so helpers can use it. */
let clientRef: ReturnType<typeof createClient> | null = null;

async function main() {
  log.info({ homeserver: HOMESERVER, user: BOT_USER_ID }, 'starting matrix call bot');

  // Sign in to Matrix
  const client = createClient({
    baseUrl: HOMESERVER,
    accessToken: BOT_ACCESS_TOKEN,
    userId: BOT_USER_ID,
    deviceId: process.env.MATRIX_BOT_DEVICE_ID,
  });
  clientRef = client;

  // Initialize E2EE crypto BEFORE startClient so we can read encrypted
  // MSC3401 call events. The "linglang calls" room uses m.megolm.v1.aes-sha2;
  // without crypto the bot can see member/typing events but call events
  // come through as garbage. useIndexedDB:false because the rust wasm
  // IndexedDB store panics on Node (browser-only API); in-memory is fine
  // for our usage (we restart the bot often and re-sync).
  try {
    await (client as any).initRustCrypto({ useIndexedDB: false });
    log.info('rust crypto initialized (in-memory store)');
  } catch (err) {
    log.warn({ err: (err as Error).message },
      'initRustCrypto failed — encrypted rooms will be unreadable');
  }

  await client.startClient({ initialSyncLimit: 0 });
  log.info({ user_id: client.getUserId() }, 'matrix client started');

  // Wait for the first sync to complete so `getRooms()` returns populated rooms.
  // We can't attach a RoomEvent.State listener on a Room we don't have yet, and
  // matrix-js-sdk creates Room objects lazily during sync.
  await new Promise<void>((resolve) => {
    const onSync = (state: string) => {
      if (state === 'SYNCING' || state === 'PREPARED' || state === 'SYNCING' || state === 'CATCHUP') {
        log.info({ syncState: state }, 'initial sync complete');
        client.off(ClientEvent.SyncState as any, onSync as any);
        resolve();
      }
    };
    client.on(ClientEvent.SyncState as any, onSync as any);
    // Safety timeout
    setTimeout(() => {
      log.warn('initial sync wait timed out after 10s, continuing anyway');
      resolve();
    }, 10_000);
  });

  // Build a LiveKit server-SDK handle for dispatching the agent
  const roomService = new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
  const agentDispatch = new AgentDispatchClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);

  // Pre-create LiveKit rooms for each Matrix room with a long empty timeout
  // (1 hour). lk-jwt-service creates rooms on demand with a 5-minute empty
  // timeout (hardcoded at helper.go:130 in its source), which is too short
  // for a user who delays before clicking "Call" in Element.
  //
  // LiveKit's CreateRoom is idempotent on name but does NOT update
  // emptyTimeout/departureTimeout if the room already exists. So if
  // lk-jwt-service created the room first with a 5-min timeout, our
  // createRoom call is a no-op. To guarantee the long timeout, we
  // delete the room first (if it exists) and then create it fresh.
  //
  // Re-run every 5 minutes to refresh the empty-timeout clock in case
  // the user dawdles more than 60 minutes between calls.
  const ROOM_EMPTY_TIMEOUT_SECS = 60 * 60; // 1 hour
  const ROOM_DEPARTURE_TIMEOUT_SECS = 60 * 5; // 5 min after last participant leaves
  const homeMatrixRooms = client.getRooms();
  log.info({ count: homeMatrixRooms.length }, 'pre-creating LiveKit rooms with extended timeouts');
  for (const matrixRoom of homeMatrixRooms) {
    const lkRoomName = livekitRoomAliasForMatrixRoom(matrixRoom.roomId);
    // Try to delete any existing room (idempotent; fails silently if absent)
    try { await roomService.deleteRoom(lkRoomName); }
    catch { /* fine if room didn't exist */ }
    // Create with our long timeout
    try {
      await roomService.createRoom({
        name: lkRoomName,
        emptyTimeout: ROOM_EMPTY_TIMEOUT_SECS,
        departureTimeout: ROOM_DEPARTURE_TIMEOUT_SECS,
        maxParticipants: 0,
      });
      log.info({ matrixRoom: matrixRoom.roomId, lkRoom: lkRoomName, emptyTimeout: ROOM_EMPTY_TIMEOUT_SECS },
        'pre-created LiveKit room with 1h empty timeout');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ lkRoom: lkRoomName, err: msg }, 'pre-create room failed');
    }
  }
  // Refresh the room timeouts periodically. Delete + recreate to ensure
  // the timeout actually updates (CreateRoom is idempotent and won't
  // change emptyTimeout on an existing room).
  setInterval(async () => {
    for (const matrixRoom of client.getRooms()) {
      const lkRoomName = livekitRoomAliasForMatrixRoom(matrixRoom.roomId);
      try {
        // Only delete + recreate if the room exists; skip creation otherwise
        // to avoid racing with the user's call.
        const existing = (await roomService.listRooms()).find(r => r.name === lkRoomName);
        if (existing) {
          await roomService.deleteRoom(lkRoomName);
          await roomService.createRoom({
            name: lkRoomName,
            emptyTimeout: ROOM_EMPTY_TIMEOUT_SECS,
            departureTimeout: ROOM_DEPARTURE_TIMEOUT_SECS,
            maxParticipants: 0,
          });
          log.info({ lkRoom: lkRoomName }, 'refreshed room timeouts');
        }
      } catch (err) {
        log.debug({ lkRoom: lkRoomName, err: (err as Error).message }, 'room timeout refresh (no-op)');
      }
    }
  }, 5 * 60 * 1000); // every 5 minutes

  // Track active call sessions
  const activeCalls = new Map<string, { lkRoom: string; callerMatrixId: string; startedAt: number; dispatchId?: string; stateKey: string }>();

  // Watch ALL events for debug visibility. Filter by type where needed.
  client.on(ClientEvent.Event, async (event: MatrixEvent) => {
    try {
      const type = event.getType();
      const sender = event.getSender();
      const roomId = event.getRoomId();
      // Verbose log so we can see what we're getting
      if (sender !== BOT_USER_ID) {
        log.info({ type, sender, roomId, content: event.getContent() },
          'matrix event received');
      }

      // NOTE: MSC3401 dispatch + hangup is handled by the
      // RoomStateEvent.Events listener (RoomEvent.Timeline) further below.
      // matrix-js-sdk's ClientEvent.Event coalesces state-event updates
      // for the same state_key and loses prev_content, so a fast
      // invite→hangup sequence only delivers the (empty) hangup.
      // The RoomState listener fires for every transition with prev_content.
      // This listener handles legacy m.call.invite + m.call.hangup only.

      // MSC3401 hangup: org.matrix.msc3401.call.member with empty membership
      if (type === 'org.matrix.msc3401.call.member' || type === 'm.call.hangup') {
        const content = event.getContent() as Record<string, any> | undefined;
        // MSC3401 uses 'memberships' state for active members; hangup removes
        // the membership. For legacy m.call.hangup, look at activeCalls by room.
        if (type === 'm.call.hangup' && content?.call_id && activeCalls.has(content.call_id)) {
          const active = activeCalls.get(content.call_id)!;
          log.info({ call_id: content.call_id, lkRoom: active.lkRoom, duration_ms: Date.now() - active.startedAt },
            'call hangup received, closing LiveKit room');
          if (active.dispatchId) {
            try { await agentDispatch.deleteDispatch(active.dispatchId, active.lkRoom); }
            catch (err) { log.warn({ err: (err as Error).message }, 'deleteDispatch failed'); }
          }
          try { await roomService.deleteRoom(active.lkRoom); }
          catch (err) { log.warn({ err: (err as Error).message }, 'deleteRoom failed (room may already be closed)'); }
          activeCalls.delete(content.call_id);
          return;
        }
        // For MSC3401, fall through to the active calls check at the bottom.
      }

      // Determine the LiveKit room name from the event.
      // MSC3401 dispatch is handled by the RoomStateEvent listener (which
      // sees state transitions with prev_content). This listener handles
      // legacy m.call.invite only.
      let lkRoom: string | null = null;
      let callKey: string | null = null;

      if (type === EventType.CallInvite) {
        const content = event.getContent() as Record<string, any> | undefined;
        if (content?.call_id && roomId) {
          lkRoom = matrixRoomToLivekitRoom(roomId, content.call_id);
          const eventId = event.getId?.() ?? content.call_id;
          callKey = `legacy:${roomId}:${content.call_id}:${eventId}`;
        }
      }

      if (!lkRoom || !callKey) return;
      if (!roomId) return;

      if (activeCalls.has(callKey)) {
        log.info({ callKey, lkRoom }, 'ignoring duplicate call invite');
        return;
      }

      const caller = sender ?? '';
      const isVideo = false; // MSC3401 doesn't expose video flag here; assume audio
      log.info({ callKey, caller, roomId, lkRoom, isVideo, type },
        'received call invite, dispatching LingLang agent');

      // 1. Tell LiveKit to dispatch the LingLang agent into this room.
      let dispatchId: string | undefined;
      try {
        const dispatch = await agentDispatch.createDispatch(lkRoom, AGENT_NAME);
        dispatchId = dispatch.id;
        log.info({ lkRoom, agent: AGENT_NAME, dispatchId }, 'agent dispatched');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn({ err: msg }, 'createDispatch failed, falling back to room metadata');
        try {
          await roomService.updateRoomMetadata(lkRoom, JSON.stringify({ agent: AGENT_NAME }));
        } catch (err2: unknown) {
          const msg2 = err2 instanceof Error ? err2.message : String(err2);
          log.error({ err: msg2 }, 'fallback updateRoomMetadata also failed');
        }
      }

      // 2. Send a hint to the caller with LiveKit credentials so their
      //    Element client can join the LiveKit room. The "official" way is
      //    to send an m.call.answer, but for first-cut MVP a notice message
      //    is more robust across Element versions.
      const callerToken = await mintUserToken(lkRoom, caller);
      const joinUrl = `${LIVEKIT_URL.replace('wss://', 'https://')}/rooms/${lkRoom}`;
      try {
        await client.sendEvent(roomId, 'm.room.message', {
          msgtype: 'm.notice',
          body: `📞 LingLang agent is joining the call.\n` +
                `LiveKit room: ${lkRoom}\n` +
                `Token: ${callerToken}\n` +
                `Join URL: ${joinUrl}`,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn({ err: msg }, 'failed to send notice (caller may not be in room)');
      }

      activeCalls.set(callKey, { lkRoom, callerMatrixId: caller, startedAt: Date.now(), dispatchId, stateKey: event.getStateKey?.() ?? '' });
    } catch (err) {
      log.error({ err: (err as Error).message }, 'error handling call invite');
    }
  });

  // MSC3401 state-event listener — the primary path for Element calls.
  //
  // matrix-js-sdk's `ClientEvent.Event` coalesces state-event updates for
  // the same state_key and only delivers the latest content (losing
  // prev_content). When Element sends `invite` (foci_preferred) → `hangup`
  // ({}) within a few seconds, the bot's ClientEvent.Event only ever sees
  // the hangup, so the bot dispatches no agent.
  //
  // `RoomStateEvent.Events` (which is re-emitted as `Room.timeline` on the
  // Room object) fires for every transition with `prev_content` intact.
  // We use that to detect a *transition* from "no call" → "call active"
  // and dispatch the agent, even if the hangup has already arrived.
  for (const room of client.getRooms()) {
    attachRoomStateListener(room);
  }
  client.on(ClientEvent.Room as any, (room: any) => {
    // Fires when a new Room is created during sync (lazy room creation).
    attachRoomStateListener(room);
    // Auto-join any room we get invited to (DMs, group rooms, etc.) so
    // the state-listener can pick up MSC3401 calls from those rooms.
    autoJoinOnInvite(room);
  });

  // Also auto-join rooms we're already in but not yet joined (DMs where
  // we were invited before the bot started).
  for (const room of client.getRooms()) {
    autoJoinOnInvite(room);
  }

  function autoJoinOnInvite(room: any): void {
    if ((room as any).__linglangInviteHandler) return; // idempotent
    (room as any).__linglangInviteHandler = true;
    room.on(RoomEvent.MyMembership as any, async (_evt: any, membership: string, prevMembership: string | undefined) => {
      if (membership === 'invite') {
        const roomId = room.roomId;
        const sender = room.getMyMembership?.() === 'invite'
          ? (room.currentState?.getStateEvents?.('m.room.member', BOT_USER_ID)?.getSender?.())
          : null;
        log.info({ roomId, sender, prevMembership }, 'invited to room, auto-joining');
        try {
          await client.joinRoom(roomId);
          log.info({ roomId }, 'auto-joined room');
          // Pre-create LiveKit room for the new Matrix room so calls
          // have the 1h empty timeout (not lk-jwt-service's 5min).
          const lkRoomName = livekitRoomAliasForMatrixRoom(roomId);
          try { await roomService.deleteRoom(lkRoomName); }
          catch { /* fine if room didn't exist */ }
          try {
            await roomService.createRoom({
              name: lkRoomName,
              emptyTimeout: ROOM_EMPTY_TIMEOUT_SECS,
              departureTimeout: ROOM_DEPARTURE_TIMEOUT_SECS,
              maxParticipants: 0,
            });
            log.info({ roomId, lkRoomName }, 'pre-created LiveKit room for new Matrix room');
          } catch (err) {
            log.warn({ err: (err as Error).message, lkRoomName }, 'pre-create failed for new room');
          }
        } catch (err) {
          log.error({ err: (err as Error).message, roomId }, 'auto-join failed');
        }
      }
    });
  }

  function attachRoomStateListener(room: any): void {
    if ((room as any).__linglangStateListener) return; // idempotent
    (room as any).__linglangStateListener = true;

    // The Room re-emits state events via RoomEvent.Timeline (so the
    // listener fires with the same shape as a timeline event). RoomState
    // events are also re-emitted via RoomEvent.Timeline, so we can listen
    // there for both timeline and state events.
    room.on(RoomEvent.Timeline as any, async (event: MatrixEvent, _room: any) => {
      try {
        if (event.getType() !== 'org.matrix.msc3401.call.member') return;
        if (event.isState() === false) return; // only state events
        const roomId = room.roomId;
        const sender = event.getSender();
        const stateKey = event.getStateKey?.() ?? '';

        log.info({ roomId, sender, type: event.getType(), isState: event.isState(), stateKey, selfEvent: sender === BOT_USER_ID },
          '[state-listener] msc3401 state event observed');

        // Process events from any non-bot sender, including self-sent (which
        // are useful for synthetic testing). The state-listener's job is
        // to detect state TRANSITIONS, and it does that correctly even
        // for self-sent events.
        if (!sender) return;

        const content = event.getContent() as Record<string, any> | undefined;
        const prev = event.getPrevContent() as Record<string, any> | undefined;

        const hasFoci = !!(content && Array.isArray(content.foci_preferred) && content.foci_preferred[0]);
        const prevHadFoci = !!(prev && Array.isArray(prev.foci_preferred) && prev.foci_preferred[0]);

        // Dispatch on transition from no-call → call-active.
        if (hasFoci && !prevHadFoci) {
          const lkRoom = livekitRoomAliasForMatrixRoom(roomId);
          // Dedup key per (roomId, stateKey) — same call device won't double-dispatch,
          // but a new device or a hangup→call-cycle will.
          const callKey = `msc3401:${roomId}:${stateKey}`;
          if (activeCalls.has(callKey)) {
            log.info({ callKey, lkRoom }, '[state-listener] ignoring duplicate call start');
            return;
          }
          log.info({ callKey, sender, roomId, lkRoom, stateKey, type: 'org.matrix.msc3401.call.member' },
            '[state-listener] new call detected (no→active), dispatching LingLang agent');

          let dispatchId: string | undefined;
          try {
            const dispatch = await agentDispatch.createDispatch(lkRoom, AGENT_NAME);
            dispatchId = dispatch.id;
            log.info({ lkRoom, agent: AGENT_NAME, dispatchId }, '[state-listener] agent dispatched');
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn({ err: msg }, '[state-listener] createDispatch failed, falling back to room metadata');
            try {
              await roomService.updateRoomMetadata(lkRoom, JSON.stringify({ agent: AGENT_NAME }));
            } catch (err2: unknown) {
              const msg2 = err2 instanceof Error ? err2.message : String(err2);
              log.error({ err: msg2 }, '[state-listener] fallback updateRoomMetadata also failed');
            }
          }

          const callerToken = await mintUserToken(lkRoom, sender);
          const joinUrl = `${LIVEKIT_URL.replace('wss://', 'https://')}/rooms/${lkRoom}`;
          try {
            await client.sendEvent(roomId, 'm.room.message', {
              msgtype: 'm.notice',
              body: `📞 LingLang agent is joining the call.\n` +
                    `LiveKit room: ${lkRoom}\n` +
                    `Token: ${callerToken}\n` +
                    `Join URL: ${joinUrl}`,
            });
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn({ err: msg }, '[state-listener] failed to send notice (caller may not be in room)');
          }

          activeCalls.set(callKey, { lkRoom, callerMatrixId: sender, startedAt: Date.now(), dispatchId, stateKey });

          // SKIP publishing bot MSC3401 membership — it makes Element
          // render us as a second "linglang" participant (muted, no
          // tracks) which competes with the real agent in the LiveKit
          // room and confuses Element's WebRTC subscription. The agent
          // is the actual participant; Element will pick it up from the
          // LiveKit room's participant list via the focus_active state
          // the user already has.
          log.info({ roomId, lkRoom, sender },
            '[state-listener] NOT publishing bot MSC3401 membership (avoids duplicate muted participant)');
        }

        // Hangup: transition from active → no-call.
        if (!hasFoci && prevHadFoci) {
          const callKey = `msc3401:${roomId}:${stateKey}`;
          const active = activeCalls.get(callKey);
          if (!active) {
            log.info({ callKey, roomId, stateKey }, '[state-listener] hangup with no active call');
            return;
          }
          log.info({ callKey, lkRoom: active.lkRoom, duration_ms: Date.now() - active.startedAt },
            '[state-listener] hangup detected (active→no), closing LiveKit room');
          if (active.dispatchId) {
            try { await agentDispatch.deleteDispatch(active.dispatchId, active.lkRoom); }
            catch (err) { log.warn({ err: (err as Error).message }, 'deleteDispatch failed'); }
          }
          try { await roomService.deleteRoom(active.lkRoom); }
          catch (err) { log.warn({ err: (err as Error).message }, 'deleteRoom failed (room may already be closed)'); }
          activeCalls.delete(callKey);
        }
      } catch (err) {
        log.error({ err: (err as Error).message }, 'error in state-listener');
      }
    });
    log.info({ roomId: room.roomId }, '[state-listener] attached RoomStateEvent listener');
  }

  // Heartbeat log
  setInterval(() => {
    log.info({ active_calls: activeCalls.size }, 'bot alive');
  }, 60_000);

  log.info({ homeserver: HOMESERVER, bot: BOT_USER_ID, livekit: LIVEKIT_URL, agent: AGENT_NAME },
    'matrix call bot ready - waiting for calls');

  // Graceful shutdown
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, async () => {
      log.info({ sig, active: activeCalls.size }, 'shutting down');
      for (const [callId, active] of activeCalls) {
        if (active.dispatchId) {
          try { await agentDispatch.deleteDispatch(active.dispatchId, active.lkRoom); } catch {}
        }
        try { await roomService.deleteRoom(active.lkRoom); } catch {}
      }
      client.stopClient();
      process.exit(0);
    });
  }
}

main().catch((err: unknown) => {
  log.error({ err: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined },
    'fatal error');
  process.exit(1);
});
