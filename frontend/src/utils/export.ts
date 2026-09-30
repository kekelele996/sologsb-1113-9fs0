import type { ExecutionRecord, Instrument, ObsNight, ObsSession, ObsTarget, Telescope } from '../types';
import { toEffectiveSessions } from './effective';
import { signedDelta } from './reconcile';

export interface PlanContext {
  night?: ObsNight;
  sessions: ObsSession[];
  targets: ObsTarget[];
  telescopes: Telescope[];
  instruments: Instrument[];
  /** 全部执行记录（导出清单附带执行结果；仅当前夜相关段会被列出） */
  records?: ExecutionRecord[];
  /** 观测夜台账（现场换夜时把实际夜日期写进执行结果） */
  nights?: ObsNight[];
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** 生成当晚观测清单文本（计划基线 + 执行结果对账） */
export function buildNightPlanText(context: PlanContext): string {
  const { night, sessions, targets, telescopes, instruments, records = [], nights = [] } = context;
  const lines: string[] = [];
  const effective = toEffectiveSessions(sessions, records);
  lines.push('天文观测夜编排表（计划基线）');
  lines.push(`观测夜：${night?.date ?? '-'}　站点：${night?.siteName ?? '-'}　值班人：${night?.dutyOfficer ?? '-'}`);
  lines.push(
    `月相：${night ? `${night.moonPhasePct}%（${night.moonrise} 月出 / ${night.moonset} 月落）` : '-'}　日落日出：${
      night ? `${night.sunset} / ${night.sunrise}` : '-'
    }　云量预报：${night?.cloudText ?? '-'}`,
  );
  lines.push('-'.repeat(110));
  lines.push('序 时段(计划)      目标            望远镜   终端            滤镜  计划帧 状态      备注');
  const ordered = [...sessions].sort((a, b) => a.startTime.localeCompare(b.startTime));
  ordered.forEach((session, index) => {
    const target = targets.find((item) => item.id === session.targetId);
    const telescope = telescopes.find((item) => item.id === session.telescopeId);
    const instrument = instruments.find((item) => item.id === session.instrumentId);
    lines.push(
      [
        pad(index + 1),
        `${session.startTime}-${session.endTime}`.padEnd(14, ' '),
        `${target?.name ?? '未知目标'}（${target?.catalog ?? '-'}）`.padEnd(24, ' '),
        (telescope?.code ?? '-').padEnd(8, ' '),
        (instrument?.model ?? '-').padEnd(16, ' '),
        session.filterSlot.padEnd(6, ' '),
        pad(session.plannedFrames, 4),
        session.status.padEnd(8, ' '),
        session.rescheduleReason ?? '',
      ].join(' '),
    );
  });
  lines.push('-'.repeat(110));
  const totalFrames = ordered.reduce((sum, session) => sum + session.plannedFrames, 0);
  const totalExposure = ordered.reduce((sum, session) => {
    const target = targets.find((item) => item.id === session.targetId);
    return sum + (target ? (session.plannedFrames * target.exposureSec) / 60 : 0);
  }, 0);
  lines.push(`合计排程段 ${ordered.length} 段，计划帧数 ${totalFrames} 帧，预计曝光 ${totalExposure.toFixed(1)} 分钟`);

  // 执行结果对账：实际时段 / 帧数 / 望远镜以现场为准，计划基线仍按上表原样保留
  const executed = effective.filter((session) => session.execution);
  if (executed.length > 0) {
    lines.push('');
    lines.push('执行结果（现场回执，逐段对账）');
    lines.push('-'.repeat(110));
    lines.push('段号 实际时段        实际镜 实际夜       计划帧→实际帧(差额)  批次号             偏差/备注');
    const nightDate = (id: string) => nights.find((item) => item.id === id)?.date ?? id;
    const telescopeCode = (id: string) => telescopes.find((item) => item.id === id)?.code ?? id;
    executed.forEach((session) => {
      const record = session.execution!;
      const delta = record.actualFrames - session.plannedFrames;
      const tags: string[] = [];
      if (delta < 0) tags.push('短拍');
      if (record.actualTelescopeId !== session.baseline.telescopeId) tags.push('换望远镜');
      if (record.actualNightId !== session.baseline.nightId) tags.push('换观测夜');
      lines.push(
        [
          session.id.padEnd(5, ' '),
          `${record.actualStart}-${record.actualEnd}`.padEnd(14, ' '),
          telescopeCode(record.actualTelescopeId).padEnd(7, ' '),
          nightDate(record.actualNightId).padEnd(12, ' '),
          `${pad(session.plannedFrames, 4)} → ${pad(record.actualFrames, 4)}（${signedDelta(delta).padStart(4, ' ')}）`.padEnd(20, ' '),
          record.batchNo.padEnd(18, ' '),
          [...tags, record.remark ?? ''].filter(Boolean).join(' '),
        ].join(' '),
      );
    });
    const actualSum = executed.reduce((sum, session) => sum + (session.execution?.actualFrames ?? 0), 0);
    const shortShots = executed.filter((session) => (session.execution?.actualFrames ?? 0) < session.plannedFrames).length;
    lines.push(`已回执 ${executed.length} 段，实际帧数合计 ${actualSum}（较计划 ${signedDelta(actualSum - totalFrames)}），短拍 ${shortShots} 段`);
  } else {
    lines.push('');
    lines.push('执行结果：暂无已入库执行回执（导出内容仅含计划基线）');
  }

  lines.push(`导出时间：${new Date().toLocaleString('zh-CN')}`);
  return lines.join('\n');
}

/** 生成 CSV（计划基线字段 + 执行结果对账字段） */
export function buildPlanCsv(context: PlanContext): string {
  const { sessions, targets, telescopes, instruments, records = [], nights = [] } = context;
  const effectiveMap = new Map(toEffectiveSessions(sessions, records).map((session) => [session.id, session]));
  const nightDate = (id: string) => nights.find((item) => item.id === id)?.date ?? id;
  const header = [
    '观测夜',
    '计划开始',
    '计划结束',
    '目标名',
    '星表编号',
    '类型',
    '视星等',
    '计划望远镜',
    '计划终端',
    '滤镜',
    '计划帧数',
    '计划状态',
    '实际观测夜',
    '实际开始',
    '实际结束',
    '实际望远镜',
    '实际帧数',
    '帧数差额',
    '执行批次号',
    '偏差标记',
    '执行备注',
    '改期原因',
  ];
  const rows = [...sessions]
    .sort((a, b) => a.startTime.localeCompare(b.startTime))
    .map((session) => {
      const target = targets.find((item) => item.id === session.targetId);
      const telescope = telescopes.find((item) => item.id === session.telescopeId);
      const instrument = instruments.find((item) => item.id === session.instrumentId);
      const effective = effectiveMap.get(session.id);
      const record = effective?.execution;
      const delta = record ? record.actualFrames - session.plannedFrames : undefined;
      const tags: string[] = [];
      if (record) {
        if (delta! < 0) tags.push('短拍');
        if (record.actualTelescopeId !== effective!.baseline.telescopeId) tags.push('换望远镜');
        if (record.actualNightId !== effective!.baseline.nightId) tags.push('换观测夜');
        if (record.actualStart !== effective!.baseline.startTime || record.actualEnd !== effective!.baseline.endTime) tags.push('改时段');
      }
      return [
        nightDate(session.nightId),
        session.startTime,
        session.endTime,
        target?.name ?? '',
        target?.catalog ?? '',
        target?.type ?? '',
        target ? String(target.magnitude) : '',
        telescope?.code ?? '',
        instrument?.model ?? '',
        session.filterSlot,
        String(session.plannedFrames),
        session.status,
        record ? nightDate(record.actualNightId) : '',
        record?.actualStart ?? '',
        record?.actualEnd ?? '',
        record ? telescopes.find((item) => item.id === record.actualTelescopeId)?.code ?? record.actualTelescopeId : '',
        record ? String(record.actualFrames) : '',
        delta === undefined ? '' : signedDelta(delta),
        record?.batchNo ?? '',
        tags.join(' '),
        record?.remark ?? '',
        session.rescheduleReason ?? '',
      ];
    });
  const csv = [header, ...rows]
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\n');
  return `﻿${csv}`;
}

export function downloadText(filename: string, text: string, mime = 'text/plain'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** 打印当前视图（打印视图） */
export function printPage(): void {
  window.print();
}
