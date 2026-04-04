import { Pool } from 'pg';
import { Mismatch, ReconciliationReport } from './reconciliation.entity';
import { NotFoundError } from '@/common/errors';

export class ReconciliationRepository {
  constructor(private readonly pool: Pool) {}

  async createReport(runDate: Date): Promise<string> {
    const dateStr = runDate.toISOString().split('T')[0]!;
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO reconciliation_reports (run_date, status)
       VALUES ($1, 'RUNNING')
       ON CONFLICT (run_date) DO UPDATE SET status = 'RUNNING', started_at = NOW()
       RETURNING id`,
      [dateStr],
    );
    return rows[0]!.id;
  }

  async updateReport(
    id: string,
    params: {
      status: 'COMPLETED' | 'FAILED';
      totalInternal: number;
      totalExternal: number;
      matchedCount: number;
      mismatchCount: number;
      mismatches: Mismatch[];
      error?: string;
    },
  ): Promise<void> {
    await this.pool.query(
      `UPDATE reconciliation_reports SET
         status         = $2,
         total_internal = $3,
         total_external = $4,
         matched_count  = $5,
         mismatch_count = $6,
         mismatches     = $7,
         error          = $8,
         completed_at   = NOW()
       WHERE id = $1`,
      [
        id,
        params.status,
        params.totalInternal,
        params.totalExternal,
        params.matchedCount,
        params.mismatchCount,
        JSON.stringify(params.mismatches),
        params.error ?? null,
      ],
    );
  }

  async findByDate(date: string): Promise<ReconciliationReport | null> {
    const { rows } = await this.pool.query<{
      id: string;
      run_date: string;
      status: 'RUNNING' | 'COMPLETED' | 'FAILED';
      total_internal: string;
      total_external: string;
      matched_count: string;
      mismatch_count: string;
      mismatches: Mismatch[];
      error: string | null;
      started_at: Date;
      completed_at: Date | null;
    }>(
      'SELECT * FROM reconciliation_reports WHERE run_date = $1',
      [date],
    );
    if (!rows[0]) return null;
    return this.toEntity(rows[0]);
  }

  async listReports(limit = 30): Promise<ReconciliationReport[]> {
    const { rows } = await this.pool.query<{
      id: string;
      run_date: string;
      status: 'RUNNING' | 'COMPLETED' | 'FAILED';
      total_internal: string;
      total_external: string;
      matched_count: string;
      mismatch_count: string;
      mismatches: Mismatch[];
      error: string | null;
      started_at: Date;
      completed_at: Date | null;
    }>(
      'SELECT * FROM reconciliation_reports ORDER BY run_date DESC LIMIT $1',
      [limit],
    );
    return rows.map((r) => this.toEntity(r));
  }

  private toEntity(row: {
    id: string;
    run_date: string;
    status: 'RUNNING' | 'COMPLETED' | 'FAILED';
    total_internal: string;
    total_external: string;
    matched_count: string;
    mismatch_count: string;
    mismatches: Mismatch[];
    error: string | null;
    started_at: Date;
    completed_at: Date | null;
  }): ReconciliationReport {
    return {
      id: row.id,
      runDate: row.run_date,
      status: row.status,
      totalInternal: parseInt(row.total_internal, 10),
      totalExternal: parseInt(row.total_external, 10),
      matchedCount: parseInt(row.matched_count, 10),
      mismatchCount: parseInt(row.mismatch_count, 10),
      mismatches: row.mismatches,
      error: row.error,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    };
  }
}
