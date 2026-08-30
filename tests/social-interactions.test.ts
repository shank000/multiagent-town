import test from 'node:test';
import assert from 'node:assert/strict';
import { createManagedWorld } from '../src/engine/world-factory';
import { performSocialInteraction } from '../src/engine/social-interactions';

test('观察保持单向记忆，帮助形成双方记忆与可追溯关系证据', async () => {
  const managed = createManagedWorld('w3', 'rumor', { dbPath: ':memory:' });
  const [actor, target] = managed.world.allAgents();
  try {
    const observed = performSocialInteraction({
      kind: 'observe', actor, target, now: 20, log: managed.log, rels: managed.mind.rels,
    });
    await managed.mind.drain();
    assert.deepEqual(observed.payload?.memoryAgentIds, [actor.id]);
    assert.ok(managed.mind.store.recentMemories(actor.id, 20).some((memory) => memory.sourceEventId === observed.id));
    assert.ok(!managed.mind.store.recentMemories(target.id, 20).some((memory) => memory.sourceEventId === observed.id));
    assert.equal(managed.mind.rels.evidenceFor(actor.id, target.id).at(0)?.sourceKind, 'observation');
    assert.equal(managed.mind.rels.evidenceFor(target.id, actor.id).length, 0);

    const assisted = performSocialInteraction({
      kind: 'assist', actor, target, now: 30, log: managed.log, rels: managed.mind.rels,
    });
    await managed.mind.drain();
    assert.ok(managed.mind.store.recentMemories(actor.id, 20).some((memory) => memory.sourceEventId === assisted.id));
    assert.ok(managed.mind.store.recentMemories(target.id, 20).some((memory) => memory.sourceEventId === assisted.id));
    assert.equal(managed.mind.rels.evidenceFor(target.id, actor.id).at(0)?.sourceKind, 'assistance');
  } finally {
    await managed.mind.dispose();
    managed.db.raw.close();
  }
});
