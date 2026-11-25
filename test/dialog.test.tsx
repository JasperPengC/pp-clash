// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Dialog } from '../src/components/Dialog';
import { Select } from '../src/components/ui';

let root: Root;
let host: HTMLDivElement;
let opener: HTMLButtonElement;
const dismiss = vi.fn();
async function render(open = true, busy = false) {
  await act(async () => root.render(open ? createElement(Dialog, {
    labelledBy: 'test-title', onDismiss: dismiss, busy,
    children: createElement('div', {},
      createElement('h2', { id: 'test-title' }, '确认操作'),
      createElement('button', { id: 'cancel', disabled: busy }, '取消'),
      createElement('button', { id: 'confirm', disabled: busy }, '确认')),
  }) : null));
}
function key(value: string, shiftKey = false) {
  document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: value, shiftKey, bubbles: true, cancelable: true }));
}
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  dismiss.mockReset();
  host = document.createElement('div');
  opener = document.createElement('button'); opener.textContent = '开启 TUN';
  document.body.append(opener, host); root = createRoot(host); opener.focus();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); opener.remove(); });

it('初始焦点落在取消，Tab 循环，背景不能接收焦点，关闭恢复触发按钮', async () => {
  await render();
  const cancel = document.getElementById('cancel')!;
  const confirm = document.getElementById('confirm')!;
  expect(document.activeElement).toBe(cancel);
  expect(host.hasAttribute('inert')).toBe(true);
  expect(host.getAttribute('aria-hidden')).toBe('true');
  key('Tab', true); expect(document.activeElement).toBe(confirm);
  key('Tab'); expect(document.activeElement).toBe(cancel);
  opener.focus(); expect(document.activeElement).toBe(cancel);
  await render(false);
  expect(document.activeElement).toBe(opener);
  expect(host.hasAttribute('inert')).toBe(false);
  expect(host.hasAttribute('aria-hidden')).toBe(false);
});

it('Escape 仅在非忙碌时取消，忙碌时焦点仍被保留', async () => {
  await render(); key('Escape'); expect(dismiss).toHaveBeenCalledTimes(1);
  await render(true, true); key('Escape'); expect(dismiss).toHaveBeenCalledTimes(1);
  key('Tab'); expect(document.activeElement?.getAttribute('role')).toBe('dialog');
  await render(true, false); key('Escape'); expect(dismiss).toHaveBeenCalledTimes(2);
});

it('嵌套弹窗只由顶层处理焦点与Escape，忙碌时保留两层', async () => {
  const innerDismiss = vi.fn();
  const show = (busy: boolean, inner = true) => act(async () => root.render(<Dialog labelledBy="outer-title" onDismiss={dismiss}>
    <button id="outer-title">外层</button>
    {inner && <Dialog labelledBy="inner-title" busy={busy} onDismiss={innerDismiss}><button id="inner-title" disabled={busy}>内层</button></Dialog>}
  </Dialog>));
  await show(false, false);
  await show(true);
  expect(document.activeElement?.getAttribute('aria-labelledby')).toBe('inner-title');
  key('Escape');
  expect(dismiss).not.toHaveBeenCalled();
  expect(innerDismiss).not.toHaveBeenCalled();
  await show(false);
  document.getElementById('inner-title')!.focus();
  key('Escape');
  expect(innerDismiss).toHaveBeenCalledTimes(1);
  expect(dismiss).not.toHaveBeenCalled();
  await show(false, false);
  expect(document.activeElement?.id).toBe('outer-title');
  key('Escape');
  expect(dismiss).toHaveBeenCalledTimes(1);
});

it('同时挂载两层时顶层门户最后绘制，键盘与点击层级一致', async () => {
  const show = (inner = true) => act(async () => root.render(<Dialog labelledBy="outer" onDismiss={dismiss}>
    <button id="outer">外层</button>
    {inner && <Dialog labelledBy="inner" onDismiss={dismiss}><button id="inner">内层</button></Dialog>}
  </Dialog>));
  await show();
  const top = document.getElementById('inner')!.closest('[role="dialog"]')!;
  expect(document.body.lastElementChild?.contains(top)).toBe(true);
  expect(document.body.lastElementChild?.hasAttribute('inert')).toBe(false);
  expect(document.getElementById('outer')!.closest('[inert]')).not.toBeNull();
  expect(document.activeElement?.id).toBe('inner');
  await show(false);
  await show();
  await render(false);
  expect(document.activeElement).toBe(opener);
});

it('Dialog 声明模态与描述，Escape 关闭后恢复原触发器', async () => {
  await act(async () => root.render(createElement(Dialog, {
    labelledBy: 'label', describedBy: 'description', onDismiss: () => void render(false),
    children: createElement('div', {}, createElement('h2', { id: 'label' }, '确认'),
      createElement('p', { id: 'description' }, '操作说明'), createElement('button', {}, '取消')),
  })));
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.getAttribute('aria-modal')).toBe('true');
  expect(dialog.getAttribute('aria-labelledby')).toBe('label');
  expect(dialog.getAttribute('aria-describedby')).toBe('description');
  await act(async () => key('Escape'));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(opener);
});

it('弹窗中的选择器门户归属 Dialog，选项能接收焦点并回到触发器', async () => {
  const change = vi.fn();
  await act(async () => root.render(createElement(Dialog, {
    labelledBy: 'select-dialog-title', onDismiss: dismiss,
    children: createElement('div', {}, createElement('h2', { id: 'select-dialog-title' }, '选择订阅'),
      createElement(Select, { value: 'a', options: [{ value: 'a', label: '甲' }, { value: 'b', label: '乙' }], onChange: change, ariaLabel: '订阅' })),
  })));
  const trigger = document.querySelector<HTMLButtonElement>('.select-btn')!;
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })));
  const listbox = document.querySelector('[role="listbox"]')!;
  expect(listbox.closest('[role="dialog"]')).not.toBeNull();
  expect(document.activeElement?.getAttribute('role')).toBe('option');
  await act(async () => (listbox.querySelectorAll('button')[1] as HTMLButtonElement).click());
  expect(change).toHaveBeenCalledExactlyOnceWith('b');
  expect(document.activeElement).toBe(trigger);
});

it('关闭时恢复背景原先的 aria-hidden 与 inert 状态', async () => {
  host.setAttribute('aria-hidden', 'false'); host.setAttribute('inert', '');
  await render(); await render(false);
  expect(host.getAttribute('aria-hidden')).toBe('false');
  expect(host.hasAttribute('inert')).toBe(true);
});

it('退出保留画面时立即恢复焦点，快速重开不会被旧计时器移除', async () => {
  vi.useFakeTimers();
  const show = async (open: boolean) => act(async () => root.render(createElement(Dialog, {
    open, labelledBy: 'motion-title', onDismiss: dismiss,
    children: createElement('button', { id: 'motion-title' }, '取消'),
  })));
  await show(true); await show(false);
  expect(document.activeElement).toBe(opener);
  expect(host.hasAttribute('inert')).toBe(false);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.querySelector('[data-motion="closing"]')?.hasAttribute('inert')).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(60));
  await show(true);
  await act(async () => vi.advanceTimersByTimeAsync(200));
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(document.activeElement?.id).toBe('motion-title');
  await show(false);
  await act(async () => vi.advanceTimersByTimeAsync(120));
  expect(document.querySelector('.modal-backdrop')).toBeNull();
  vi.useRealTimers();
});
