import type {
  SimulationComparisonRequest,
  SimulationComparisonResult,
} from '../../core/simulation';

export interface SimulationWorkerRequest {
  readonly token: number;
  readonly request: SimulationComparisonRequest;
}

export type SimulationWorkerResponse =
  | {
      readonly kind: 'success';
      readonly token: number;
      readonly result: SimulationComparisonResult;
    }
  | {
      readonly kind: 'failure';
      readonly token: number;
      readonly error: string;
    };
