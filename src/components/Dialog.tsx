import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { usePresence } from './use-presence';

const DialogDepth = createContext(0);
const DialogReturnFocus = createContext<HTMLElement | null>(null);
const activeDialogs = new Map<HTMLElement, { depth: number; order: number; focus: () => void }>();
const originalVisibility = new Map<Element, { inert: string | null; hidden: string | null }>();
let dialogOrder = 0;
function topDialog() {
  return [...activeDialogs].sort((a, b) => b[1].depth - a[1].depth || b[1].order - a[1].order)[0];
}
function updateBackground() {
  const top = topDialog()?.[0];
  const focused = document.activeElement instanceof HTMLElement && top?.contains(document.activeElement) ? document.activeElement : null;
  // Portal mount order can put an outer dialog after its child; align painting with focus order.
  if (top && document.body.lastElementChild !== top) document.body.append(top);
  if (top) for (const node of document.body.children) {
    if (!originalVisibility.has(node)) originalVisibility.set(node, { inert: node.getAttribute('inert'), hidden: node.getAttribute('aria-hidden') });
  }
  for (const [node, original] of originalVisibility) {
    if (top && node !== top) { node.setAttribute('inert', ''); node.setAttribute('aria-hidden', 'true'); }
    else {
      if (original.inert === null) node.removeAttribute('inert'); else node.setAttribute('inert', original.inert);
      if (original.hidden === null) node.removeAttribute('aria-hidden'); else node.setAttribute('aria-hidden', original.hidden);
    }
  }
  if (!top) originalVisibility.clear();
  if (focused?.isConnected) focused.focus();
}

export function Dialog({ children, labelledBy, describedBy, busy = false, open = true, returnFocus, onDismiss, className = '' }: {
  children: ReactNode;
  labelledBy: string;
  describedBy?: string;
  busy?: boolean;
  open?: boolean;
  returnFocus?: HTMLElement | null;
  onDismiss: () => void;
  className?: string;
}) {
  const [portal] = useState(() => document.createElement('div'));
  const depth = useContext(DialogDepth);
  const ancestorReturnFocus = useContext(DialogReturnFocus);
  const focusReturn = useRef<{ open: boolean; target: HTMLElement | null }>({ open: false, target: null });
  if (open && !focusReturn.current.open) focusReturn.current.target = returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  focusReturn.current.open = open;
  const rootReturnFocus = ancestorReturnFocus ?? focusReturn.current.target;
  const dialog = useRef<HTMLDivElement>(null);
  const options = useRef({ busy, onDismiss });
  options.current = { busy, onDismiss };
  const present = usePresence(open);

  useLayoutEffect(() => {
    if (!present) return;
    document.body.append(portal);
    return () => { portal.remove(); };
  }, [portal, present]);

  useLayoutEffect(() => {
    if (!open) return;
    const previousFocus = focusReturn.current.target;
    const focusable = () => [...(dialog.current?.querySelectorAll<HTMLElement>(
      'button, a[href], input, select, textarea, [tabindex]',
    ) ?? [])].filter(node => node.tabIndex >= 0 && !node.matches(':disabled') && !node.closest('[hidden], [inert], [aria-hidden="true"]'));
    const focusFirst = () => (focusable()[0] ?? dialog.current)?.focus();
    activeDialogs.set(portal, { depth, order: ++dialogOrder, focus: focusFirst });
    updateBackground();
    if (topDialog()?.[0] === portal) focusFirst();
    const onFocus = (event: FocusEvent) => {
      if (topDialog()?.[0] !== portal) return;
      if (event.target instanceof Node && !dialog.current?.contains(event.target)) focusFirst();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || topDialog()?.[0] !== portal) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        if (!options.current.busy) options.current.onDismiss();
      } else if (event.key === 'Tab') {
        const items = focusable();
        const current = items.indexOf(document.activeElement as HTMLElement);
        if (!items.length) { event.preventDefault(); dialog.current?.focus(); }
        else if (event.shiftKey && current <= 0) { event.preventDefault(); items.at(-1)?.focus(); }
        else if (!event.shiftKey && (current < 0 || current === items.length - 1)) { event.preventDefault(); items[0].focus(); }
      }
    };
    document.addEventListener('focusin', onFocus, true);
    // 下拉菜单等子控件先处理 Escape，避免关闭整张弹窗并丢失草稿。
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('focusin', onFocus, true);
      document.removeEventListener('keydown', onKey);
      activeDialogs.delete(portal);
      updateBackground();
      const top = topDialog();
      if (previousFocus?.isConnected && (!top || top[0].contains(previousFocus))) previousFocus.focus();
      else top?.[1].focus();
      if (!top && !previousFocus?.isConnected && rootReturnFocus?.isConnected) rootReturnFocus.focus();
    };
  }, [portal, open, depth, rootReturnFocus]);

  if (!present) return null;
  return createPortal(
    <div className="modal-backdrop" data-motion={open ? 'open' : 'closing'} role="presentation" inert={!open} aria-hidden={!open || undefined}>
      <div ref={dialog} className={`modal-card${className ? ` ${className}` : ''}`} role={open ? 'dialog' : undefined} aria-modal={open || undefined}
        aria-labelledby={labelledBy} aria-describedby={describedBy} aria-busy={busy} tabIndex={-1}>
        <DialogDepth.Provider value={depth + 1}><DialogReturnFocus.Provider value={rootReturnFocus}>{children}</DialogReturnFocus.Provider></DialogDepth.Provider>
      </div>
    </div>, portal,
  );
}
