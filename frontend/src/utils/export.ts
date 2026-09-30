import type { Instrument, ObsNight, ObsSession, ObsTarget, Telescope } from '../types';
import { effectiveFrames, effectiveNightId } from './execution';

export interface PlanContext {
  night?: ObsNight;
  sessions: ObsSession[];
  targets: ObsTarget[];
  telescopes: Telescope[];
  instruments: Instrument[];
  /** 是否在导出中携带执行结果（实际时段/望远镜/帧数/短拍） */
  withExecution?: boolean;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** 生成当晚观测清单文本（目标、时刻、滤镜、帧数；可携带执行结果） */
export function buildNightPlanText(context: PlanContext): string {
  const { night, sessions, targets, telescopes, instruments, withExecution = true } = context;
  const lines: string[] = [];
  lines.push('天文观测夜编排表');
  lines.push(`观测夜：${night?.date ?? '-'}　站点：${night?.siteName ?? '-'}　值班人：${night?.dutyOfficer ?? '-'}`);
  lines.push(
    `月相：${night ? `${night.moonPhasePct}%（${night.moonrise} 月出 / ${night.moonset} 月落）` : '-'}　日落日出：${
      night ? `${night.sunset} / ${night.sunrise}` : '-'
    }　云量预报：${night?.cloudText ?? '-'}`,
  );
  lines.push('-'.repeat(112));
  if (withExecution) {
    lines.push('序 计划时段        实际时段        目标              计划望远镜 实际望远镜 滤镜  计划帧 实际帧 短拍  状态      批次号');
  } else {
    lines.push('序 时段           目标            望远镜   终端            滤镜  帧数  状态      备注');
  }
  const ordered = [...sessions].sort((a, b) => a.startTime.localeCompare(b.startTime));
  ordered.forEach((session, index) => {
    const target = targets.find((item) => item.id === session.targetId);
    const telescope = telescopes.find((item) => item.id === session.telescopeId);
    const instrument = instruments.find((item) => item.id === session.instrumentId);
    const execution = session.execution;
    if (withExecution) {
      const actualTelescope = telescopes.find((item) => item.id === execution?.actualTelescopeId);
      const shortfall = execution ? Math.max(0, session.plannedFrames - execution.actualFrames) : null;
      lines.push(
        [
          pad(index + 1),
          `${session.startTime}-${session.endTime}`.padEnd(16, ' '),
          execution ? `${execution.actualStartTime}-${execution.actualEndTime}`.padEnd(16, ' ') : '-'.padEnd(16, ' '),
          `${target?.name ?? '未知目标'}（${target?.catalog ?? '-'}）`.padEnd(18, ' '),
          (telescope?.code ?? '-').padEnd(10, ' '),
          (actualTelescope?.code ?? '-').padEnd(10, ' '),
          session.filterSlot.padEnd(4, ' '),
          pad(session.plannedFrames, 4),
          execution ? pad(execution.actualFrames, 4) : '   -',
          shortfall === null ? '  - ' : pad(shortfall, 4),
          session.status.padEnd(8, ' '),
          execution?.batchNo ?? '-',
        ].join(' '),
      );
    } else {
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
    }
  });
  lines.push('-'.repeat(112));
  const totalFrames = ordered.reduce((sum, session) => sum + session.plannedFrames, 0);
  const totalExposure = ordered.reduce((sum, session) => {
    const target = targets.find((item) => item.id === session.targetId);
    return sum + (target ? (session.plannedFrames * target.exposureSec) / 60 : 0);
  }, 0);
  lines.push(`合计排程段 ${ordered.length} 段，计划帧数 ${totalFrames} 帧，预计曝光 ${totalExposure.toFixed(1)} 分钟`);
  if (withExecution) {
    const executed = ordered.filter((session) => session.execution);
    const totalActual = executed.reduce((sum, session) => sum + effectiveFrames(session), 0);
    const totalShortfall = executed.reduce((sum, session) => sum + Math.max(0, session.plannedFrames - effectiveFrames(session)), 0);
    lines.push(`已交回执 ${executed.length} 段，实际帧数合计 ${totalActual} 帧，短拍合计 ${totalShortfall} 帧`);
  }
  lines.push(`导出时间：${new Date().toLocaleString('zh-CN')}`);
  return lines.join('\n');
}

/** 生成 CSV（携带执行结果：实际夜/时段/望远镜/帧数/短拍/批次号） */
export function buildPlanCsv(context: PlanContext): string {
  const { night, sessions, targets, telescopes, instruments, withExecution = true } = context;
  const header = [
    '观测夜', '时段', '目标名', '星表编号', '类型', '视星等', '望远镜', '终端', '滤镜', '帧数', '单帧曝光(s)', '状态', '改期原因',
    '实际观测夜', '实际时段', '实际望远镜', '实际帧数', '短拍帧数', '回执批次号',
  ];
  const rows = [...sessions]
    .sort((a, b) => a.startTime.localeCompare(b.startTime))
    .map((session) => {
      const target = targets.find((item) => item.id === session.targetId);
      const telescope = telescopes.find((item) => item.id === session.telescopeId);
      const instrument = instruments.find((item) => item.id === session.instrumentId);
      const execution = session.execution;
      const actualTelescope = telescopes.find((item) => item.id === execution?.actualTelescopeId);
      const actualNight = execution && night && effectiveNightId(session) === night.id ? night : undefined;
      return [
        session.nightId,
        `${session.startTime}-${session.endTime}`,
        target?.name ?? '',
        target?.catalog ?? '',
        target?.type ?? '',
        target ? String(target.magnitude) : '',
        telescope?.code ?? '',
        instrument?.model ?? '',
        session.filterSlot,
        String(session.plannedFrames),
        target ? String(target.exposureSec) : '',
        session.status,
        session.rescheduleReason ?? '',
        execution ? (actualNight?.date ?? execution.actualNightId ?? '') : '',
        execution ? `${execution.actualStartTime}-${execution.actualEndTime}` : '',
        actualTelescope?.code ?? '',
        execution ? String(execution.actualFrames) : '',
        execution ? String(Math.max(0, session.plannedFrames - execution.actualFrames)) : '',
        execution?.batchNo ?? '',
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
