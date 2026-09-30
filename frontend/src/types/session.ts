/** 排程段状态 */
export type SessionStatus = '待执行' | '进行中' | '已完成' | '因云取消';

/** 执行结果（值守岗现场回执，排程岗按段号逐段对账后写入） */
export interface ExecutionResult {
  /** 回执批次号（同一份回执重导不重复生成执行记录） */
  batchNo: string;
  /** 实际观测夜 ID（现场换观测夜时以回执为准，缺省取计划夜） */
  actualNightId?: string;
  /** 实际开始时刻 HH:mm */
  actualStartTime: string;
  /** 实际结束时刻 HH:mm（可跨零点） */
  actualEndTime: string;
  /** 实际望远镜 ID（现场换望远镜时以回执为准） */
  actualTelescopeId: string;
  /** 实际拍摄帧数 */
  actualFrames: number;
  /** 值守备注（云量、遮挡、设备异常等） */
  note?: string;
  /** 回执导入时间（ISO） */
  importedAt: string;
  /** 值班人（回执头） */
  dutyOfficer?: string;
}

/** 观测排程段 */
export interface ObsSession {
  id: string;
  /** 观测夜 ID */
  nightId: string;
  /** 观测目标 ID */
  targetId: string;
  /** 开始时刻 HH:mm */
  startTime: string;
  /** 结束时刻 HH:mm（可跨零点） */
  endTime: string;
  /** 望远镜 ID */
  telescopeId: string;
  /** 终端 ID */
  instrumentId: string;
  /** 滤镜轮位 */
  filterSlot: string;
  /** 计划帧数 */
  plannedFrames: number;
  /** 状态 */
  status: SessionStatus;
  /** 改期原因 */
  rescheduleReason?: string;
  /** 替补夜 ID（迁移时补齐） */
  backupNightId?: string;
  /** 执行结果（现场回执对账后写入；计划基线字段保持原样，不被覆盖） */
  execution?: ExecutionResult;
  /** 数据结构版本 */
  schemaVersion: number;
}

/** 冲突项 */
export interface ConflictItem {
  /** 当前排程段 */
  sessionId: string;
  /** 与之冲突的排程段 */
  otherId: string;
  nightId: string;
  telescopeId: string;
  /** 重叠分钟数 */
  overlapMinutes: number;
  /** 重叠区间文案 */
  overlapText: string;
}

export const SESSION_STATUSES: SessionStatus[] = ['待执行', '进行中', '已完成', '因云取消'];

/** 4 种状态配色（MUI Chip color） */
export const STATUS_CHIP_COLOR: Record<SessionStatus, 'default' | 'primary' | 'success' | 'error'> = {
  待执行: 'default',
  进行中: 'primary',
  已完成: 'success',
  因云取消: 'error',
};
