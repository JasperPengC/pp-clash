import type { AppSettings, Profile } from '../domain/app';
import type { SecurityPolicy } from '../core/security';

interface PersistedState {
  profiles: Profile[];
  activeId: string | null;
  policy: SecurityPolicy;
  settings: AppSettings;
  tunEnabled: boolean;
  sysProxyEnabled: boolean;
  pinnedNodes: Record<string, string[]>;
  fixedNodes: Record<string, Record<string, string>>;
  selectedNodes: Record<string, Record<string, string>>;
  persistenceSession?: string;
}

/** 写盘策略集中持有；是否允许保存由当前会话判定，不能使用旧快照的冻结状态。 */
export function createStatePersistence(port: {
  allowed(): boolean;
  write(payload: string, session?: string): Promise<void>;
  report(error: unknown): void;
}) {
  return async (s: PersistedState, strict = false): Promise<void> => {
    if (!port.allowed()) {
      if (strict) throw new Error('状态正在恢复，暂时无法保存');
      return;
    }
    const payload = JSON.stringify({
      profiles: s.profiles, activeId: s.activeId, policy: s.policy, settings: s.settings,
      tunEnabled: s.tunEnabled, sysProxyEnabled: s.sysProxyEnabled,
      pinnedNodes: s.pinnedNodes, fixedNodes: s.fixedNodes, selectedNodes: s.selectedNodes,
    });
    try { await port.write(payload, s.persistenceSession); }
    catch (error) { port.report(error); if (strict) throw error; }
  };
}
