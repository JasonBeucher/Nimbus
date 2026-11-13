import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openWatchedStore } from './watched.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'nimbus-watched-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = pathToFileURL(join(directory, '.watched.json'));
  return { file, store: await openWatchedStore(file) };
}

test('external watched status survives reopening and can be removed', async (t) => {
  const { file, store } = await fixture(t);
  assert.equal(store.has('alice', 'movie', 42), false);
  await store.set('alice', 'movie', 42, true);
  const reopened = await openWatchedStore(file);
  assert.equal(reopened.has('alice', 'movie', '42'), true);
  await reopened.set('alice', 'movie', '42', false);
  assert.equal((await openWatchedStore(file)).has('alice', 'movie', 42), false);
});

test('film and series identities and Jellyfin users remain independent', async (t) => {
  const { store } = await fixture(t);
  await store.set('alice', 'movie', 42, true);
  assert.equal(store.has('alice', 'tv', 42), false);
  assert.equal(store.has('bob', 'movie', 42), false);
  await store.set('alice', 'tv', 42, true);
  await store.set('bob', 'movie', 42, true);
  await store.set('alice', 'movie', 42, false);
  assert.equal(store.has('alice', 'tv', 42), true);
  assert.equal(store.has('bob', 'movie', 42), true);
});

test('simultaneous updates are persisted without losing titles', async (t) => {
  const { file, store } = await fixture(t);
  await Promise.all([
    store.set('alice', 'movie', 42, true),
    store.set('alice', 'tv', 43, true),
    store.set('alice', 'movie', 42, false),
    store.set('bob', 'tv', 44, true),
  ]);
  const reopened = await openWatchedStore(file);
  assert.equal(reopened.has('alice', 'movie', 42), false);
  assert.equal(reopened.has('alice', 'tv', 43), true);
  assert.equal(reopened.has('bob', 'tv', 44), true);
});

test('a failed save leaves the current status intact and allows a retry', async (t) => {
  const { file, store } = await fixture(t);
  await store.set('alice', 'movie', 42, true);
  const temporary = new URL(`${file.href}.tmp`);
  await mkdir(temporary);
  await assert.rejects(store.set('alice', 'movie', 42, false));
  assert.equal(store.has('alice', 'movie', 42), true);
  await rm(temporary, { recursive: true });
  await store.set('alice', 'movie', 42, false);
  assert.equal((await openWatchedStore(file)).has('alice', 'movie', 42), false);
});
