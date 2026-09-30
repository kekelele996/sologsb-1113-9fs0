import { useMemo, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import FieldRow from '../components/common/FieldRow';
import { usePersistentStore } from '../hooks/usePersistentStore';
import { useSessionStore } from '../stores/sessionStore';
import { useNightStore } from '../stores/nightStore';
import { useEquipmentStore } from '../stores/equipmentStore';
import { useExecutionStore } from '../stores/executionStore';
import type { ExecutionRecord, ReceiptContext, ReceiptImportResult } from '../types';
import { parseReceipt } from '../utils/receipt';
import { reconcileSegments, signedDelta } from '../utils/reconcile';
import { toEffectiveSessions } from '../utils/effective';
import { SAMPLE_RECEIPT } from '../utils/sampleReceipt';

/** 执行回执逐段对账：整夜回执整批校验入库，计划基线保持原样，占用按实际重算 */
export default function ReceiptsPage() {
  usePersistentStore();
  const sessions = useSessionStore((s) => s.sessions);
  const nights = useNightStore((s) => s.nights);
  const telescopes = useEquipmentStore((s) => s.telescopes);
  const batches = useExecutionStore((s) => s.batches);
  const records = useExecutionStore((s) => s.records);
  const importReceipt = useExecutionStore((s) => s.importReceipt);
  const getByBatchNo = useExecutionStore((s) => s.getByBatchNo);
  const removeBatch = useExecutionStore((s) => s.removeBatch);

  const [rawText, setRawText] = useState('');
  const [batchNoInput, setBatchNoInput] = useState('');
  const [result, setResult] = useState<ReceiptImportResult | null>(null);
  const [notice, setNotice] = useState('');
  const [queryBatchNo, setQueryBatchNo] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const sessionById = (id: string) => sessions.find((session) => session.id === id);
  const nightById = (id: string) => nights.find((night) => night.id === id);
  const telescopeById = (id: string) => telescopes.find((telescope) => telescope.id === id);

  /** 整批校验上下文：计划基线 + 观测夜 / 设备台账 + 已入库批次与段号占用 */
  const context: ReceiptContext = useMemo(
    () => ({
      sessions: sessions.map((session) => ({ id: session.id, nightId: session.nightId })),
      nights: nights.map((night) => ({ id: night.id, date: night.date })),
      telescopes: telescopes.map((telescope) => ({ id: telescope.id, code: telescope.code })),
      batches,
      occupied: new Map(records.map((record) => [record.sessionId, record.batchNo])),
    }),
    [sessions, nights, telescopes, batches, records],
  );

  async function handleImport() {
    if (!rawText.trim()) {
      setResult({ status: 'rejected', batchNo: batchNoInput, recordCount: 0, issues: [{ lineNo: 0, sessionNo: '-', issue: '请先粘贴或选择整夜执行回执文本' }] });
      return;
    }
    const parsed = parseReceipt(rawText, batchNoInput);
    const importResult = await importReceipt(parsed, context);
    setResult(importResult);
    if (importResult.status === 'imported') setNotice(`批次 ${importResult.batchNo} 已入库，${importResult.recordCount} 段执行记录生效，设备占用已按实际重算`);
    if (importResult.status === 'duplicate') setNotice(`批次 ${importResult.batchNo} 为同一份回执，未重复生成执行记录`);
  }

  function handleFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      setRawText(String(reader.result ?? ''));
      setResult(null);
    };
    reader.readAsText(file, 'utf-8');
  }

  const query = queryBatchNo.trim() ? getByBatchNo(queryBatchNo.trim()) : { batch: undefined, records: [] as ExecutionRecord[] };
  const queryEffective = useMemo(() => {
    if (!query.batch || query.records.length === 0) return [];
    const baseline = sessions.filter((session) => query.records.some((record) => record.sessionId === session.id));
    return toEffectiveSessions(baseline, query.records);
  }, [query.batch, query.records, sessions]);
  const queryDeltas = useMemo(
    () =>
      reconcileSegments({
        effective: queryEffective,
        nightDateById: (id) => nightById(id)?.date,
        telescopeCodeById: (id) => telescopeById(id)?.code,
      }),
    [queryEffective, nights, telescopes],
  );

  return (
    <Box>
      <Typography variant="h5" sx={{ mb: 0.5 }}>
        执行回执逐段对账
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        值守岗交回整夜执行回执后，按段号逐段对账：实际时段、帧数与望远镜以现场为准写入执行结果；计划基线的原时段与设备保持不变，供排程岗复核。
        段号对不上、时刻非法或批次重复时整批不入库。
      </Typography>

      {notice ? (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNotice('')}>
          {notice}
        </Alert>
      ) : null}

      <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
        <Typography variant="subtitle1" sx={{ mb: 1 }}>
          导入整夜执行回执
        </Typography>
        <Alert severity="info" sx={{ mb: 2 }}>
          支持带表头的 CSV / 制表符 / 空格分列文本，列：段号、实际开始、实际结束、实际帧数、望远镜编号、实际观测夜（可空，跟随计划夜）、备注；
          首行可用「批次号：RCP-XXXX」「值守：姓名」标注。整批任一数据行非法即全部不入库，计划基线保持导入前原样。
        </Alert>

        <FieldRow label="批次号" hint="回执里已写「批次号：」时可留空；两处都写以回执文本为准">
          <TextField size="small" fullWidth value={batchNoInput} onChange={(event) => setBatchNoInput(event.target.value)} placeholder="RCP-20251012-02" />
        </FieldRow>
        <FieldRow label="回执文本" required labelWidth={132}>
          <TextField
            fullWidth
            multiline
            minRows={9}
            value={rawText}
            onChange={(event) => {
              setRawText(event.target.value);
              setResult(null);
            }}
            placeholder={'批次号：RCP-20251012-01\n值守：沈知远\n段号,实际开始,实际结束,实际帧数,望远镜,实际观测夜,备注\ns-09,18:32,19:38,40,T-01,,'}
            sx={{ fontFamily: 'Menlo, Consolas, monospace', fontSize: 13 }}
          />
        </FieldRow>
        <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap>
          <Button variant="contained" onClick={() => void handleImport()}>
            校验并整批入库
          </Button>
          <Button
            variant="outlined"
            onClick={() => {
              setRawText(SAMPLE_RECEIPT);
              setBatchNoInput('');
              setResult(null);
            }}
          >
            填入示例回执
          </Button>
          <Button variant="outlined" component="label">
            选择回执文件
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.txt,text/csv,text/plain"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) handleFile(file);
                event.target.value = '';
              }}
            />
          </Button>
          {rawText ? (
            <Button color="inherit" onClick={() => { setRawText(''); setResult(null); }}>
              清空
            </Button>
          ) : null}
        </Stack>

        {result ? (
          <Box sx={{ mt: 2 }}>
            {result.status === 'rejected' ? (
              <Alert severity="error">
                <Typography variant="subtitle2">整批拒收，未写入任何执行记录，计划基线保持原样（{result.issues.length} 个问题）</Typography>
              </Alert>
            ) : null}
            {result.status === 'duplicate' ? (
              <Alert severity="warning">
                批次号「{result.batchNo}」与已入库回执内容完全一致（同一份回执），本次重导不生成执行记录；可在下方按批次号查回对账明细。
              </Alert>
            ) : null}
            {result.status === 'imported' ? (
              <Alert severity="success">
                批次「{result.batchNo}」入库成功，共 {result.recordCount} 段；现场更换望远镜或观测夜的段，旧占用已下线，设备占用图与总览按实际时段重算。
                {result.issues.length > 0 ? <Typography variant="body2">{result.issues.map((item) => item.issue).join('；')}</Typography> : null}
              </Alert>
            ) : null}
            {result.status === 'rejected' && result.issues.length > 0 ? (
              <TableContainer component={Paper} variant="outlined" sx={{ mt: 1.5 }}>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell sx={{ width: 90 }}>原文行号</TableCell>
                      <TableCell sx={{ width: 120 }}>段号</TableCell>
                      <TableCell>问题说明</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {result.issues.map((issue, index) => (
                      <TableRow key={`${issue.lineNo}-${index}`}>
                        <TableCell>{issue.lineNo === 0 ? '批次' : `第 ${issue.lineNo} 行`}</TableCell>
                        <TableCell>{issue.sessionNo}</TableCell>
                        <TableCell>{issue.issue}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            ) : null}
          </Box>
        ) : null}
      </Paper>

      <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
        <Typography variant="subtitle1" sx={{ mb: 1 }}>
          按批次号查回对账明细
        </Typography>
        <Stack direction="row" spacing={1.5} sx={{ mb: 2 }}>
          <TextField
            select
            size="small"
            label="批次号"
            value={queryBatchNo}
            onChange={(event) => setQueryBatchNo(event.target.value)}
            sx={{ minWidth: 260 }}
            SelectProps={{ native: true }}
          >
            <option value="">— 选择已入库批次 —</option>
            {batches.map((batch) => (
              <option key={batch.batchNo} value={batch.batchNo}>
                {`${batch.batchNo}（${batch.recordCount} 段 · ${new Date(batch.receivedAt).toLocaleDateString('zh-CN')}）`}
              </option>
            ))}
          </TextField>
          <TextField size="small" label="或直接输入批次号" value={queryBatchNo} onChange={(event) => setQueryBatchNo(event.target.value)} sx={{ minWidth: 220 }} />
          {query.batch ? (
            <Button
              color="error"
              variant="outlined"
              onClick={() => {
                if (window.confirm(`删除批次 ${query.batch?.batchNo}？其 ${query.records.length} 段执行记录将一并移除，占用回到计划口径。`)) {
                  void removeBatch(query.batch!.batchNo).then(() => {
                    setNotice(`批次 ${query.batch?.batchNo} 已删除`);
                    setQueryBatchNo('');
                  });
                }
              }}
            >
              删除该批次
            </Button>
          ) : null}
        </Stack>

        {queryBatchNo.trim() && !query.batch ? (
          <Alert severity="info">未找到批次「{queryBatchNo.trim()}」，请确认批次号（已入库 {batches.length} 批）。</Alert>
        ) : null}
        {query.batch ? (
          <>
            <Stack direction="row" spacing={1} sx={{ mb: 1.5 }} flexWrap="wrap" useFlexGap>
              <Chip size="small" label={`值守 ${query.batch.dutyOfficer ?? '-'}`} />
              <Chip size="small" label={`入库时间 ${new Date(query.batch.receivedAt).toLocaleString('zh-CN')}`} />
              <Chip size="small" label={`计划夜 ${nightById(query.batch.nightId)?.date ?? query.batch.nightId}`} />
              <Chip size="small" color="primary" variant="outlined" label={`${query.records.length} 段`} />
              {query.batch.note ? <Chip size="small" variant="outlined" label={query.batch.note} /> : null}
            </Stack>
            <TableContainer component={Paper} variant="outlined">
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>段号</TableCell>
                    <TableCell>计划时段 → 实际时段</TableCell>
                    <TableCell>计划镜 → 实际镜</TableCell>
                    <TableCell>计划夜 → 实际夜</TableCell>
                    <TableCell align="right">计划帧</TableCell>
                    <TableCell align="right">实际帧</TableCell>
                    <TableCell align="right">帧数差额</TableCell>
                    <TableCell align="right">时长差额</TableCell>
                    <TableCell>偏差标记 / 备注</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {queryDeltas.map((delta) => (
                    <TableRow key={delta.sessionId} hover>
                      <TableCell>{delta.sessionId}</TableCell>
                      <TableCell>
                        {delta.plannedRange}
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                          → {delta.actualRange}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        {delta.plannedTelescopeCode}
                        <Typography variant="caption" color={delta.telescopeChanged ? 'warning.main' : 'text.secondary'} sx={{ display: 'block' }}>
                          → {delta.actualTelescopeCode}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        {delta.plannedNightDate}
                        <Typography variant="caption" color={delta.nightChanged ? 'warning.main' : 'text.secondary'} sx={{ display: 'block' }}>
                          → {delta.actualNightDate}
                        </Typography>
                      </TableCell>
                      <TableCell align="right">{delta.plannedFrames}</TableCell>
                      <TableCell align="right">{delta.actualFrames ?? '-'}</TableCell>
                      <TableCell align="right">
                        <Typography color={delta.shortShot ? 'error.main' : 'text.primary'} sx={{ fontWeight: delta.shortShot ? 700 : 400 }}>
                          {signedDelta(delta.frameDelta)}
                        </Typography>
                      </TableCell>
                      <TableCell align="right">{signedDelta(delta.durationDeltaMinutes, 'm')}</TableCell>
                      <TableCell>
                        <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                          {delta.shortShot ? <Chip size="small" color="error" label="短拍" /> : null}
                          {delta.telescopeChanged ? <Chip size="small" color="warning" label="换望远镜" /> : null}
                          {delta.nightChanged ? <Chip size="small" color="warning" label="换观测夜" /> : null}
                          {!delta.deviated ? <Chip size="small" color="success" variant="outlined" label="按计划" /> : null}
                        </Stack>
                        {delta.remark ? (
                          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                            {delta.remark}
                          </Typography>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </>
        ) : null}
      </Paper>

      <Divider sx={{ mb: 2 }} />

      <Typography variant="subtitle1" sx={{ mb: 1 }}>
        已入库回执批次（{batches.length}）
      </Typography>
      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>批次号</TableCell>
              <TableCell>计划观测夜</TableCell>
              <TableCell>值守</TableCell>
              <TableCell align="right">段数</TableCell>
              <TableCell>入库时间</TableCell>
              <TableCell>对账概览（短拍 / 换镜 / 换夜）</TableCell>
              <TableCell align="right">操作</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {batches.map((batch) => {
              const batchRecords = records.filter((record) => record.batchNo === batch.batchNo);
              const baseline = sessions.filter((session) => batchRecords.some((record) => record.sessionId === session.id));
              const effective = toEffectiveSessions(baseline, batchRecords);
              const deltas = reconcileSegments({
                effective,
                nightDateById: (id) => nightById(id)?.date,
                telescopeCodeById: (id) => telescopeById(id)?.code,
              });
              const shortShots = deltas.filter((delta) => delta.shortShot).length;
              const mirrorSwaps = deltas.filter((delta) => delta.telescopeChanged).length;
              const nightSwaps = deltas.filter((delta) => delta.nightChanged).length;
              const frameSum = batchRecords.reduce((sum, record) => sum + record.actualFrames, 0);
              const plannedSum = baseline.reduce((sum, session) => sum + session.plannedFrames, 0);
              return (
                <TableRow key={batch.batchNo} hover>
                  <TableCell>{batch.batchNo}</TableCell>
                  <TableCell>{nightById(batch.nightId)?.date ?? batch.nightId}</TableCell>
                  <TableCell>{batch.dutyOfficer ?? '-'}</TableCell>
                  <TableCell align="right">{batch.recordCount}</TableCell>
                  <TableCell>{new Date(batch.receivedAt).toLocaleString('zh-CN')}</TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                      <Chip size="small" color={shortShots ? 'error' : 'success'} variant={shortShots ? 'filled' : 'outlined'} label={`短拍 ${shortShots}`} />
                      <Chip size="small" color={mirrorSwaps ? 'warning' : 'default'} variant={mirrorSwaps ? 'filled' : 'outlined'} label={`换镜 ${mirrorSwaps}`} />
                      <Chip size="small" color={nightSwaps ? 'warning' : 'default'} variant={nightSwaps ? 'filled' : 'outlined'} label={`换夜 ${nightSwaps}`} />
                      <Chip size="small" variant="outlined" label={`帧数 ${plannedSum} → ${frameSum}（${signedDelta(frameSum - plannedSum)}）`} />
                    </Stack>
                  </TableCell>
                  <TableCell align="right">
                    <Button size="small" onClick={() => setQueryBatchNo(batch.batchNo)}>
                      查明细
                    </Button>
                    <Button
                      size="small"
                      color="error"
                      onClick={() => {
                        if (window.confirm(`删除批次 ${batch.batchNo}？其 ${batch.recordCount} 段执行记录将一并移除。`)) {
                          void removeBatch(batch.batchNo).then(() => setNotice(`批次 ${batch.batchNo} 已删除`));
                        }
                      }}
                    >
                      删除
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
            {batches.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} align="center">
                  <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
                    暂无已入库执行回执
                  </Typography>
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </TableContainer>

      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
        对账口径：计划基线时段 / 设备保持导入前原样；执行结果以现场实际为准，跨零点时段按当夜 18:00 起算轴计算时长差额。
      </Typography>
    </Box>
  );
}
