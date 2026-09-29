/**
 * Tests for the voice-room mic preflight.
 *
 * The interesting cases are the failure modes — every one of them used to be
 * a silently connected room that ignored the learner, so each assertion here
 * is really "this failure is no longer invisible".
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { describeMicFailure, requestMicrophone, hasMicPermission } from './microphone';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function err(name: string): Error {
  const e = new Error(name);
  e.name = name;
  return e;
}

describe('describeMicFailure', () => {
  it('tells a blocked user how to unblock, not just that it failed', () => {
    const msg = describeMicFailure(err('NotAllowedError'));
    expect(msg).toMatch(/blocking the microphone/i);
    expect(msg).toMatch(/padlock/i);
  });

  it('distinguishes "no device" from "device busy"', () => {
    expect(describeMicFailure(err('NotFoundError'))).toMatch(/no microphone found/i);
    expect(describeMicFailure(err('NotReadableError'))).toMatch(/another app or tab/i);
  });

  it('names the unknown error so it can be reported', () => {
    expect(describeMicFailure(err('WeirdBrowserError'))).toMatch(/WeirdBrowserError/);
  });

  it('survives a non-Error rejection', () => {
    expect(describeMicFailure(undefined)).toMatch(/microphone/i);
    expect(describeMicFailure('nope')).toMatch(/microphone/i);
  });
});

describe('requestMicrophone', () => {
  it('releases the stream it only acquired to force the prompt', async () => {
    const stop = vi.fn();
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] });
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    vi.stubGlobal('window', { isSecureContext: true });

    await expect(requestMicrophone()).resolves.toBeNull();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('returns guidance instead of throwing when permission is denied', async () => {
    const getUserMedia = vi.fn().mockRejectedValue(err('NotAllowedError'));
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    vi.stubGlobal('window', { isSecureContext: true });

    await expect(requestMicrophone()).resolves.toMatch(/blocking the microphone/i);
  });

  it('explains the insecure-origin case, which is the silent self-host failure', async () => {
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('window', { isSecureContext: false });

    await expect(requestMicrophone()).resolves.toMatch(/secure connection/i);
  });

  it('explains unsupported-browser when the origin is fine', async () => {
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('window', { isSecureContext: true });

    await expect(requestMicrophone()).resolves.toMatch(/can’t access the microphone/i);
  });
});

describe('hasMicPermission', () => {
  it('is false rather than throwing when Permissions API is missing', async () => {
    vi.stubGlobal('navigator', {});
    await expect(hasMicPermission()).resolves.toBe(false);
  });

  it('reads the granted state', async () => {
    vi.stubGlobal('navigator', {
      permissions: { query: vi.fn().mockResolvedValue({ state: 'granted' }) },
    });
    await expect(hasMicPermission()).resolves.toBe(true);
  });
});
