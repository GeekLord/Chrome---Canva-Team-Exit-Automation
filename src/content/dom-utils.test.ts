// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';

import { ActionError } from '../shared/errors';
import { mountItemMenu, mountProjectListing, resetDom } from '../testing/selector-mocks';
import {
  accessibleName,
  Deadline,
  describeSpecFailure,
  jitteredDelay,
  nameMatches,
  normalizeText,
  rawText,
  resolve,
  resolveAll,
  waitForValue,
} from './dom-utils';
import { SELECTORS, type SelectorSpec } from './selector-map';

afterEach(resetDom);

describe('text helpers', () => {
  it('normalises whitespace and case for matching', () => {
    expect(normalizeText('  Copy   To Another Team \n')).toBe('copy to another team');
    expect(normalizeText(null)).toBe('');
  });

  it('preserves case for anything shown to the user', () => {
    const node = document.createElement('div');
    node.textContent = '  Quarterly   Report ';
    expect(rawText(node)).toBe('Quarterly Report');
  });

  it('matches names by substring, or exactly when asked', () => {
    expect(nameMatches('Move to trash', ['trash'])).toBe(true);
    expect(nameMatches('Move to trash', ['trash'], true)).toBe(false);
    expect(nameMatches('Move to trash', ['move to trash'], true)).toBe(true);
    expect(nameMatches('', ['trash'])).toBe(false);
  });

  it('reads an accessible name from aria-label, aria-labelledby, title, then text', () => {
    const labelled = document.createElement('button');
    labelled.setAttribute('aria-label', 'More actions');
    expect(accessibleName(labelled)).toBe('more actions');

    const target = document.createElement('button');
    const description = document.createElement('span');
    description.id = 'desc-1';
    description.textContent = 'Copy to another team';
    document.body.append(description, target);
    target.setAttribute('aria-labelledby', 'desc-1');
    expect(accessibleName(target)).toBe('copy to another team');

    const titled = document.createElement('button');
    titled.setAttribute('title', 'Quarterly report');
    expect(accessibleName(titled)).toBe('quarterly report');

    const plain = document.createElement('button');
    plain.textContent = 'Leave team';
    expect(accessibleName(plain)).toBe('leave team');
  });
});

describe('selector resolution', () => {
  it('resolves through the first candidate that matches', () => {
    mountItemMenu(['Copy to another team', 'Move to trash']);
    const match = resolve(SELECTORS.itemMenuCopyToTeam);

    expect(match).not.toBeNull();
    expect(match?.candidateIndex).toBe(0);
    expect(rawText(match!.element)).toBe('Copy to another team');
  });

  it('falls back to a later candidate when the earlier ones miss', () => {
    // The entry is not a clickable role, so the text candidate cannot see it.
    // Only the label candidate, which looks at declared names, can.
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    const entry = document.createElement('div');
    entry.setAttribute('aria-label', 'Copy to another team');
    menu.append(entry);
    document.body.append(menu);

    const match = resolve(SELECTORS.itemMenuCopyToTeam);
    expect(match?.candidateIndex).toBe(1);
    expect(match?.candidate.strategy).toBe('label');
    expect(match?.element).toBe(entry);
  });

  it('does not let a container stand in for the control inside it', () => {
    // The menu container's text contains the wording, but it declares no name of
    // its own, so the label candidate must not match it.
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    const entry = document.createElement('span');
    entry.textContent = 'Move to trash';
    menu.append(entry);
    document.body.append(menu);

    expect(resolve(SELECTORS.itemMenuMoveToTrash)).toBeNull();
  });

  it('returns null when no candidate matches', () => {
    mountItemMenu(['Rename', 'Duplicate']);
    expect(resolve(SELECTORS.itemMenuCopyToTeam)).toBeNull();
  });

  it('prefers the most specific match when several elements contain the wording', () => {
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    const wrapper = document.createElement('div');
    wrapper.setAttribute('role', 'menuitem');
    const inner = document.createElement('span');
    inner.setAttribute('role', 'button');
    inner.textContent = 'Move to trash';
    wrapper.append(document.createTextNode('Extra chrome text '), inner);
    menu.append(wrapper);
    document.body.append(menu);

    const match = resolve(SELECTORS.itemMenuMoveToTrash);
    expect(match?.element).toBe(inner);
  });

  it('narrows by a runtime name, for example the destination workspace', () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    for (const name of ['Design Studio', 'Personal', 'Client work']) {
      const option = document.createElement('button');
      option.setAttribute('role', 'option');
      option.textContent = name;
      dialog.append(option);
    }
    document.body.append(dialog);

    const match = resolve(SELECTORS.copyDialogDestinationOption, { root: dialog, name: ['Personal'] });
    expect(rawText(match!.element)).toBe('Personal');

    expect(resolve(SELECTORS.copyDialogDestinationOption, { root: dialog, name: ['Nowhere'] })).toBeNull();
  });

  it('skips elements hidden with aria-hidden', () => {
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    const entry = document.createElement('button');
    entry.setAttribute('role', 'menuitem');
    entry.setAttribute('aria-hidden', 'true');
    entry.textContent = 'Move to trash';
    menu.append(entry);
    document.body.append(menu);

    expect(resolve(SELECTORS.itemMenuMoveToTrash)).toBeNull();
  });

  it('survives a malformed candidate selector instead of throwing', () => {
    const broken: SelectorSpec = {
      key: 'broken',
      purpose: 'test',
      candidates: [{ description: 'nonsense', strategy: 'css', value: '::::' }],
    };
    expect(resolve(broken)).toBeNull();
  });

  it('lists every card when resolving all matches', () => {
    mountProjectListing([{ title: 'One', designId: 'DAF1' }, { title: 'Two', designId: 'DAF2' }]);
    expect(resolveAll(SELECTORS.projectItemCard)).toHaveLength(2);
  });
});

describe('selector diagnostics', () => {
  it('reports per-candidate hit counts so a break is traceable', () => {
    mountItemMenu(['Rename']);
    const description = describeSpecFailure(SELECTORS.itemMenuCopyToTeam);

    expect(description).toContain('spec=itemMenuCopyToTeam');
    expect(description).toContain('#0 text');
    expect(description).toContain('0 match(es)');
    expect(description).toContain('purpose=');
  });

  it('includes the runtime name when one was used', () => {
    const description = describeSpecFailure(SELECTORS.copyDialogDestinationOption, { name: ['Personal'] });
    expect(description).toContain('runtimeName=[Personal]');
  });
});

describe('waiting', () => {
  it('returns as soon as the probe produces a value', async () => {
    let calls = 0;
    const value = await waitForValue(
      () => {
        calls += 1;
        return calls >= 2 ? 'ready' : null;
      },
      { deadline: new Deadline(2000), intervalMs: 5, description: 'the thing' },
    );
    expect(value).toBe('ready');
  });

  it('throws a categorised ActionError on timeout', async () => {
    await expect(
      waitForValue(() => null, {
        deadline: new Deadline(20),
        intervalMs: 5,
        description: 'a dialog',
        category: 'dialog_not_opened',
      }),
    ).rejects.toMatchObject({ name: 'ActionError', category: 'dialog_not_opened' });
  });

  it('defaults a timeout to a selector problem', async () => {
    const error = await waitForValue(() => null, {
      deadline: new Deadline(10),
      intervalMs: 5,
      description: 'a control',
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ActionError);
    expect((error as ActionError).category).toBe('selector_not_found');
    expect((error as ActionError).message).toContain('a control');
  });
});

describe('pacing helpers', () => {
  it('keeps a deadline inside its parent budget', () => {
    const parent = new Deadline(1000);
    expect(parent.slice(5000).remainingMs).toBeLessThanOrEqual(parent.remainingMs);
    expect(new Deadline(0).expired).toBe(true);
  });

  it('adds jitter without going below the base delay', () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const delay = jitteredDelay(1000, 500);
      expect(delay).toBeGreaterThanOrEqual(1000);
      expect(delay).toBeLessThanOrEqual(1500);
    }
    expect(jitteredDelay(1000, 0)).toBe(1000);
  });
});
