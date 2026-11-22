/**
 * CONTRACT STUB from piece 2 (notes and Activity). Piece 1 owns this file (lib/computer-job-controls.ts): pause, resume, do this next and cancel one job. Piece 2's Brick door
 * calls these names. Drop this stub when piece 1's file lands.
 */
import type { ComputerView } from '@/lib/computer';

export type Controlled = { ok: true; view: ComputerView } | { ok: false; reason: string };

const notBuilt = async (): Promise<Controlled> => ({ ok: false, reason: 'not_built' });

export const pauseJob = (_botId: string, _ownerId: string, _jobId: string, _now?: Date): Promise<Controlled> => notBuilt();
export const resumeJob = (_botId: string, _ownerId: string, _jobId: string, _now?: Date): Promise<Controlled> => notBuilt();
export const moveJobFirst = (_botId: string, _ownerId: string, _jobId: string, _options: { pauseRunning?: boolean } = {}, _now?: Date): Promise<Controlled> => notBuilt();
export const cancelJob = (_botId: string, _ownerId: string, _jobId: string, _now?: Date): Promise<Controlled> => notBuilt();
