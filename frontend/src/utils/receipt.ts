import type {
  ExecutionBatch,
  ExecutionRecord,
  ParsedReceipt,
  ParsedReceiptRow,
  ReceiptContext,
  ReceiptImportResult,
  ReceiptRowIssue,
} from '../types/execution';

/** 合法时刻 HH:mm（00:00–23:59） */
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
/** 合法日期 YYYY-MM-DD */
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
/** 批次号：字母数字与连字符，至少 4 位 */
const BATCH_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,39}$/;

/** 表头别名 → 标准字段 */
const HEADER_ALIASES: Record<string, keyof ParsedReceiptRow | 'ignore'> = {
  段号: 'sessionNo',
  段: 'sessionNo',
  排程段号: 'sessionNo',
  计划段号: 'sessionNo',
  session: 'sessionNo',
  'session id': 'sessionNo',
  id: 'sessionNo',
  实际开始: 'actualStart',
  开始时刻: 'actualStart',
  开始时间: 'actualStart',
  开始: 'actualStart',
  start: 'actualStart',
  实际结束: 'actualEnd',
  结束时刻: 'actualEnd',
  结束时间: 'actualEnd',
  结束: 'actualEnd',
  end: 'actualEnd',
  帧数: 'actualFrames',
  实际帧数: 'actualFrames',
  实际帧: 'actualFrames',
  frames: 'actualFrames',
  望远镜: 'telescopeCode',
  望远镜编号: 'telescopeCode',
  实际望远镜: 'telescopeCode',
  设备: 'telescopeCode',
  telescope: 'telescopeCode',
  观测夜: 'actualNightDate',
  实际观测夜: 'actualNightDate',
  观测夜日期: 'actualNightDate',
  观测日期: 'actualNightDate',
  夜: 'actualNightDate',
  date: 'actualNightDate',
  night: 'actualNightDate',
  备注: 'remark',
  说明: 'remark',
  remark: 'remark',
  note: 'remark',
  notes: 'remark',
};

/** 回执文本列对应的可写字段（lineNo 为元数据，不参与列映射） */
type ReceiptTextField = Exclude<keyof ParsedReceiptRow, 'lineNo'>;

/** 无表头时的固定列序 */
const FIXED_ORDER: ReceiptTextField[] = ['sessionNo', 'actualStart', 'actualEnd', 'actualFrames', 'telescopeCode', 'actualNightDate', 'remark'];

/** 元信息行关键字 → 赋值目标 */
const META_KEYS: Array<{ re: RegExp; key: 'batchNo' | 'dutyOfficer' | 'note' }> = [
  { re: /^(?:#\s*)?(?:批次号|回执批次|批次|batch(?:\s*no)?)\s*[:：]\s*(.+)$/i, key: 'batchNo' },
  { re: /^(?:#\s*)?(?:值守|值守岗|值班人|值守人|duty(?:\s*officer)?)\s*[:：]\s*(.+)$/i, key: 'dutyOfficer' },
  { re: /^(?:#\s*)?(?:备注|说明|note)\s*[:：]\s*(.+)$/i, key: 'note' },
];

/** 兼容逗号（含中文逗号）/ 制表符 / 分号 / 多个空白切列 */
function splitCells(line: string): string[] {
  if (line.includes('\t')) {
    return line.split('\t').map((cell) => cell.trim().replace(/^"|"$/g, ''));
  }
  if (/[,，;；]/.test(line)) {
    return line
      .split(/[,，;；]/)
      .map((cell) => cell.trim().replace(/^"|"$/g, ''));
  }
  return line.trim().split(/\s{1,}/);
}

/** 识别表头行，返回列序；非表头返回 null */
function matchHeader(cells: string[]): Array<ReceiptTextField | 'ignore'> | null {
  const mapped = cells.map((cell) => HEADER_ALIASES[cell.trim().toLowerCase()] ?? HEADER_ALIASES[cell.trim()]);
  const fields = new Set<string>(mapped.filter((field) => field !== undefined && field !== 'ignore') as string[]);
  const required: ReceiptTextField[] = ['sessionNo', 'actualStart', 'actualEnd', 'actualFrames', 'telescopeCode'];
  if (required.every((field) => fields.has(field))) {
    return mapped as Array<ReceiptTextField | 'ignore'>;
  }
  return null;
}

function buildRow(lineNo: number, cells: string[], order: Array<ReceiptTextField | 'ignore'>): ParsedReceiptRow {
  const base: ParsedReceiptRow = { lineNo, sessionNo: '', actualStart: '', actualEnd: '', actualFrames: '', telescopeCode: '', actualNightDate: '', remark: '' };
  cells.forEach((cell, index) => {
    const field = order[index];
    if (field && field !== 'ignore') {
      base[field] = cell.trim();
    }
  });
  return base;
}

/**
 * 解析值守岗整夜执行回执文本：
 * - 支持「批次号：/ 值守：/ 备注：」元信息行（# 开头也识别）
 * - 自动识别表头；无表头按「段号, 实际开始, 实际结束, 实际帧数, 望远镜, 实际观测夜, 备注」固定列序
 * - 实际观测夜与备注列可缺省；整行字段不足或无法解释时按行报错
 */
export function parseReceipt(rawText: string, fallbackBatchNo = ''): ParsedReceipt {
  const meta: ParsedReceipt = { batchNo: fallbackBatchNo.trim(), dutyOfficer: '', note: '', rows: [] };
  const lines = rawText.replace(/^﻿/, '').split(/\r?\n/);
  let order: Array<ReceiptTextField | 'ignore'> = [...FIXED_ORDER];
  let headerSeen = false;

  /** 尝试按「关键字：值」解释元信息行，命中返回 true */
  const consumeMeta = (text: string): boolean => {
    for (const { re, key } of META_KEYS) {
      const matched = text.match(re);
      if (matched) {
        if (!meta[key]) meta[key] = matched[1].trim();
        return true;
      }
    }
    return false;
  };

  lines.forEach((original, index) => {
    const lineNo = index + 1;
    const line = original.trim();
    if (!line) return;

    // # 开头一律按注释处理
    if (line.startsWith('#')) return;

    // 元信息行优先（关键字：值，允许值中出现中文逗号等标点）
    if (consumeMeta(line)) return;

    const cells = splitCells(line);
    // 列数不足且无法作为表头解释：进入逐行校验报错
    if (cells.length < 5) {
      meta.rows.push(buildRow(lineNo, cells, order));
      return;
    }

    if (!headerSeen) {
      const headerOrder = matchHeader(cells);
      if (headerOrder) {
        order = headerOrder;
        headerSeen = true;
        return;
      }
    }
    meta.rows.push(buildRow(lineNo, cells, order));
  });

  return meta;
}

/** 时刻轴比较：返回相对当夜 18:00 的分钟数（跨零点自动 +1440，与 astro.axisMinutes 同口径） */
function axisOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((v) => Number(v) || 0);
  const clock = h * 60 + m;
  return clock >= 18 * 60 ? clock - 18 * 60 : clock + (1440 - 18 * 60);
}

function isValidDate(text: string): boolean {
  if (!DATE_RE.test(text)) return false;
  const date = new Date(`${text}T12:00:00`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

/** 单行规范化键（用于批次内容签名，忽略行号与备注空白差异） */
export function canonicalRowKey(row: Pick<ParsedReceiptRow, 'sessionNo' | 'actualStart' | 'actualEnd' | 'actualFrames' | 'telescopeCode' | 'actualNightDate'>): string {
  return [row.sessionNo, row.actualStart, row.actualEnd, row.actualFrames, row.telescopeCode, row.actualNightDate].map((value) => value.trim()).join('|');
}

/** FNV-1a 32 位 → 8 位十六进制（同一份回执重导的判定依据） */
export function receiptSignature(batchNo: string, rows: Array<{ sessionNo: string; actualStart: string; actualEnd: string; actualFrames: string; telescopeCode: string; actualNightDate: string }>): string {
  const payload = `${batchNo.trim()}::${rows
    .map((row) => canonicalRowKey(row))
    .sort()
    .join('||')}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < payload.length; index += 1) {
    hash ^= payload.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export interface BuiltReceipt {
  batch: ExecutionBatch;
  records: ExecutionRecord[];
}

/**
 * 校验通过后，把解析结果装配为批次与执行记录（不碰库）。
 * actualNightDate 缺省跟随计划夜；望远镜以编号台账解析为 ID。
 */
export function buildBatchAndRecords(
  parsed: ParsedReceipt,
  signature: string,
  context: ReceiptContext,
  schemaVersion: number,
  nowIso = new Date().toISOString(),
): BuiltReceipt {
  const firstSession = context.sessions.find((session) => session.id === parsed.rows[0]?.sessionNo);
  const records: ExecutionRecord[] = parsed.rows.map((row, index) => {
    const planned = context.sessions.find((session) => session.id === row.sessionNo);
    let actualNightId = planned?.nightId ?? '';
    if (row.actualNightDate) {
      actualNightId = context.nights.find((night) => night.date === row.actualNightDate)?.id ?? actualNightId;
    }
    const telescope = context.telescopes.find((item) => item.code === row.telescopeCode);
    return {
      id: `ex-${parsed.batchNo.trim()}-${index + 1}`,
      batchNo: parsed.batchNo.trim(),
      sessionId: row.sessionNo,
      actualNightId,
      actualStart: row.actualStart,
      actualEnd: row.actualEnd,
      actualTelescopeId: telescope?.id ?? '',
      actualFrames: Number(row.actualFrames),
      remark: row.remark.trim() || undefined,
      importedAt: nowIso,
      schemaVersion,
    };
  });
  const batch: ExecutionBatch = {
    batchNo: parsed.batchNo.trim(),
    nightId: firstSession?.nightId ?? '',
    dutyOfficer: parsed.dutyOfficer.trim() || undefined,
    receivedAt: nowIso,
    recordCount: records.length,
    contentSignature: signature,
    note: parsed.note.trim() || undefined,
    schemaVersion,
  };
  return { batch, records };
}

/**
 * 整批校验：任何一行不合法即整批拒收，逐行返回问题说明。
 * 规则：批次号合法、至少一行；段号必须命中计划基线且不重复；时刻合法且结束晚于开始；
 * 帧数为非负整数；望远镜编号在台账内；实际观测夜日期合法且存在；段号不能已在其它批次记账。
 * 批次号已存在：内容一致视为同份回执（幂等），不一致直接拒收。
 */
export function validateReceipt(parsed: ParsedReceipt, context: ReceiptContext): ReceiptImportResult {
  const issues: ReceiptRowIssue[] = [];
  const batchNo = parsed.batchNo.trim();

  if (!batchNo) {
    issues.push({ lineNo: 0, sessionNo: '-', issue: '缺少批次号：请在回执首行写「批次号：RCP-XXXX」，或在导入框外补填批次号' });
  } else if (!BATCH_RE.test(batchNo)) {
    issues.push({ lineNo: 0, sessionNo: batchNo, issue: `批次号「${batchNo}」非法：仅允许 4~40 位字母、数字、下划线或连字符` });
  }
  if (parsed.rows.length === 0) {
    issues.push({ lineNo: 0, sessionNo: batchNo || '-', issue: '回执没有任何数据行，至少需要一段执行记录' });
  }

  const existing = batchNo ? context.batches.find((batch) => batch.batchNo === batchNo) : undefined;
  const signature = receiptSignature(batchNo, parsed.rows);
  if (existing) {
    if (existing.contentSignature === signature && existing.recordCount === parsed.rows.length) {
      return { status: 'duplicate', batchNo, recordCount: existing.recordCount, issues: [], batch: existing };
    }
    issues.push({
      lineNo: 0,
      sessionNo: batchNo,
      issue: `批次号「${batchNo}」已入库（${existing.recordCount} 段，入库于 ${new Date(existing.receivedAt).toLocaleString('zh-CN')}），且本次内容与原回执不一致；请改用新批次号`,
    });
    parsed.rows.forEach((row) =>
      issues.push({ lineNo: row.lineNo, sessionNo: row.sessionNo || '-', issue: `整批拒收：批次号 ${batchNo} 已被内容不同的回执占用` }),
    );
    return { status: 'rejected', batchNo, recordCount: 0, issues };
  }

  const seen = new Map<string, number>();
  const planNightIds = new Set<string>();

  parsed.rows.forEach((row) => {
    const rowIssues: string[] = [];
    const sessionNo = row.sessionNo.trim();

    if (!sessionNo) rowIssues.push('缺少段号');
    if (!row.actualStart) rowIssues.push('缺少实际开始时刻');
    else if (!TIME_RE.test(row.actualStart)) rowIssues.push(`实际开始时刻「${row.actualStart}」非法，格式应为 HH:mm`);
    if (!row.actualEnd) rowIssues.push('缺少实际结束时刻');
    else if (!TIME_RE.test(row.actualEnd)) rowIssues.push(`实际结束时刻「${row.actualEnd}」非法，格式应为 HH:mm`);
    if (TIME_RE.test(row.actualStart) && TIME_RE.test(row.actualEnd) && axisOf(row.actualEnd) <= axisOf(row.actualStart)) {
      rowIssues.push(`实际时段 ${row.actualStart}-${row.actualEnd} 非法：结束时刻必须晚于开始时刻（跨零点请写成次日时刻，如 18:00-01:30）`);
    }
    if (row.actualFrames.trim() === '') {
      rowIssues.push('缺少实际帧数');
    } else if (!/^\d+$/.test(row.actualFrames.trim())) {
      rowIssues.push(`实际帧数「${row.actualFrames}」非法：必须为非负整数`);
    }
    if (!row.telescopeCode.trim()) {
      rowIssues.push('缺少实际望远镜编号');
    } else if (!context.telescopes.some((item) => item.code === row.telescopeCode.trim())) {
      rowIssues.push(`实际望远镜编号「${row.telescopeCode}」在设备台账中不存在`);
    }
    if (row.actualNightDate.trim()) {
      if (!isValidDate(row.actualNightDate.trim())) {
        rowIssues.push(`实际观测夜「${row.actualNightDate}」非法，日期应为 YYYY-MM-DD 且真实存在`);
      } else if (!context.nights.some((night) => night.date === row.actualNightDate.trim())) {
        rowIssues.push(`实际观测夜 ${row.actualNightDate} 不在观测夜台账中`);
      }
    }

    const planned = sessionNo ? context.sessions.find((session) => session.id === sessionNo) : undefined;
    if (sessionNo && !planned) rowIssues.push(`段号「${sessionNo}」在计划基线中不存在`);
    if (planned) {
      planNightIds.add(planned.nightId);
      if (seen.has(sessionNo)) rowIssues.push(`段号 ${sessionNo} 在本批回执中重复出现（首见于第 ${seen.get(sessionNo)} 行）`);
      const occupiedBy = context.occupied.get(sessionNo);
      if (occupiedBy && occupiedBy !== batchNo) rowIssues.push(`段号 ${sessionNo} 已在批次「${occupiedBy}」中记账，不能重复入账`);
    }

    if (rowIssues.length > 0) issues.push({ lineNo: row.lineNo, sessionNo: sessionNo || '-', issue: rowIssues.join('；') });
    if (planned) seen.set(sessionNo, row.lineNo);
  });

  // 跨多个计划夜时给批次级提示（不拒收，设备占用仍按各段实际夜计算）
  if (issues.length === 0 && planNightIds.size > 1) {
    issues.push({
      lineNo: 0,
      sessionNo: batchNo,
      issue: `提示：本批回执覆盖了 ${planNightIds.size} 个计划观测夜，已按各段实际观测夜分别重算占用`,
    });
  }

  if (issues.some((item) => !item.issue.startsWith('提示'))) {
    return { status: 'rejected', batchNo, recordCount: 0, issues: issues.filter((item) => !item.issue.startsWith('提示')) };
  }
  return { status: 'imported', batchNo, recordCount: parsed.rows.length, issues };
}
