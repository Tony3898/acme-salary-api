import { orderByManager } from '../../src/domain/importOrder';

/**
 * The insertion order, which exists so a manager's row is written before anybody
 * who reports to them and no UPDATE pass is needed to patch the column in
 * afterwards.
 */

const person = (email: string, managerEmail: string | null = null) => ({ email, managerEmail });

describe('orderByManager', () => {
  it('given nobody with a manager, when ordered, then everybody goes in one layer', () => {
    const rows = [person('a@x.test'), person('b@x.test')];

    const order = orderByManager(rows, new Set());

    expect(order.layers).toEqual([rows]);
    expect(order.missingManager).toEqual([]);
    expect(order.cyclic).toEqual([]);
  });

  it('given a chain listed in reverse, when ordered, then each manager comes before their report', () => {
    /* The case the ordering exists for. A spreadsheet has no reason to be sorted by
       seniority, and this one is sorted against it. */
    const deepest = person('deepest@x.test', 'deep@x.test');
    const deep = person('deep@x.test', 'lead@x.test');
    const lead = person('lead@x.test');

    const order = orderByManager([deepest, deep, lead], new Set());

    expect(order.layers).toEqual([[lead], [deep], [deepest]]);
  });

  it('given a manager who is already in the database, when ordered, then their reports go in the first layer', () => {
    const order = orderByManager(
      [person('new@x.test', 'existing@x.test')],
      new Set(['existing@x.test']),
    );

    expect(order.layers).toHaveLength(1);
    expect(order.missingManager).toEqual([]);
  });

  it('given a manager who is nowhere, when ordered, then that row is reported rather than placed', () => {
    const orphan = person('new@x.test', 'nobody@x.test');

    const order = orderByManager([orphan, person('root@x.test')], new Set());

    expect(order.missingManager).toEqual([orphan]);
    expect(order.layers).toEqual([[person('root@x.test')]]);
  });

  it('given two people who manage each other, when ordered, then the cycle is reported rather than broken', () => {
    /* Not resolved by picking one to sever: the file describes something impossible,
       and importing an arbitrary half of it would create a hierarchy nobody wrote. */
    const first = person('a@x.test', 'b@x.test');
    const second = person('b@x.test', 'a@x.test');

    const order = orderByManager([first, second], new Set());

    expect(order.cyclic).toEqual([first, second]);
    expect(order.layers).toEqual([]);
  });

  it('given a cycle alongside a valid chain, when ordered, then the chain is still placed', () => {
    const cycleA = person('ca@x.test', 'cb@x.test');
    const cycleB = person('cb@x.test', 'ca@x.test');
    const root = person('root@x.test');
    const report = person('report@x.test', 'root@x.test');

    const order = orderByManager([cycleA, root, cycleB, report], new Set());

    expect(order.layers).toEqual([[root], [report]]);
    expect(order.cyclic).toEqual([cycleA, cycleB]);
  });

  it('given a three-way cycle, when ordered, then all three are reported', () => {
    const rows = [
      person('a@x.test', 'c@x.test'),
      person('b@x.test', 'a@x.test'),
      person('c@x.test', 'b@x.test'),
    ];

    expect(orderByManager(rows, new Set()).cyclic).toEqual(rows);
  });

  it('given a wide chain, when ordered, then the layer count is the depth and not the headcount', () => {
    /* Why layers rather than a flat order: each layer is one INSERT, so the number
       of statements follows the depth of the reporting chain — about seven for a
       real company — rather than the number of people. */
    const rows = [
      person('lead@x.test'),
      ...Array.from({ length: 100 }, (_unused, index) =>
        person(`r${String(index)}@x.test`, 'lead@x.test'),
      ),
    ];

    const order = orderByManager(rows, new Set());

    expect(order.layers).toHaveLength(2);
    expect(order.layers[1]).toHaveLength(100);
  });
});
