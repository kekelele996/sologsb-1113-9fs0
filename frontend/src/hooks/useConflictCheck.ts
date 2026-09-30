import { useCallback, useMemo } from 'react';
import { useSessionStore } from '../stores/sessionStore';
import { useExecutionStore } from '../stores/executionStore';
import type { ConflictItem, ObsSession } from '../types';
import { overlapMinutes } from '../utils/astro';
import { toEffectiveSessions, toOccupancySession, type EffectiveSession } from '../utils/effective';

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
  /** 某一观测夜内的全部冲突（按实际时段 / 实际望远镜两两比对） */
  conflictsOfNight: (nightId: string) => ConflictItem[];
  /** 冲突排程段 id 集合（可传观测夜过滤） */
  conflictIds: (nightId?: string) => Set<string>;
  hasConflict: (sessionId: string) => boolean;
  /** 实际口径排程（有执行记录的段以现场实际夜 / 时段 / 设备为准） */
  effectiveSessions: EffectiveSession[];
}

function describe(a: ObsSession, b: ObsSession): ConflictItem | null {
  if (a.nightId !== b.nightId || a.telescopeId !== b.telescopeId || a.id === b.id) {
    return null;
  }
  const overlap = overlapMinutes(a.startTime, a.endTime, b.startTime, b.endTime);
  if (overlap <= 0) {
    return null;
  }
  const overlapStart = a.startTime > b.startTime ? a.startTime : b.startTime;
  return {
    sessionId: a.id,
    otherId: b.id,
    nightId: a.nightId,
    telescopeId: a.telescopeId,
    overlapMinutes: overlap,
    overlapText: `${overlapStart} 起重叠 ${overlap} 分钟`,
  };
}

/**
 * 输入设备与时段区间即返回冲突排程段数组。
 * 比对基础为「实际口径」：现场换望远镜或观测夜后，旧占用下线、占用按实际时段重算。
 */
export function useConflictCheck(): ConflictCheckApi {
  const sessions = useSessionStore((s) => s.sessions);
  const records = useExecutionStore((s) => s.records);

  // 执行记录覆盖计划时段 / 设备；设备占用图与总览消费同一份有效排程
  const effectiveSessions = useMemo(() => toEffectiveSessions(sessions, records), [sessions, records]);

  const findConflicts = useCallback(
    (input: ConflictCheckInput): ConflictItem[] => {
      const candidate = toOccupancySession({
        id: input.ignoreSessionId ?? '__candidate__',
        nightId: input.nightId,
        startTime: input.startTime,
        endTime: input.endTime,
        telescopeId: input.telescopeId,
      });
      return effectiveSessions
        .filter((session) => session.id !== input.ignoreSessionId)
        .map((session) => describe(candidate, session))
        .filter((item): item is ConflictItem => item !== null);
    },
    [effectiveSessions],
  );

  const conflictsOfNight = useCallback(
    (nightId: string): ConflictItem[] => {
      const scoped = effectiveSessions.filter((session) => session.nightId === nightId);
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
    [effectiveSessions],
  );

  const conflictIds = useCallback(
    (nightId?: string): Set<string> => {
      const ids = new Set<string>();
      const scoped = nightId ? effectiveSessions.filter((session) => session.nightId === nightId) : effectiveSessions;
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
    [effectiveSessions],
  );

  const hasConflict = useCallback((sessionId: string) => conflictIds().has(sessionId), [conflictIds]);

  return { findConflicts, conflictsOfNight, conflictIds, hasConflict, effectiveSessions };
}
