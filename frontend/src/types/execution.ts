/** 执行记录：现场回执按段号回填的「实际」执行结果；计划基线 ObsSession 不做任何改动 */
export interface ExecutionRecord {
  id: string;
  /** 批次号（同属一次整夜回执） */
  batchNo: string;
  /** 段号，对应排程段 ObsSession.id */
  sessionId: string;
  /** 实际观测夜 ID（现场换夜时与计划夜不同，旧占用随之从计划夜下线） */
  actualNightId: string;
  /** 实际开始时刻 HH:mm */
  actualStart: string;
  /** 实际结束时刻 HH:mm（可跨零点） */
  actualEnd: string;
  /** 实际望远镜 ID（现场换镜子时与计划不同） */
  actualTelescopeId: string;
  /** 实际帧数；与计划帧数之差即短拍差额 */
  actualFrames: number;
  /** 现场备注（换设备、换夜、提前收光原因等） */
  remark?: string;
  /** 入库时间 ISO */
  importedAt: string;
  /** 数据结构版本 */
  schemaVersion: number;
}

/** 执行回执批次：值守岗一次交回的整夜回执，整批同入同退 */
export interface ExecutionBatch {
  /** 批次号（主键，如 RCP-20251011-01） */
  batchNo: string;
  /** 回执对应的计划观测夜 ID（取首批段号的计划夜） */
  nightId: string;
  /** 值守岗 */
  dutyOfficer?: string;
  /** 回执入库时间 ISO */
  receivedAt: string;
  /** 本批执行记录条数 */
  recordCount: number;
  /** 回执内容签名：批次号相同且内容一致时重导视为同一份回执（幂等） */
  contentSignature: string;
  /** 回执级备注 */
  note?: string;
  /** 数据结构版本 */
  schemaVersion: number;
}

/** 回执解析出的原始数据行（尚未校验） */
export interface ParsedReceiptRow {
  /** 原文行号（从 1 起，便于逐行说明问题） */
  lineNo: number;
  sessionNo: string;
  actualStart: string;
  actualEnd: string;
  actualFrames: string;
  telescopeCode: string;
  /** 实际观测夜日期 YYYY-MM-DD；空串表示跟随计划夜 */
  actualNightDate: string;
  remark: string;
}

/** 回执解析结果 */
export interface ParsedReceipt {
  batchNo: string;
  dutyOfficer: string;
  note: string;
  rows: ParsedReceiptRow[];
}

/** 逐行问题 */
export interface ReceiptRowIssue {
  /** 原文行号；批次级问题为 0 */
  lineNo: number;
  /** 对应段号（批次级问题为批次号） */
  sessionNo: string;
  /** 问题说明 */
  issue: string;
}

/** 导入结论：入库 / 同份回执重复（幂等，不生成记录）/ 整批拒收 */
export type ReceiptImportStatus = 'imported' | 'duplicate' | 'rejected';

/** 回执导入结果 */
export interface ReceiptImportResult {
  status: ReceiptImportStatus;
  batchNo: string;
  recordCount: number;
  /** 拒收时逐行列出的问题 */
  issues: ReceiptRowIssue[];
  /** 成功入库 / 命中既有批次时的批次实体 */
  batch?: ExecutionBatch;
}

/** 回执校验所需的台账上下文（由 store 装配，校验逻辑保持纯函数） */
export interface ReceiptContext {
  sessions: Array<Pick<import('./session').ObsSession, 'id' | 'nightId'>>;
  nights: Array<Pick<import('./night').ObsNight, 'id' | 'date'>>;
  telescopes: Array<Pick<import('./equipment').Telescope, 'id' | 'code'>>;
  /** 已入库批次 */
  batches: ExecutionBatch[];
  /** 已入库执行记录：段号 -> 批次号（防止跨批次重复记账） */
  occupied: Map<string, string>;
}
