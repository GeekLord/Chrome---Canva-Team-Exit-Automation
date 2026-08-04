// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';

import { makeItem } from '../testing/fixtures';
import { mountProjectListing, resetDom } from '../testing/selector-mocks';
import { cardMenuTrigger, collectItemCards, describeCard, findCardByTitle, findCardForItem } from './item-cards';

afterEach(resetDom);

describe('collectItemCards', () => {
  it('reads title, url, design id and owner from each card', () => {
    mountProjectListing([{ title: 'Quarterly report', designId: 'DAFaaa111', owner: 'You' }]);

    const cards = collectItemCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      title: 'Quarterly report',
      designId: 'DAFaaa111',
      ownerLabel: 'You',
      ownerConfidence: 'high',
      itemType: 'design',
    });
    expect(cards[0]?.url).toContain('/design/DAFaaa111/');
  });

  it('reads a title carried in an aria-label', () => {
    mountProjectListing([{ title: 'Poster v2', designId: 'DAFaaa222', titleAsAriaLabel: true }]);
    expect(collectItemCards()[0]?.title).toBe('Poster v2');
  });

  it('marks ownership as low confidence for someone else, unknown when absent', () => {
    mountProjectListing([
      { title: 'Theirs', designId: 'DAFaaa001', owner: 'Alex Chen' },
      { title: 'Nameless', designId: 'DAFaaa002' },
    ]);

    const cards = collectItemCards();
    expect(cards.find((card) => card.title === 'Theirs')?.ownerConfidence).toBe('low');
    expect(cards.find((card) => card.title === 'Nameless')?.ownerConfidence).toBe('unknown');
  });

  it('deduplicates cards that the virtual list rendered twice', () => {
    mountProjectListing([
      { title: 'Same design', designId: 'DAFaaa999' },
      { title: 'Same design', designId: 'DAFaaa999' },
    ]);
    expect(collectItemCards()).toHaveLength(1);
  });

  it('deduplicates by design id even when the titles differ', () => {
    mountProjectListing([
      { title: 'Old title', designId: 'DAFaaa777' },
      { title: 'New title', designId: 'DAFaaa777' },
    ]);
    expect(collectItemCards()).toHaveLength(1);
  });

  it('finds the overflow menu control on a card', () => {
    mountProjectListing([{ title: 'One', designId: 'DAFaaa001', menuLabel: 'More options' }]);
    const card = collectItemCards()[0]!;
    const trigger = cardMenuTrigger(card);

    expect(trigger).not.toBeNull();
    expect(trigger?.getAttribute('aria-label')).toBe('More options');
  });

  it('describes a card for diagnostics without throwing', () => {
    mountProjectListing([{ title: 'One', designId: 'DAFaaa001', owner: 'You' }]);
    const description = describeCard(collectItemCards()[0]!);
    expect(description).toContain('designId=DAFaaa001');
    expect(description).toContain('owner="You"');
  });

  it('ignores a link whose id is too short to be a Canva design id', () => {
    mountProjectListing([{ title: 'Odd link', designId: 'AB1' }]);
    const cards = collectItemCards();
    expect(cards[0]?.designId).toBeNull();
    expect(cards[0]?.title).toBe('Odd link');
  });
});

describe('locating a known item again', () => {
  it('prefers the design id over the title', () => {
    mountProjectListing([
      { title: 'Renamed since discovery', designId: 'DAF00000001' },
      { title: 'Quarterly report', designId: 'DAFsomethingelse' },
    ]);

    const found = findCardForItem(makeItem());
    expect(found?.designId).toBe('DAF00000001');
  });

  it('falls back to an exact title match when there is no id', () => {
    mountProjectListing([{ title: 'Quarterly report', designId: 'DAFother' }]);
    const item = makeItem({ sourceUrl: null });
    expect(findCardForItem(item)?.title).toBe('Quarterly report');
  });

  it('returns null when the item is not in the listing', () => {
    mountProjectListing([{ title: 'Something else', designId: 'DAFzzz' }]);
    expect(findCardForItem(makeItem({ sourceUrl: null }))).toBeNull();
  });
});

describe('destination title search used by verification', () => {
  it('reports an exact match', () => {
    mountProjectListing([{ title: 'Quarterly report', designId: 'DAFcopy' }]);
    expect(findCardByTitle('Quarterly report')).toMatchObject({ exact: true });
  });

  it('reports a near match separately', () => {
    mountProjectListing([{ title: 'Quarterly report (copy)', designId: 'DAFcopy' }]);
    const found = findCardByTitle('Quarterly report');
    expect(found?.exact).toBe(false);
    expect(found?.card.title).toBe('Quarterly report (copy)');
  });

  it('reports nothing for an empty title or a missing design', () => {
    mountProjectListing([{ title: 'Unrelated', designId: 'DAF1' }]);
    expect(findCardByTitle('')).toBeNull();
    expect(findCardByTitle('Quarterly report')).toBeNull();
  });
});
