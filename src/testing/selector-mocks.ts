/**
 * Minimal stand-ins for Canva's DOM, used to test selector fallback resolution
 * without pretending to reproduce Canva's real markup.
 */

export interface MockCardInput {
  title: string;
  designId?: string;
  owner?: string;
  menuLabel?: string;
  /** Render the title in an aria-label instead of a heading. */
  titleAsAriaLabel?: boolean;
}

export function mountProjectListing(cards: readonly MockCardInput[]): HTMLElement {
  document.body.replaceChildren();

  const main = document.createElement('main');
  const grid = document.createElement('div');
  grid.setAttribute('role', 'grid');

  for (const card of cards) {
    grid.append(buildCard(card));
  }

  main.append(grid);
  document.body.append(main);
  return grid;
}

function buildCard(input: MockCardInput): HTMLElement {
  const cell = document.createElement('div');
  cell.setAttribute('role', 'gridcell');

  const link = document.createElement('a');
  link.href = `https://www.canva.com/design/${input.designId ?? 'DAFmock123'}/edit`;
  if (input.titleAsAriaLabel) {
    link.setAttribute('aria-label', input.title);
  } else {
    const heading = document.createElement('div');
    heading.setAttribute('role', 'heading');
    heading.textContent = input.title;
    link.append(heading);
  }
  cell.append(link);

  if (input.owner) {
    const owner = document.createElement('span');
    owner.setAttribute('data-testid', 'owner-name');
    owner.textContent = input.owner;
    cell.append(owner);
  }

  const menu = document.createElement('button');
  menu.setAttribute('aria-label', input.menuLabel ?? 'More actions');
  menu.setAttribute('aria-haspopup', 'menu');
  cell.append(menu);

  return cell;
}

/** An open item menu containing the given entry labels. */
export function mountItemMenu(entries: readonly string[]): HTMLElement {
  const menu = document.createElement('div');
  menu.setAttribute('role', 'menu');

  for (const entry of entries) {
    const item = document.createElement('button');
    item.setAttribute('role', 'menuitem');
    item.textContent = entry;
    menu.append(item);
  }

  document.body.append(menu);
  return menu;
}

export function mountToast(text: string, role: 'status' | 'alert' = 'status'): HTMLElement {
  const toast = document.createElement('div');
  toast.setAttribute('role', role);
  toast.textContent = text;
  document.body.append(toast);
  return toast;
}

export function mountWorkspaceSwitcher(entries: readonly { label: string; href?: string; current?: boolean }[]): HTMLElement {
  document.body.replaceChildren();

  const trigger = document.createElement('button');
  trigger.setAttribute('aria-label', 'Switch team');
  document.body.append(trigger);

  const menu = document.createElement('div');
  menu.setAttribute('role', 'menu');

  for (const entry of entries) {
    const option = document.createElement('a');
    option.setAttribute('role', 'menuitem');
    option.textContent = entry.label;
    if (entry.href) option.setAttribute('href', entry.href);
    if (entry.current) option.setAttribute('aria-current', 'true');
    menu.append(option);
  }

  document.body.append(menu);
  return menu;
}

export function resetDom(): void {
  document.body.replaceChildren();
}
