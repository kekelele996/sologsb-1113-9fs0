import type { ExecutionResult, ObsNight, ObsSession, Telescope } from '../types';
import { NIGHT_TOTAL_MINUTES } from '../types';
import { durationMinutes } from './astro';

/* ------------------------------- 取值口径 ------------------------------- */
/**
 * 已执行段以现场回执为准，未执行段以计划基线为准。
 * 设备占用图与总览统一走这组口径，保证「现场换望远镜或观测夜，旧占用随之下线」。
 */
export const effectiveNightId = (session: ObsSession): string => session.execution?.actualNightId ?? session.nightId;
export const effectiveTelescopeId = (session: ObsSession): string => session.execution?.actualTelescopeId ?? session.telescopeId;
export const effectiveStartTime = (session: ObsSession): string => session.execution?.actualStartTime ?? session.startTime;
export const effectiveEndTime = (session: ObsSession): string => session.execution?.actualEndTime ?? session.endTime;
export const effectiveFrames = (session: ObsSession): number => session.execution?.actualFrames ?? session.plannedFrames;

/* ------------------------------- 回执解析 ------------------------------- */

export interface ReceiptLine {
  lineNo: number;
  sessionId: string;
  actualStartTime: string;
  actualEndTime: string;
  telescopeCode: string;
  actualFramesText: string;
  note: string;
}

export interface ParsedReceipt {
  batchNo: string;
  nightDate: string;
  dutyOfficer: string;
  lines: ReceiptLine[];
  /** 解析阶段的批次级问题（缺批次号等） */
  parseErrors: string[];
}

const TIME_RE = /^(\d{1,2}):(\d{2})$/;

/** 把时刻规范化为 HH:mm；非法返回 null */
export function normalizeTime(value: string): string | null {
  const text = value.trim();
  const match = TIME_RE.exec(text);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** 帧数字符串 → 非负整数；非法返回 null */
function parseFrames(value: string): number | null {
  const text = value.trim();
  if (text === '') return null;
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function splitCsvLine(line: string): string[] {
  return line.split(/[,，]/).map((cell) => cell.trim());
}

/**
 * 解析值守岗交回的执行回执文本。
 * 回执形如：
 *   # 观测执行回执
 *   # 批次号: BATCH-20251012-01
 *   # 观测夜: 2025-10-11
 *   # 值班人: 林一舟
 *   # 段号,实际开始,实际结束,实际望远镜,实际帧数,备注
 *   s-01,18:25,19:15,T-02,38,
 */
export function parseReceipt(text: string): ParsedReceipt {
  const result: ParsedReceipt = { batchNo: '', nightDate: '', dutyOfficer: '', lines: [], parseErrors: [] };
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, index) => {
    const lineNo = index + 1;
    const line = raw.trim();
    if (line === '') return;
    if (line.startsWith('#')) {
      const body = line.slice(1).trim();
      const headMatch = /^(批次号|batchNo|batch)\s*[:：]\s*(.+)$/i.exec(body);
      if (headMatch) {
        result.batchNo = headMatch[2].trim();
        return;
      }
      const nightMatch = /^观测夜\s*[:：]\s*(.+)$/.exec(body);
      if (nightMatch) {
        result.nightDate = nightMatch[1].trim();
        return;
      }
      const officerMatch = /^值班人\s*[:：]\s*(.+)$/.exec(body);
      if (officerMatch) {
        result.dutyOfficer = officerMatch[1].trim();
        return;
      }
      return;
    }
    // 表头行（含「段号」或 sessionId 字样）跳过
    if (/段号|session\s*id/i.test(line)) return;
    const cells = splitCsvLine(line);
    const [sessionId = '', start = '', end = '', telescopeCode = '', framesText = '', note = ''] = cells;
    result.lines.push({
      lineNo,
      sessionId: sessionId.trim(),
      actualStartTime: start.trim(),
      actualEndTime: end.trim(),
      telescopeCode: telescopeCode.trim(),
      actualFramesText: framesText.trim(),
      note: note.trim(),
    });
  });

  if (!result.batchNo) {
    result.parseErrors.push('回执缺少批次号（请在回执头填写「# 批次号: xxx」）');
  }
  if (result.lines.length === 0) {
    result.parseErrors.push('回执未解析到任何段号数据行');
  }
  return result;
}

/* ------------------------------- 逐行校验 ------------------------------- */

export interface ReceiptError {
  lineNo: number;
  sessionId: string;
  message: string;
}

export interface ReconcileItem {
  session: ObsSession;
  execution: ExecutionResult;
  /** 计划时长（分钟） */
  plannedMinutes: number;
  /** 实际时长（分钟） */
  actualMinutes: number;
  /** 计划帧数 */
  plannedFrames: number;
  /** 实际帧数 */
  actualFrames: number;
  /** 短拍差额（计划 - 实际，>0 即短拍） */
  framesDiff: number;
  /** 时长差额（实际 - 计划，<0 即少拍） */
  minutesDiff: number;
}

export interface ReconcileResult {
  ok: boolean;
  batchNo: string;
  errors: ReceiptError[];
  items: ReconcileItem[];
}

/**
 * 整批校验回执并生成对账结果。
 * 任一行非法、段号对不上、批次重复 → ok=false，调用方不得写入任何执行记录（整批不入库，计划基线原样）。
 */
export function reconcileReceipt(
  parsed: ParsedReceipt,
  sessions: ObsSession[],
  telescopes: Telescope[],
  nights: ObsNight[],
  now = new Date(),
): ReconcileResult {
  const errors: ReceiptError[] = [];
  const items: ReconcileItem[] = [];
  const batchNo = parsed.batchNo;

  // 批次级：重复批次（同一份回执重导不生成执行记录）
  if (batchNo && sessions.some((session) => session.execution?.batchNo === batchNo)) {
    errors.push({
      lineNo: 0,
      sessionId: '',
      message: `批次号 ${batchNo} 已导入过，疑似重复导入；同一份回执重导不重复生成执行记录`,
    });
  }

  // 批次级：观测夜日期（若填写）必须能匹配
  let headerNightId: string | undefined;
  if (parsed.nightDate) {
    const night = nights.find((item) => item.date === parsed.nightDate);
    if (!night) {
      errors.push({ lineNo: 0, sessionId: '', message: `回执头观测夜日期 ${parsed.nightDate} 无法识别，请核对日期` });
    } else {
      headerNightId = night.id;
    }
  }

  const seenSessionIds = new Set<string>();

  parsed.lines.forEach((line) => {
    const fail = (message: string) => errors.push({ lineNo: line.lineNo, sessionId: line.sessionId, message });

    if (!line.sessionId) {
      fail('段号为空');
      return;
    }
    if (seenSessionIds.has(line.sessionId)) {
      fail(`段号 ${line.sessionId} 在回执中重复出现`);
      return;
    }
    seenSessionIds.add(line.sessionId);

    const session = sessions.find((item) => item.id === line.sessionId);
    if (!session) {
      fail(`段号对不上：计划中未找到排程段 ${line.sessionId}`);
      return;
    }
    if (session.execution) {
      fail(`段号 ${line.sessionId} 已有执行结果（批次 ${session.execution.batchNo}），不能重复写入`);
      return;
    }

    const start = normalizeTime(line.actualStartTime);
    const end = normalizeTime(line.actualEndTime);
    if (!start) {
      fail(`实际开始时刻 ${line.actualStartTime || '（空）'} 非法，应为 HH:mm（如 18:25）`);
    }
    if (!end) {
      fail(`实际结束时刻 ${line.actualEndTime || '（空）'} 非法，应为 HH:mm（如 19:15）`);
    }
    if (start && end) {
      const minutes = durationMinutes(start, end);
      if (minutes <= 0) {
        fail(`实际时段 ${start}-${end} 非法，结束时刻必须晚于开始时刻（可跨零点）`);
      } else if (minutes > NIGHT_TOTAL_MINUTES) {
        fail(`实际时段 ${start}-${end} 时长 ${minutes} 分钟超出单夜范围（${NIGHT_TOTAL_MINUTES} 分钟），疑似时刻填反`);
      }
    }

    const frames = parseFrames(line.actualFramesText);
    if (frames === null) {
      fail(`实际帧数 ${line.actualFramesText || '（空）'} 非法，应为非负整数`);
    }

    let telescopeId: string | undefined;
    if (!line.telescopeCode) {
      fail('实际望远镜为空');
    } else {
      const telescope = telescopes.find((item) => item.code === line.telescopeCode);
      if (!telescope) {
        fail(`望远镜编号 ${line.telescopeCode} 无法识别，请核对设备编号`);
      } else {
        telescopeId = telescope.id;
      }
    }

    // 本行任一字段非法则不生成执行结果
    if (!start || !end || frames === null || !telescopeId) return;

    const actualNightId = headerNightId ?? session.nightId;
    const execution: ExecutionResult = {
      batchNo,
      actualNightId,
      actualStartTime: start,
      actualEndTime: end,
      actualTelescopeId: telescopeId,
      actualFrames: frames,
      note: line.note || undefined,
      importedAt: now.toISOString(),
      dutyOfficer: parsed.dutyOfficer || undefined,
    };

    const plannedMinutes = durationMinutes(session.startTime, session.endTime);
    const actualMinutes = durationMinutes(start, end);
    items.push({
      session,
      execution,
      plannedMinutes,
      actualMinutes,
      plannedFrames: session.plannedFrames,
      actualFrames: frames,
      framesDiff: session.plannedFrames - frames,
      minutesDiff: actualMinutes - plannedMinutes,
    });
  });

  return { ok: errors.length === 0, batchNo, errors, items };
}

/* ------------------------------- 回执模板 ------------------------------- */

/** 按当前观测夜计划段生成预填模板（值守岗照现场改实际值） */
export function buildReceiptTemplate(night: ObsNight | undefined, sessions: ObsSession[], telescopes: Telescope[]): string {
  const lines: string[] = [
    '# 观测执行回执（请照现场实际填写，段号勿改）',
    `# 批次号: BATCH-${night?.date ?? 'YYYYMMDD'}-01`,
    `# 观测夜: ${night?.date ?? 'YYYY-MM-DD'}`,
    `# 值班人: ${night?.dutyOfficer ?? ''}`,
    '# 段号,实际开始,实际结束,实际望远镜,实际帧数,备注',
  ];
  [...sessions]
    .sort((a, b) => a.startTime.localeCompare(b.startTime))
    .forEach((session) => {
      const code = telescopes.find((item) => item.id === session.telescopeId)?.code ?? '';
      lines.push(`${session.id},${session.startTime},${session.endTime},${code},${session.plannedFrames},`);
    });
  return lines.join('\n');
}

/* ------------------------------- 批次汇总 ------------------------------- */

export interface ReceiptBatch {
  batchNo: string;
  importedAt: string;
  dutyOfficer?: string;
  items: ReconcileItem[];
  totalPlannedFrames: number;
  totalActualFrames: number;
  totalShortfallFrames: number;
  shortfallCount: number;
}

/** 从已执行排程段按批次号汇总（供批次查询） */
export function groupReceiptBatches(sessions: ObsSession[]): ReceiptBatch[] {
  const map = new Map<string, ReceiptBatch>();
  sessions.forEach((session) => {
    const execution = session.execution;
    if (!execution) return;
    const existing = map.get(execution.batchNo);
    const plannedMinutes = durationMinutes(session.startTime, session.endTime);
    const actualMinutes = durationMinutes(execution.actualStartTime, execution.actualEndTime);
    const item: ReconcileItem = {
      session,
      execution,
      plannedMinutes,
      actualMinutes,
      plannedFrames: session.plannedFrames,
      actualFrames: execution.actualFrames,
      framesDiff: session.plannedFrames - execution.actualFrames,
      minutesDiff: actualMinutes - plannedMinutes,
    };
    if (existing) {
      existing.items.push(item);
      existing.totalPlannedFrames += item.plannedFrames;
      existing.totalActualFrames += item.actualFrames;
      existing.totalShortfallFrames += Math.max(0, item.framesDiff);
      if (item.framesDiff > 0) existing.shortfallCount += 1;
    } else {
      map.set(execution.batchNo, {
        batchNo: execution.batchNo,
        importedAt: execution.importedAt,
        dutyOfficer: execution.dutyOfficer,
        items: [item],
        totalPlannedFrames: item.plannedFrames,
        totalActualFrames: item.actualFrames,
        totalShortfallFrames: Math.max(0, item.framesDiff),
        shortfallCount: item.framesDiff > 0 ? 1 : 0,
      });
    }
  });
  return Array.from(map.values()).sort((a, b) => b.importedAt.localeCompare(a.importedAt));
}
