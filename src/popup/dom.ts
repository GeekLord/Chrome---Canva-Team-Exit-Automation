/** Small DOM helpers shared by the popup and options pages. */

export function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

export interface ElementOptions {
  text?: string;
  className?: string;
  attrs?: Record<string, string | number | boolean | null>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
  children: readonly (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  for (const [name, value] of Object.entries(options.attrs ?? {})) {
    if (value === null || value === false) continue;
    node.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of children) {
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node: HTMLElement): void {
  node.replaceChildren();
}

export function setHidden(node: HTMLElement, hidden: boolean): void {
  node.hidden = hidden;
}

export type Tone = 'ok' | 'warn' | 'error' | 'plain';

export interface KeyValueEntry {
  label: string;
  value: string;
  tone?: Tone;
}

/** Fills a definition list, replacing whatever was there. */
export function renderKeyValues(list: HTMLElement, entries: readonly KeyValueEntry[]): void {
  clear(list);
  for (const entry of entries) {
    list.append(el('dt', { text: entry.label }));
    list.append(
      el('dd', {
        text: entry.value,
        attrs: entry.tone && entry.tone !== 'plain' ? { 'data-tone': entry.tone } : {},
      }),
    );
  }
}

export interface CheckboxOptions {
  id: string;
  label: string;
  sublabel?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}

export function checkboxRow(options: CheckboxOptions): HTMLLabelElement {
  const input = el('input', {
    attrs: { type: 'checkbox', id: options.id, ...(options.disabled ? { disabled: true } : {}) },
  });
  input.checked = options.checked;
  input.addEventListener('change', () => options.onChange(input.checked));

  const text = el('span', {}, [options.label]);
  if (options.sublabel) text.append(el('span', { className: 'sub', text: options.sublabel }));

  const label = el('label', { attrs: { for: options.id } });
  label.append(input, text);
  return label;
}

export function button(options: {
  label: string;
  onClick: () => void;
  className?: string;
  disabled?: boolean;
  title?: string;
}): HTMLButtonElement {
  const node = el('button', {
    text: options.label,
    className: options.className ?? 'btn',
    attrs: {
      type: 'button',
      ...(options.disabled ? { disabled: true } : {}),
      ...(options.title ? { title: options.title } : {}),
    },
  });
  node.addEventListener('click', options.onClick);
  return node;
}

export function flag(text: string, tone: Tone = 'plain'): HTMLSpanElement {
  return el('span', {
    className: 'flag',
    text,
    attrs: tone === 'plain' ? {} : { 'data-tone': tone },
  });
}
