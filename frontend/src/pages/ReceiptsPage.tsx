import { useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Collapse from '@mui/material/Collapse';
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
import { usePersistentStore } from '../hooks/usePersistentStore';
import { useSessionStore } from '../stores/sessionStore';
import { useNightStore } from '../stores/nightStore';
import { useTargetStore } from '../stores/targetStore';
import { useEquipmentStore } from '../stores/equipmentStore';
import { downloadText } from '../utils/export';
import {
  buildReceiptTemplate,
  groupReceiptBatches,
  parseReceipt,
  reconcileReceipt,
  type ReconcileResult,
} from '../utils/execution';
import { formatMinutes } from '../utils/astro';

/** 回执导入与逐段对账：整批校验（段号/时刻/重复批次），失败整批不入库；成功后按批次号查回时段与短拍差额 */
export default function ReceiptsPage() {
  usePersistentStore();
  const sessions = useSessionStore((s) => s.sessions);
  const telescopes = useEquipmentStore((s) => s.telescopes);
  const nights = useNightStore((s) => s.nights);
  const currentNightId = useNightStore((s) => s.currentNightId);
  const importReceipt = useSessionStore((s) => s.importReceipt);
  const targets = useTargetStore((s) => s.targets);

  const [text, setText] = useState('');
  const [result, setResult] = useState<ReconcileResult | null>(null);
  const [parseErrors, setParseErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState('');
  const [importing, setImporting] = useState(false);
  const [expandedBatch, setExpandedBatch] = useState('');

  const currentNight = nights.find((item) => item.id === currentNightId) ?? nights[0];
  const batches = useMemo(() => groupReceiptBatches(sessions), [sessions]);

  const telescopeById = (id: string) => telescopes.find((item) => item.id === id);
  const targetById = (id: string) => targets.find((item) => item.id === id);
  const nightById = (id: string) => nights.find((item) => item.id === id);

  function handleValidate() {
    setNotice('');
    const parsed = parseReceipt(text);
    if (parsed.parseErrors.length > 0) {
      setParseErrors(parsed.parseErrors);
      setResult(null);
      return;
    }
    setParseErrors([]);
    const rec = reconcileReceipt(parsed, sessions, telescopes, nights);
    setResult(rec);
  }

  async function handleImport() {
    if (!result || !result.ok) return;
    setImporting(true);
    try {
      const count = await importReceipt(result);
      setNotice(`回执 ${result.batchNo} 已入库，共 ${count} 段写入执行结果；计划基线（时段/设备/计划帧）保持导入前原样`);
      setText('');
      setResult(null);
    } finally {
      setImporting(false);
    }
  }

  function handleFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setText(String(reader.result ?? ''));
      setResult(null);
      setParseErrors([]);
      setNotice('');
    };
    reader.readAsText(file);
  }

  function downloadTemplate() {
    // 仅为本夜尚未交回执的排程段生成模板，避免重复填写触发「已有执行结果」校验
    const planned = sessions.filter((session) => session.nightId === currentNight?.id && !session.execution);
    const template = buildReceiptTemplate(currentNight, planned, telescopes);
    downloadText(`回执模板-${currentNight?.date ?? 'night'}.txt`, template);
  }

  return (
    <Box>
      <Typography variant="h5" sx={{ mb: 0.5 }}>
        执行回执导入与逐段对账
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        值守岗照现场实际填回回执，编排台按段号逐段对账：实际时段、帧数、望远镜写入执行结果，计划基线原样保留；
        段号对不上、时刻非法或重复批次时整批不入库，可按批次号查回时段与短拍差额。
      </Typography>

      {notice ? (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNotice('')}>
          {notice}
        </Alert>
      ) : null}

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1.4fr 1fr' }, gap: 2, mb: 3 }}>
        {/* 导入区 */}
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Stack direction="row" spacing={1} sx={{ mb: 1.5, flexWrap: 'wrap' }} alignItems="center">
            <Typography variant="subtitle1" sx={{ flexGrow: 1 }}>
              粘贴 / 上传回执
            </Typography>
            <Button size="small" variant="outlined" onClick={downloadTemplate}>
              下载回执模板
            </Button>
            <Button size="small" variant="outlined" component="label">
              上传回执文件
              <input type="file" accept=".txt,.csv,text/*" hidden onChange={handleFile} />
            </Button>
          </Stack>
          <TextField
            multiline
            minRows={10}
            fullWidth
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setResult(null);
              setParseErrors([]);
            }}
            placeholder={'# 批次号: BATCH-20251012-01\n# 观测夜: 2025-10-11\n# 值班人: 林一舟\n# 段号,实际开始,实际结束,实际望远镜,实际帧数,备注\ns-01,18:25,19:15,T-02,38,'}
            inputProps={{ style: { fontFamily: 'Menlo, Consolas, monospace', fontSize: 13 } }}
          />
          <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
            <Button variant="contained" onClick={handleValidate} disabled={!text.trim()}>
              校验回执
            </Button>
            {result?.ok ? (
              <Button variant="contained" color="success" onClick={() => void handleImport()} disabled={importing}>
                {importing ? '入库中…' : '确认入库（整批写入执行结果）'}
              </Button>
            ) : null}
          </Stack>

          {parseErrors.length > 0 ? (
            <Alert severity="error" sx={{ mt: 2 }}>
              <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
                回执解析失败（整批不入库）
              </Typography>
              {parseErrors.map((err, index) => (
                <div key={index}>{err}</div>
              ))}
            </Alert>
          ) : null}

          {result && !result.ok ? (
            <Alert severity="error" sx={{ mt: 2 }}>
              <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
                校验未通过（{result.errors.length} 个问题，整批不入库，计划基线保持原样）
              </Typography>
              <TableContainer>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell sx={{ width: 70 }}>行号</TableCell>
                      <TableCell sx={{ width: 120 }}>段号</TableCell>
                      <TableCell>问题</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {result.errors.map((err, index) => (
                      <TableRow key={index}>
                        <TableCell>{err.lineNo === 0 ? '批次' : err.lineNo}</TableCell>
                        <TableCell>{err.sessionId || '-'}</TableCell>
                        <TableCell>{err.message}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </Alert>
          ) : null}

          {result?.ok ? (
            <Alert severity="success" sx={{ mt: 2 }}>
              <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
                校验通过：批次 {result.batchNo}，共 {result.items.length} 段，确认后整批写入
              </Typography>
              <TableContainer>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>段号</TableCell>
                      <TableCell>目标</TableCell>
                      <TableCell>计划时段</TableCell>
                      <TableCell>实际时段</TableCell>
                      <TableCell>计划望远镜</TableCell>
                      <TableCell>实际望远镜</TableCell>
                      <TableCell align="right">计划帧</TableCell>
                      <TableCell align="right">实际帧</TableCell>
                      <TableCell align="right">短拍</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {result.items.map((item) => (
                      <TableRow key={item.session.id}>
                        <TableCell>{item.session.id}</TableCell>
                        <TableCell>{targetById(item.session.targetId)?.name ?? '-'}</TableCell>
                        <TableCell>{item.session.startTime}-{item.session.endTime}</TableCell>
                        <TableCell>{item.execution.actualStartTime}-{item.execution.actualEndTime}</TableCell>
                        <TableCell>{telescopeById(item.session.telescopeId)?.code ?? '-'}</TableCell>
                        <TableCell>{telescopeById(item.execution.actualTelescopeId)?.code ?? '-'}</TableCell>
                        <TableCell align="right">{item.plannedFrames}</TableCell>
                        <TableCell align="right">{item.actualFrames}</TableCell>
                        <TableCell align="right">
                          {item.framesDiff > 0 ? <Chip size="small" color="warning" label={`短拍 ${item.framesDiff}`} /> : <Chip size="small" color="success" variant="outlined" label="齐拍" />}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </Alert>
          ) : null}
        </Paper>

        {/* 填写说明 */}
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="subtitle1" sx={{ mb: 1 }}>
            回执填写说明
          </Typography>
          <Typography variant="body2" component="div" color="text.secondary">
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              <li>段号照计划排程段填写（如 s-01），勿改；</li>
              <li>实际开始/结束时刻填 HH:mm，可跨零点；</li>
              <li>实际望远镜填设备编号（如 T-02），现场换镜即填新编号；</li>
              <li>实际帧数填当晚实际拍摄帧数；</li>
              <li>批次号为回执唯一标识，重导同批次不重复入库；</li>
              <li>可点「下载回执模板」取预填计划值的模板，照现场改实际值即可。</li>
            </ul>
          </Typography>
          <Alert severity="info" sx={{ mt: 2 }}>
            对账口径：已执行段在设备占用图与总览中按实际时段、实际望远镜、实际观测夜重算；
            计划基线（原时段/设备/计划帧）保留在排程段列表供复核。
          </Alert>
        </Paper>
      </Box>

      {/* 批次查询 */}
      <Typography variant="subtitle1" sx={{ mb: 1 }}>
        按批次号查回（{batches.length} 批）
      </Typography>
      {batches.length === 0 ? (
        <Alert severity="info">暂无已入库回执</Alert>
      ) : (
        <Stack spacing={1.5}>
          {batches.map((batch) => {
            const expanded = expandedBatch === batch.batchNo;
            return (
              <Paper key={batch.batchNo} variant="outlined">
                <Stack
                  direction="row"
                  spacing={2}
                  alignItems="center"
                  sx={{ p: 1.5, cursor: 'pointer', flexWrap: 'wrap' }}
                  onClick={() => setExpandedBatch(expanded ? '' : batch.batchNo)}
                >
                  <Typography variant="body2" color="action" sx={{ width: 16 }}>
                    {expanded ? '▼' : '▶'}
                  </Typography>
                  <Typography variant="subtitle2">批次 {batch.batchNo}</Typography>
                  <Chip size="small" label={`${batch.items.length} 段`} />
                  <Chip size="small" variant="outlined" label={`计划 ${batch.totalPlannedFrames} 帧`} />
                  <Chip size="small" variant="outlined" label={`实际 ${batch.totalActualFrames} 帧`} />
                  <Chip size="small" color={batch.totalShortfallFrames > 0 ? 'warning' : 'success'} label={`短拍 ${batch.totalShortfallFrames} 帧 / ${batch.shortfallCount} 段`} />
                  <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto' }}>
                    {batch.dutyOfficer ? `值班 ${batch.dutyOfficer} · ` : ''}
                    导入 {new Date(batch.importedAt).toLocaleString('zh-CN')}
                  </Typography>
                </Stack>
                <Collapse in={expanded}>
                  <TableContainer>
                    <Table size="small">
                      <TableHead>
                        <TableRow>
                          <TableCell>段号</TableCell>
                          <TableCell>目标</TableCell>
                          <TableCell>观测夜</TableCell>
                          <TableCell>计划时段</TableCell>
                          <TableCell>实际时段</TableCell>
                          <TableCell>时长差</TableCell>
                          <TableCell>望远镜</TableCell>
                          <TableCell align="right">计划帧</TableCell>
                          <TableCell align="right">实际帧</TableCell>
                          <TableCell align="right">短拍</TableCell>
                          <TableCell>备注</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {batch.items.map((item) => (
                          <TableRow key={item.session.id}>
                            <TableCell>{item.session.id}</TableCell>
                            <TableCell>{targetById(item.session.targetId)?.name ?? '-'}</TableCell>
                            <TableCell>{nightById(item.execution.actualNightId ?? '')?.date ?? item.execution.actualNightId ?? '-'}</TableCell>
                            <TableCell>{item.session.startTime}-{item.session.endTime}</TableCell>
                            <TableCell>{item.execution.actualStartTime}-{item.execution.actualEndTime}</TableCell>
                            <TableCell>
                              <Typography variant="caption" color={item.minutesDiff < 0 ? 'warning.main' : 'text.secondary'}>
                                {item.minutesDiff === 0 ? '持平' : `${item.minutesDiff > 0 ? '+' : ''}${formatMinutes(Math.abs(item.minutesDiff))}`}
                              </Typography>
                            </TableCell>
                            <TableCell>
                              {telescopeById(item.session.telescopeId)?.code ?? '-'} → {telescopeById(item.execution.actualTelescopeId)?.code ?? '-'}
                            </TableCell>
                            <TableCell align="right">{item.plannedFrames}</TableCell>
                            <TableCell align="right">{item.actualFrames}</TableCell>
                            <TableCell align="right">
                              {item.framesDiff > 0 ? <Chip size="small" color="warning" label={`-${item.framesDiff}`} /> : <Chip size="small" color="success" variant="outlined" label="齐" />}
                            </TableCell>
                            <TableCell>
                              <Typography variant="caption" color="text.secondary">
                                {item.execution.note ?? '-'}
                              </Typography>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                </Collapse>
              </Paper>
            );
          })}
        </Stack>
      )}
    </Box>
  );
}
