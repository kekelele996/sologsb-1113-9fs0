import { useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import Timeline, { type TimelineBar } from '../components/common/Timeline';
import ConflictBadge from '../components/common/ConflictBadge';
import StatusChip from '../components/common/StatusChip';
import { usePersistentStore } from '../hooks/usePersistentStore';
import { useConflictCheck } from '../hooks/useConflictCheck';
import { useSessionStore } from '../stores/sessionStore';
import { useNightStore } from '../stores/nightStore';
import { useTargetStore } from '../stores/targetStore';
import { useEquipmentStore } from '../stores/equipmentStore';
import { useExecutionStore } from '../stores/executionStore';
import { NIGHT_TOTAL_MINUTES, TARGET_COLOR } from '../types';
import { axisMinutes, timelineTicks } from '../utils/astro';
import { buildNightPlanText, buildPlanCsv, downloadText, printPage } from '../utils/export';

/** 导出当晚观测清单（文本 / CSV / 打印视图） */
export default function ExportPage() {
  usePersistentStore();
  const nights = useNightStore((s) => s.nights);
  const currentNightId = useNightStore((s) => s.currentNightId);
  const setCurrentNight = useNightStore((s) => s.setCurrentNight);
  const sessions = useSessionStore((s) => s.sessions);
  const targets = useTargetStore((s) => s.targets);
  const telescopes = useEquipmentStore((s) => s.telescopes);
  const instruments = useEquipmentStore((s) => s.instruments);
  const allRecords = useExecutionStore((s) => s.records);
  const { conflictsOfNight, conflictIds } = useConflictCheck();
  const [notice, setNotice] = useState('');

  const night = nights.find((item) => item.id === currentNightId) ?? nights[0];
  const nightSessions = useMemo(() => sessions.filter((session) => session.nightId === night?.id), [sessions, night?.id]);
  const conflicts = useMemo(() => conflictsOfNight(night?.id ?? ''), [conflictsOfNight, night?.id]);
  const ids = useMemo(() => conflictIds(night?.id), [conflictIds, night?.id]);

  /** 当前夜计划基线涉及段的执行记录（含现场换到其它夜、或从其它夜换入的对账上下文） */
  const nightSessionIds = useMemo(() => new Set(nightSessions.map((session) => session.id)), [nightSessions]);
  const nightRecords = useMemo(() => allRecords.filter((record) => nightSessionIds.has(record.sessionId)), [allRecords, nightSessionIds]);
  const exportContext = useMemo(
    () => ({ night, sessions: nightSessions, targets, telescopes, instruments, records: nightRecords, nights }),
    [night, nightSessions, targets, telescopes, instruments, nightRecords, nights],
  );

  const planText = useMemo(() => buildNightPlanText(exportContext), [exportContext]);
  const csv = useMemo(() => buildPlanCsv(exportContext), [exportContext]);

  const bars: TimelineBar[] = useMemo(
    () =>
      nightSessions.map((session) => {
        const target = targets.find((item) => item.id === session.targetId);
        const startMinute = Math.max(0, Math.min(NIGHT_TOTAL_MINUTES, axisMinutes(session.startTime)));
        const rawEnd = axisMinutes(session.endTime);
        return {
          id: session.id,
          startMinute,
          endMinute: Math.max(startMinute + 20, Math.min(NIGHT_TOTAL_MINUTES, rawEnd <= startMinute ? rawEnd + 1440 : rawEnd)),
          label: target?.name ?? '未知目标',
          color: target ? TARGET_COLOR[target.type] : '#607d8b',
          dimmed: session.status === '因云取消',
          tooltip: `${session.startTime}-${session.endTime} · ${session.filterSlot} · ${session.plannedFrames} 帧 · ${session.status}`,
        };
      }),
    [nightSessions, targets],
  );

  return (
    <Box>
      <Typography variant="h5" sx={{ mb: 0.5 }}>
        导出当晚观测清单
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        汇总计划基线的目标、时刻、滤镜与帧数，并逐段附上执行回执的实际时段、望远镜与帧数差额；文本 / CSV / 打印视图内容一致。
      </Typography>

      {notice ? (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNotice('')}>
          {notice}
        </Alert>
      ) : null}

      <Stack direction="row" spacing={2} sx={{ mb: 2, flexWrap: 'wrap' }} alignItems="center" className="no-print">
        <TextField select size="small" label="观测夜" value={night?.id ?? ''} onChange={(event) => setCurrentNight(event.target.value)} sx={{ minWidth: 260 }}>
          {nights.map((item) => (
            <MenuItem key={item.id} value={item.id}>
              {`${item.date} · ${item.siteName} · ${item.cloudText}${item.primary ? '（主夜）' : item.backup ? '（备用夜）' : ''}`}
            </MenuItem>
          ))}
        </TextField>
        <Chip size="small" label={`排程段 ${nightSessions.length}`} />
        <Chip size="small" label={`计划帧数合计 ${nightSessions.reduce((sum, session) => sum + session.plannedFrames, 0)}`} />
        <Chip
          size="small"
          color={nightRecords.some((record) => {
            const planned = nightSessions.find((session) => session.id === record.sessionId);
            return planned && record.actualFrames < planned.plannedFrames;
          }) ? 'error' : 'default'}
          variant={nightRecords.length ? 'filled' : 'outlined'}
          label={
            nightRecords.length
              ? `已回执 ${nightRecords.length} 段 · 实际帧 ${nightRecords.reduce((sum, record) => sum + record.actualFrames, 0)}`
              : '暂无执行回执'
          }
        />
        <ConflictBadge conflicts={conflicts} />
        <Button
          variant="contained"
          onClick={() => {
            downloadText(`观测清单-${night?.date ?? 'night'}.txt`, planText);
            setNotice('已下载观测清单文本文件');
          }}
        >
          下载文本
        </Button>
        <Button
          variant="contained"
          color="secondary"
          onClick={() => {
            downloadText(`观测清单-${night?.date ?? 'night'}.csv`, csv, 'text/csv');
            setNotice('已下载观测清单 CSV 文件');
          }}
        >
          下载 CSV
        </Button>
        <Button variant="outlined" onClick={() => printPage()}>
          打印视图
        </Button>
      </Stack>

      <Box className="no-print" sx={{ mb: 3 }}>
        <Timeline bars={bars} ticks={timelineTicks(120)} totalMinutes={NIGHT_TOTAL_MINUTES} conflictIds={ids} height={104} />
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '2fr 1fr' }, gap: 2 }}>
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="subtitle1" sx={{ mb: 1 }}>
            观测清单（文本预览）
          </Typography>
          <Box component="pre" sx={{ m: 0, fontSize: 12, lineHeight: 1.6, whiteSpace: 'pre-wrap', fontFamily: 'Menlo, Consolas, monospace', maxHeight: 460, overflow: 'auto' }}>
            {planText}
          </Box>
        </Paper>
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="subtitle1" sx={{ mb: 1 }}>
            排程段状态核对
          </Typography>
          <Stack spacing={1}>
            {[...nightSessions]
              .sort((a, b) => axisMinutes(a.startTime) - axisMinutes(b.startTime))
              .map((session) => {
                const target = targets.find((item) => item.id === session.targetId);
                const record = nightRecords.find((item) => item.sessionId === session.id);
                const delta = record ? record.actualFrames - session.plannedFrames : 0;
                return (
                  <Stack key={session.id} direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                    <Chip size="small" label={`${session.startTime}-${session.endTime}`} />
                    <Typography variant="body2">{target?.name ?? '未知目标'}</Typography>
                    <Chip size="small" variant="outlined" label={session.filterSlot} />
                    <Chip size="small" variant="outlined" label={`计划 ${session.plannedFrames} 帧`} />
                    <StatusChip status={session.status} />
                    {record ? (
                      <>
                        <Chip
                          size="small"
                          color={delta < 0 ? 'error' : delta > 0 ? 'primary' : 'success'}
                          label={`实际 ${record.actualStart}-${record.actualEnd} · ${telescopes.find((item) => item.id === record.actualTelescopeId)?.code ?? '-'} · ${record.actualFrames} 帧（${delta >= 0 ? '+' : ''}${delta}）`}
                        />
                        <Typography variant="caption" color="text.secondary">
                          {record.batchNo}
                          {record.actualNightId !== session.nightId ? ` · 实际夜 ${nights.find((item) => item.id === record.actualNightId)?.date ?? record.actualNightId}` : ''}
                        </Typography>
                      </>
                    ) : (
                      <Typography variant="caption" color="text.secondary">
                        未回执
                      </Typography>
                    )}
                  </Stack>
                );
              })}
            {nightSessions.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                该观测夜暂无排程段
              </Typography>
            ) : null}
          </Stack>
        </Paper>
      </Box>
    </Box>
  );
}
