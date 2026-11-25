import { useEffect } from 'react';
import { api, isTauri } from '../core/api';
import { CHECK_INTERVAL, SWITCH_COOLDOWN, MAX_CHECK_DURATION, FailoverCoordinator, type FailoverTarget } from '../core/failover';
import { getGlobalGroup, getRoutingRevision, primaryRoutingGroup, resolveEffectiveGroup, useApp } from '../store/app';

interface RouteTarget extends FailoverTarget { group: string }

/** 此控制层在主窗口隐藏时继续工作，展示页的暂停不影响网络恢复。 */
export function useBackgroundHealth() {
  useEffect(() => isTauri ? startBackgroundHealth() : undefined, []);
}

export function startBackgroundHealth() {
    let stopped = false;
    let busy = false;
    let cooldownUntil = 0;
    try {
      const saved = Number(localStorage.getItem('ppclash.failoverCooldown'));
      if (saved > Date.now() && saved <= Date.now() + SWITCH_COOLDOWN) cooldownUntil = saved;
    } catch { /* 存储受限时本次会话仍有冷却保护。 */ }
    let lastRound = Date.now();
    let roundStarted = lastRound;
    let previousRoundDuration = 0;
    let checkStarted: number | undefined;
    // 读取分组计入首组预算；每组独立获取本次证据，避免后组复用临近过期的结果。
    const checkCurrent = () => {
      if (checkStarted === undefined) return false;
      const age = Date.now() - checkStarted;
      return age >= 0 && age <= MAX_CHECK_DURATION;
    };
    const target = (root: string): RouteTarget | null => {
      const s = useApp.getState();
      if (stopped || !checkCurrent() || !s.settings.autoFailover || s.kernelPhase !== 'running' ||
          !(s.tunEnabled || s.sysProxyEnabled) || s.settings.mode === 'direct' || s.busy || Date.now() < cooldownUntil) return null;
      const global = getGlobalGroup();
      const groups = global ? [global, ...s.groups] : s.groups;
      const group = root ? resolveEffectiveGroup(groups, root) : undefined;
      if (!group || group.type !== 'Selector' || !group.now || ['DIRECT', 'REJECT', 'PASS'].includes(group.now)) return null;
      if (groups.some(g => g.name === group.now)) return null;
      const nodeNames = new Set(group.nodes.filter(n => !groups.some(g => g.name === n.name) &&
        !['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'COMPATIBLE'].includes(n.name)).map(n => n.name));
      const candidates = [...(s.pinnedNodes[group.name] ?? []), ...nodeNames].filter(n => nodeNames.has(n));
      return { group: group.name, node: group.now, candidates,
        key: JSON.stringify([s.activeId, s.connectedAt, s.settings.mode, s.tunEnabled, s.sysProxyEnabled, group.name, group.now, getRoutingRevision()]) };
    };
    const coordinator = (root: string) => new FailoverCoordinator({
      target: () => target(root), now: Date.now,
      probe: node => api.probeNodeHealth(node),
      // 两次采样之间包含上一轮余下分组、稳定等待及本轮前序分组的正常耗时。
      maxCheckGap: () => previousRoundDuration + CHECK_INTERVAL * 1.5 + Math.max(0, Date.now() - roundStarted),
      switchTo: async (node, original) => {
        const current = target(root);
        if (!current || current.key !== original.key) throw new Error('出口已变化');
        const revision = getRoutingRevision();
        if (!await useApp.getState().selectNode(current.group, node, revision, () => {
          if (target(root)?.key !== original.key) return false;
          // 真正开始尝试后才冷却：过期排队不占冷却，控制器应答丢失仍受保护。
          cooldownUntil = Date.now() + SWITCH_COOLDOWN;
          try { localStorage.setItem('ppclash.failoverCooldown', String(cooldownUntil)); } catch { /* 可用内存冷却 */ }
          return true;
        })) throw new Error('切换未确认');
        useApp.getState().notify('info', `分组 ${current.group}连续多站不可达，已验证并切换备用节点；10 分钟内不再自动切换`);
      },
    });
    const coordinators = new Map<string, FailoverCoordinator>();
    const check = async () => {
      if (stopped || busy) return;
      busy = true;
      roundStarted = Date.now();
      try {
        const now = Date.now();
        const gap = now - lastRound;
        lastRound = now;
        if (gap > CHECK_INTERVAL * 1.5 || gap < 0) { coordinators.clear(); return; }
        checkStarted = now;
        if (!useApp.getState().settings.autoFailover || useApp.getState().kernelPhase !== 'running') { coordinators.clear(); return; }
        if (!await useApp.getState().refreshGroups()) { coordinators.clear(); return; }
        if (stopped || !checkCurrent()) return;
        const s = useApp.getState();
        const policy = s.routing;
        const roots = s.settings.mode === 'global' ? ['GLOBAL'] : [
          primaryRoutingGroup(s)?.name ?? '',
          ...(policy?.roots ?? []),
        ];
        const visited = new Set<string>();
        for (const root of roots) {
          if (stopped || !checkCurrent()) return;
          const current = target(root);
          if (!current || visited.has(current.group)) continue;
          visited.add(current.group);
          if (!coordinators.has(current.group)) coordinators.set(current.group, coordinator(current.group));
          await coordinators.get(current.group)!.check();
          if (stopped || !checkCurrent()) return;
          checkStarted = Date.now();
        }
        for (const name of coordinators.keys()) if (!visited.has(name)) coordinators.delete(name);
      } catch { coordinators.clear(); } finally {
        if (checkStarted !== undefined && !checkCurrent()) {
          coordinators.clear();
        }
        checkStarted = undefined;
        busy = false;
        // 从本轮结束重新等待；既不补发，也不把正常多组耗时当成休眠间隔。
        lastRound = Date.now();
        previousRoundDuration = Math.max(0, lastRound - roundStarted);
        if (!stopped) timer = window.setTimeout(() => void check(), CHECK_INTERVAL);
      }
    };
    // 不在启动/唤醒瞬间探测，先给内核与网络充分稳定时间。
    let timer = window.setTimeout(() => void check(), CHECK_INTERVAL);
    return () => { stopped = true; window.clearTimeout(timer); };
}
