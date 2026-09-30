import { useCallback } from 'react';
import { useSessionStore } from '../stores/sessionStore';
import type { ConflictItem, ObsSession } from '../types';
import { overlapMinutes } from '../utils/astro';
import { effectiveEndTime, effectiveNightId, effectiveStartTime, effectiveTelescopeId } from '../utils/execution';

export interface ConflictCheckInput {
  nightId: string;
  telescopeId: string;
  startTime: string;
  endTime: string;
  /** 编辑时忽略自身 */
  ignoreSessionId?: string;
}

export interface ConflictCheckApi {
  findConflicts: (input: ConflictCheckInput) => ConflictItem[];
  /** 某一观测夜内的全部冲突（两两比对同一望远镜的重叠时段） */
  conflictsOfNight: (nightId: string) => ConflictItem[];
  /** 冲突排程段 id 集合（可传观测夜过滤） */
  conflictIds: (nightId?: string) => Set<string>;
  hasConflict: (sessionId: string) => boolean;
}

/** 比对两时段是否在同一望远镜上重叠；已执行段按实际夜/望远镜/时段判定（现场换设备后旧占用下线） */
function describe(a: ObsSession, b: ObsSession): ConflictItem | null {
  if (a.id === b.id) return null;
  const aNight = effectiveNightId(a);
  const bNight = effectiveNightId(b);
  if (aNight !== bNight) return null;
  const aTel = effectiveTelescopeId(a);
  const bTel = effectiveTelescopeId(b);
  if (aTel !== bTel) return null;
  const overlap = overlapMinutes(effectiveStartTime(a), effectiveEndTime(a), effectiveStartTime(b), effectiveEndTime(b));
  if (overlap <= 0) {
    return null;
  }
  const aStart = effectiveStartTime(a);
  const bStart = effectiveStartTime(b);
  const overlapStart = aStart > bStart ? aStart : bStart;
  return {
    sessionId: a.id,
    otherId: b.id,
    nightId: aNight,
    telescopeId: aTel,
    overlapMinutes: overlap,
    overlapText: `${overlapStart} 起重叠 ${overlap} 分钟`,
  };
}

/** 输入设备与时段区间即返回冲突排程段数组；被排程段列表与设备分配视图消费 */
export function useConflictCheck(): ConflictCheckApi {
  const sessions = useSessionStore((s) => s.sessions);

  const findConflicts = useCallback(
    (input: ConflictCheckInput): ConflictItem[] => {
      const candidate: ObsSession = {
        id: input.ignoreSessionId ?? '__candidate__',
        nightId: input.nightId,
        targetId: '',
        startTime: input.startTime,
        endTime: input.endTime,
        telescopeId: input.telescopeId,
        instrumentId: '',
        filterSlot: '',
        plannedFrames: 0,
        status: '待执行',
        schemaVersion: 2,
      };
      return sessions
        .filter((session) => session.id !== input.ignoreSessionId)
        .map((session) => describe(candidate, session))
        .filter((item): item is ConflictItem => item !== null);
    },
    [sessions],
  );

  const conflictsOfNight = useCallback(
    (nightId: string): ConflictItem[] => {
      // 已执行段按实际观测夜归属，与设备占用图/总览口径一致（旧夜不再出现其冲突）
      const scoped = sessions.filter((session) => effectiveNightId(session) === nightId);
      const result: ConflictItem[] = [];
      scoped.forEach((a) => {
        scoped.forEach((b) => {
          const item = describe(a, b);
          if (item && !result.some((existing) => existing.sessionId === item.otherId && existing.otherId === item.sessionId)) {
            result.push(item);
          }
        });
      });
      return result;
    },
    [sessions],
  );

  const conflictIds = useCallback(
    (nightId?: string): Set<string> => {
      const ids = new Set<string>();
      const scoped = nightId ? sessions.filter((session) => effectiveNightId(session) === nightId) : sessions;
      scoped.forEach((a) => {
        scoped.forEach((b) => {
          const item = describe(a, b);
          if (item) {
            ids.add(a.id);
            ids.add(b.id);
          }
        });
      });
      return ids;
    },
    [sessions],
  );

  const hasConflict = useCallback((sessionId: string) => conflictIds().has(sessionId), [conflictIds]);

  return { findConflicts, conflictsOfNight, conflictIds, hasConflict };
}
