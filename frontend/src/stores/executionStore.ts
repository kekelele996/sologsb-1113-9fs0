import { create } from 'zustand';
import { db, SCHEMA_VERSION } from '../hooks/usePersistentStore';
import type { ExecutionBatch, ExecutionRecord, ParsedReceipt, ReceiptContext, ReceiptImportResult } from '../types';
import { buildBatchAndRecords, receiptSignature, validateReceipt } from '../utils/receipt';

interface ExecutionState {
  batches: ExecutionBatch[];
  records: ExecutionRecord[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  /**
   * 导入整夜执行回执：先整批校验，任何一行非法 / 段号对不上 / 批次重复即整批拒收，
   * 计划基线（sessions）一行不动；校验通过才在同一个事务内写批次与执行记录。
   * 同一份回执（批次号 + 内容签名一致）重导不生成执行记录。
   */
  importReceipt: (parsed: ParsedReceipt, context: ReceiptContext) => Promise<ReceiptImportResult>;
  /** 按批次号查回批次、执行记录与对账差额 */
  getByBatchNo: (batchNo: string) => { batch?: ExecutionBatch; records: ExecutionRecord[] };
  /** 删除批次（同时移除其全部执行记录，占用回到计划口径） */
  removeBatch: (batchNo: string) => Promise<void>;
}

/** 执行回执批次与逐段执行记录 */
export const useExecutionStore = create<ExecutionState>()((set, get) => ({
  batches: [],
  records: [],
  hydrated: false,

  hydrate: async () => {
    const [batches, records] = await Promise.all([db.executionBatches.orderBy('receivedAt').reverse().toArray(), db.executionRecords.toArray()]);
    set({ batches, records, hydrated: true });
  },

  importReceipt: async (parsed, context) => {
    const result = validateReceipt(parsed, context);
    if (result.status === 'rejected') {
      return result;
    }
    if (result.status === 'duplicate') {
      // 同一份回执重导：不生成执行记录，直接回显既有批次
      return result;
    }

    const signature = receiptSignature(parsed.batchNo.trim(), parsed.rows);
    const built = buildBatchAndRecords(parsed, signature, context, SCHEMA_VERSION);

    try {
      // 整批同入：事务内再次确认批次号未被占用、段号未被记账，杜绝并发重导产生重复记录
      await db.transaction('rw', db.executionBatches, db.executionRecords, async () => {
        const existing = await db.executionBatches.get(built.batch.batchNo);
        if (existing) {
          throw new Error(`批次号「${built.batch.batchNo}」已存在`);
        }
        const occupied = await db.executionRecords.where('sessionId').anyOf(built.records.map((record) => record.sessionId)).toArray();
        if (occupied.length > 0) {
          throw new Error(`段号 ${occupied.map((record) => record.sessionId).join('、')} 已有执行记录`);
        }
        await db.executionBatches.put(built.batch);
        await db.executionRecords.bulkPut(built.records);
      });
    } catch (error) {
      // 事务回滚：批次与记录均不入库，计划基线本来就未触碰
      return {
        status: 'rejected',
        batchNo: built.batch.batchNo,
        recordCount: 0,
        issues: [{ lineNo: 0, sessionNo: built.batch.batchNo, issue: `整批未入库：${(error as Error).message}` }],
      };
    }

    set({
      batches: [built.batch, ...get().batches],
      records: [...get().records, ...built.records],
    });
    return { status: 'imported', batchNo: built.batch.batchNo, recordCount: built.records.length, issues: result.issues, batch: built.batch };
  },

  getByBatchNo: (batchNo) => {
    const normalized = batchNo.trim();
    return {
      batch: get().batches.find((batch) => batch.batchNo === normalized),
      records: get().records.filter((record) => record.batchNo === normalized),
    };
  },

  removeBatch: async (batchNo) => {
    await db.transaction('rw', db.executionBatches, db.executionRecords, async () => {
      await db.executionRecords.where('batchNo').equals(batchNo).delete();
      await db.executionBatches.delete(batchNo);
    });
    set({
      batches: get().batches.filter((batch) => batch.batchNo !== batchNo),
      records: get().records.filter((record) => record.batchNo !== batchNo),
    });
  },
}));
