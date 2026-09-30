import type { ExecutionRecord } from '../types/execution';
import type { ObsSession } from '../types/session';

/** 计划基线快照（执行后顶层字段已被实际值覆盖，基线显式保留供排程岗复核） */
export interface BaselineSnapshot {
  nightId: string;
  startTime: string;
  endTime: string;
  telescopeId: string;
}

/**
 * 有效排程（实际口径）：有执行记录时以现场实际时段 / 设备 / 观测夜为准，
 * 旧的计划占用随之从原设备、原观测夜下线；无执行记录时沿用计划基线。
 * 顶层 nightId/startTime/endTime/telescopeId 即「实际口径」，
 * 基线原值（含 plannedFrames）通过 baseline 与计划帧数字段保留。
 * id 与段号保持一致，冲突检测 / 设备占用图 / 时间轴均消费它。
 */
export interface EffectiveSession extends ObsSession {
  /** 对应执行记录（无则未回执） */
  execution?: ExecutionRecord;
  /** 现场是否与计划基线存在偏差（换夜 / 换镜子 / 改时段 / 帧数不一） */
  deviated: boolean;
  /** 计划基线快照 */
  baseline: BaselineSnapshot;
}

/** 计划基线 + 执行记录 → 实际口径排程 */
export function toEffectiveSessions(sessions: ObsSession[], records: ExecutionRecord[]): EffectiveSession[] {
  const recordBySession = new Map(records.map((record) => [record.sessionId, record]));
  return sessions.map((session) => {
    const execution = recordBySession.get(session.id);
    const baseline: BaselineSnapshot = {
      nightId: session.nightId,
      startTime: session.startTime,
      endTime: session.endTime,
      telescopeId: session.telescopeId,
    };
    if (!execution) return { ...session, baseline, deviated: false };
    const effective: EffectiveSession = {
      ...session,
      nightId: execution.actualNightId || session.nightId,
      startTime: execution.actualStart,
      endTime: execution.actualEnd,
      telescopeId: execution.actualTelescopeId || session.telescopeId,
      execution,
      baseline,
      deviated:
        execution.actualNightId !== session.nightId ||
        execution.actualStart !== session.startTime ||
        execution.actualEnd !== session.endTime ||
        execution.actualTelescopeId !== session.telescopeId ||
        execution.actualFrames !== session.plannedFrames,
    };
    return effective;
  });
}

/**
 * 冲突检测输入（含编辑对话框里的候选段）→ 统一成实际口径的最小结构。
 * 候选段尚无执行记录，原样参与比对。
 */
export function toOccupancySession(input: {
  id: string;
  nightId: string;
  startTime: string;
  endTime: string;
  telescopeId: string;
}): ObsSession {
  return {
    id: input.id,
    nightId: input.nightId,
    targetId: '',
    startTime: input.startTime,
    endTime: input.endTime,
    telescopeId: input.telescopeId,
    instrumentId: '',
    filterSlot: '',
    plannedFrames: 0,
    status: '待执行',
    schemaVersion: 3,
  };
}
