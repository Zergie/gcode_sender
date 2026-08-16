/// <reference lib="webworker" />

import { compareSimulations } from '../../core/simulation';
import type {
  SimulationWorkerRequest,
  SimulationWorkerResponse,
} from './simulation-worker.protocol';

addEventListener('message', ({ data }: MessageEvent<SimulationWorkerRequest>) => {
  let response: SimulationWorkerResponse;
  try {
    response = {
      kind: 'success',
      token: data.token,
      result: compareSimulations(data.request),
    };
  } catch (error) {
    response = {
      kind: 'failure',
      token: data.token,
      error: error instanceof Error ? error.message : 'The simulation worker failed.',
    };
  }
  postMessage(response);
});
