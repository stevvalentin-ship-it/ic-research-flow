import type { MarkerInvariantIssue } from '../pipeline/markerInvariants';
import type { StructureInvariantIssue } from '../pipeline/structureInvariants';
import type { TaskStage } from '../../types/models';

export interface StructureDiagnosticReport {
  schemaVersion: 1;
  projectId: string;
  createdAt: number;
  errorName: string;
  stage?: TaskStage;
  message?: string;
  issues: Array<StructureInvariantIssue | MarkerInvariantIssue>;
}
