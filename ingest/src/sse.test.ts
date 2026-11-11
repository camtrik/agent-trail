/**
 * SSE Connection Manager Tests
 *
 * Tests for createSSEManager: subscribe, emit, emitSessionEvent,
 * close, getStats, and shutdown.
 */
import { describe, it, expect } from 'vitest';
import { createSSEManager } from './sse';

function readStreamEvents(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const events: string[] = [];

  return new Promise((resolve) => {
    setTimeout(() => {
      reader.cancel();
      resolve(events);
    }, 100);
  });
}

describe('createSSEManager', () => {
  it('subscribe() returns stream and close function with unique listener IDs', () => {
    const manager = createSSEManager();
    const sub1 = manager.subscribe();
    const sub2 = manager.subscribe();

    expect(sub1.stream).toBeInstanceOf(ReadableStream);
    expect(typeof sub1.close).toBe('function');
    expect(sub2.stream).toBeInstanceOf(ReadableStream);
    expect(typeof sub2.close).toBe('function');

    // Verify initial connected event is sent
    sub1.close();
    sub2.close();
  });

  it('emit() delivers events to all global subscribers (sessionId=undefined)', async () => {
    const manager = createSSEManager();

    const events1: string[] = [];
    const events2: string[] = [];

    const sub1 = manager.subscribe(); // global
    const sub2 = manager.subscribe(); // global

    // Read from both streams
    const readStream = (
      stream: ReadableStream<Uint8Array>,
      collector: string[],
    ) => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      return reader.read().then(function process({ done, value }): Promise<void> | void {
        if (done) return;
        if (value) collector.push(decoder.decode(value));
        return reader.read().then(process);
      });
    };

    readStream(sub1.stream, events1);
    readStream(sub2.stream, events2);

    // Small delay then emit
    await new Promise((r) => setTimeout(r, 10));
    manager.emit('session_updated', { sessionId: 'abc' });

    // Let events propagate
    await new Promise((r) => setTimeout(r, 10));

    sub1.close();
    sub2.close();

    // Both global subscribers should have received the event
    const allEvents1 = events1.join('');
    const allEvents2 = events2.join('');

    expect(allEvents1).toContain('event: session_updated');
    expect(allEvents1).toContain('"sessionId":"abc"');
    expect(allEvents2).toContain('event: session_updated');
    expect(allEvents2).toContain('"sessionId":"abc"');
  });

  it('emitSessionEvent() delivers events ONLY to session-specific subscribers', async () => {
    const manager = createSSEManager();

    const globalEvents: string[] = [];
    const sessionEvents: string[] = [];
    const otherSessionEvents: string[] = [];

    const globalSub = manager.subscribe(); // global
    const sessionSub = manager.subscribe('abc');
    const otherSub = manager.subscribe('xyz');

    const readStream = (
      stream: ReadableStream<Uint8Array>,
      collector: string[],
    ) => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      return reader.read().then(function process({ done, value }): Promise<void> | void {
        if (done) return;
        if (value) collector.push(decoder.decode(value));
        return reader.read().then(process);
      });
    };

    readStream(globalSub.stream, globalEvents);
    readStream(sessionSub.stream, sessionEvents);
    readStream(otherSub.stream, otherSessionEvents);

    await new Promise((r) => setTimeout(r, 10));
    manager.emitSessionEvent('abc', 'turn_added', { turnIndex: 0 });

    await new Promise((r) => setTimeout(r, 10));

    globalSub.close();
    sessionSub.close();
    otherSub.close();

    const globalJoined = globalEvents.join('');
    const sessionJoined = sessionEvents.join('');
    const otherJoined = otherSessionEvents.join('');

    // Only 'abc' subscriber should receive the event
    expect(globalJoined).not.toContain('turn_added');
    expect(sessionJoined).toContain('event: turn_added');
    expect(sessionJoined).toContain('"turnIndex":0');
    expect(otherJoined).not.toContain('turn_added');
  });

  it('close() removes subscriber so it no longer receives events', async () => {
    const manager = createSSEManager();

    const events: string[] = [];
    const sub = manager.subscribe();

    const readStream = (
      stream: ReadableStream<Uint8Array>,
      collector: string[],
    ) => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      return reader.read().then(function process({ done, value }): Promise<void> | void {
        if (done) return;
        if (value) collector.push(decoder.decode(value));
        return reader.read().then(process);
      });
    };

    readStream(sub.stream, events);

    await new Promise((r) => setTimeout(r, 10));

    // Close before emitting
    sub.close();

    manager.emit('session_updated', { sessionId: 'test' });

    await new Promise((r) => setTimeout(r, 10));

    const allEvents = events.join('');

    // Should only contain the initial connected event, not the emitted one
    expect(allEvents).toContain('event: connected');
    expect(allEvents).not.toContain('session_updated');
  });

  it('getStats() returns subscriber counts', () => {
    const manager = createSSEManager();

    expect(manager.getStats().globalSubscribers).toBe(0);

    const sub1 = manager.subscribe(); // global
    const sub2 = manager.subscribe('abc');
    const sub3 = manager.subscribe('abc');

    const stats = manager.getStats();
    expect(stats.globalSubscribers).toBe(1);

    sub1.close();
    sub2.close();
    sub3.close();

    expect(manager.getStats().globalSubscribers).toBe(0);
  });

  it('shutdown() closes all active subscribers without errors', () => {
    const manager = createSSEManager();
    const sub1 = manager.subscribe();
    const sub2 = manager.subscribe('abc');
    const sub3 = manager.subscribe();

    expect(manager.getStats().globalSubscribers).toBe(2);

    // shutdown should not throw
    expect(() => manager.shutdown()).not.toThrow();

    // After shutdown, all subscribers should be gone
    expect(manager.getStats().globalSubscribers).toBe(0);
  });
});
