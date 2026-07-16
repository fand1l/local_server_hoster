/**
 * Мінімалістичний DOM-хелпер замість фреймворка: el('div', {...}, ...children).
 * Достатньо для панелі, нуль залежностей, повна типізація тегів.
 */

export type Child = Node | string | null | undefined | false;

type EventName = 'click' | 'submit' | 'input' | 'change' | 'keydown';
type EventProps = {
  [K in EventName as `on${Capitalize<K>}`]?: (event: Event) => void;
};

export interface ElProps extends EventProps {
  class?: string;
  id?: string;
  text?: string;
  title?: string;
  type?: string;
  value?: string;
  placeholder?: string;
  name?: string;
  href?: string;
  target?: string;
  rel?: string;
  for?: string;
  min?: string;
  max?: string;
  step?: string;
  list?: string;
  required?: boolean;
  disabled?: boolean;
  checked?: boolean;
  selected?: boolean;
  spellcheck?: string;
  autocomplete?: string;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElProps = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;

    if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === 'class') {
      node.className = value as string;
    } else if (key === 'text') {
      node.textContent = value as string;
    } else if (key === 'value' && 'value' in node) {
      (node as HTMLInputElement).value = value as string;
    } else if (key === 'checked' && 'checked' in node) {
      (node as HTMLInputElement).checked = true;
    } else if (key === 'selected' && 'selected' in node) {
      (node as HTMLOptionElement).selected = true;
    } else if (key === 'disabled' && 'disabled' in node) {
      (node as HTMLButtonElement).disabled = true;
    } else if (value === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(value));
    }
  }

  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(child));
  }
  return node;
}

/** Очищає контейнер і монтує в нього нові вузли. */
export function mount(container: HTMLElement, ...nodes: Child[]): void {
  container.replaceChildren();
  for (const node of nodes) {
    if (node === null || node === undefined || node === false) continue;
    container.append(node instanceof Node ? node : document.createTextNode(node));
  }
}
