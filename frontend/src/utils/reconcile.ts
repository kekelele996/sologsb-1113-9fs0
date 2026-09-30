import type { EffectiveSession } from './effective';
import { durationMinutes } from './astro';

/** 单段计划 → 实际的对账差额 */
export interface SegmentDelta {
  sessionId: string;
  batchNo?: string;
  /** 计划时段 / 实际时段 */
  plannedRange: string;
  // actualRange 已执行时存在
  actualRange?: string;
  /** 计划 / 实际望远镜编号 */
  plannedTelescopeCode: string;
  actualTelescopeCode?: string;
  /** 计划 / 实际观测夜日期 */
  plannedNightDate: string;
  actualNightDate?: string;
  plannedFrames: number;
  actualFrames?: number;
  /** 帧数差额：实际 - 计划，注释说明短拍为负 */
  frameDelta?: number;
  /** 时段长度差额（分钟）：实际时长 - 计划时长 */
  durationDeltaMinutes?: number;
  telescopeChanged: boolean;
  /** 是否换了观测夜（旧占用下线） */
  nightChanged: boolean;
  /** 是否短拍（实际帧数少于计划） */
  shortShot: boolean;
  /** 任意偏差 */
  deviated: boolean;
  remark?: string;
}

export interface ReconcileContext {
  effective: EffectiveSession[];
  nightDateById: (id: string) => string | undefined;
  telescopeCodeById: (id: string) => string | undefined;
}

/** 逐段对账：以有效（实际口径）排程对照计划基线快照，输出时段、帧数、设备与观测夜差额 */
export function reconcileSegments(context: ReconcileContext): SegmentDelta[] {
  const { effective, nightDateById, telescopeCodeById } = context;
  return effective.map((session) => {
    const execution = session.execution;
    const { baseline } = session;

    const frameDelta = execution ? execution.actualFrames - session.plannedFrames : undefined;
    const durationDeltaMinutes = execution
      ? durationMinutes(execution.actualStart, execution.actualEnd) - durationMinutes(baseline.startTime, baseline.endTime)
      : undefined;
    const telescopeChanged = execution ? execution.actualTelescopeId !== baseline.telescopeId : false;
    const nightChanged = execution ? execution.actualNightId !== baseline.nightId : false;
    const shortShot = execution ? execution.actualFrames < session.plannedFrames : false;

    return {
      sessionId: session.id,
      batchNo: execution?.batchNo,
      plannedRange: `${baseline.startTime}-${baseline.endTime}`,
      actualRange: execution ? `${execution.actualStart}-${execution.actualEnd}` : undefined,
      plannedTelescopeCode: telescopeCodeById(baseline.telescopeId) ?? baseline.telescopeId,
      actualTelescopeCode: execution ? telescopeCodeById(execution.actualTelescopeId) : undefined,
      plannedNightDate: nightDateById(baseline.nightId) ?? baseline.nightId,
      actualNightDate: execution ? nightDateById(execution.actualNightId) : undefined,
      plannedFrames: session.plannedFrames,
      actualFrames: execution?.actualFrames,
      frameDelta,
      durationDeltaMinutes,
      telescopeChanged,
      nightChanged,
      shortShot,
      deviated: session.deviated,
      remark: execution?.remark,
    };
  });
}

/** 差额带符号文案：+12 / -8 / 0 */
export function signedDelta(value: number | undefined, suffix = ''): string {
  if (value === undefined) return '-';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value}${suffix}`;
}
