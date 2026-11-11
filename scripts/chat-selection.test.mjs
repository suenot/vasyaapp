import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFloodWait } from '../src/utils/floodWait.ts';
import { useChatSelectionStore, isBulkLeavable } from '../src/store/chatSelectionStore.ts';

const s = () => useChatSelectionStore.getState();
test.beforeEach(() => s().exit());

test('toggle and anchor', () => {
  s().enter();
  s().toggle(2);
  s().toggle(5);
  s().toggle(2);
  assert.deepEqual([...s().ids], [5]);
});

test('shift range selects between anchor and target, either direction', () => {
  const order = [10, 11, 12, 13, 14];
  s().enter(11);
  s().rangeTo(order, 13);
  assert.deepEqual([...s().ids].sort(), [11, 12, 13]);
  s().rangeTo(order, 10);
  assert.deepEqual([...s().ids].sort(), [10, 11, 12, 13]);
});

test('range without a usable anchor falls back to toggle', () => {
  s().enter();
  s().rangeTo([1, 2, 3], 2);
  assert.deepEqual([...s().ids], [2]);
});

test('remove, clear and exit', () => {
  s().enter(1);
  s().selectMany([2, 3]);
  s().remove([2]);
  assert.deepEqual([...s().ids].sort(), [1, 3]);
  s().exit();
  assert.equal(s().active, false);
  assert.equal(s().ids.size, 0);
});

test('only channels and groups are bulk-leavable', () => {
  assert.ok(isBulkLeavable('channel') && isBulkLeavable('group'));
  assert.ok(!isBulkLeavable('user') && !isBulkLeavable(undefined));
});

test('parses FLOOD_WAIT seconds, caps them, ignores other errors', () => {
  assert.equal(parseFloodWait('Failed to leave: FLOOD_WAIT caused by x (value: 30)'), 30);
  assert.equal(parseFloodWait('rpc error 420: FLOOD_WAIT_12'), 12);
  assert.equal(parseFloodWait('FLOOD_WAIT (value: 99999)'), 600);
  assert.equal(parseFloodWait('FLOOD_WAIT'), 30);
  assert.equal(parseFloodWait('CHANNEL_PRIVATE'), null);
});
