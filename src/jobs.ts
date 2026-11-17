import type { Config } from "./config";
import { makeGraphic, type MakeRequest, type MakeResult } from "./loop";

export interface Job {
  id: string;
  state: "running" | "done" | "failed" | "stopped";
  brief: string;
  started: number;
  log: string[];
  step: number;
  total: number;
  result?: MakeResult;
  error?: string;
  controller: AbortController;
}

/** Runs make-graphic jobs one at a time, so a single GPU is never asked to serve two loops at once. */
export class JobQueue {
  private jobs = new Map<string, Job>();
  private chain: Promise<unknown> = Promise.resolve();
  private seq = 0;

  constructor(private cfg: Config) {}

  start(req: MakeRequest): Job {
    const id = `g${++this.seq}-${Date.now().toString(36)}`;
    const job: Job = { id, state: "running", brief: req.brief, started: Date.now(), log: ["Queued."], step: 0, total: 0, controller: new AbortController() };
    this.jobs.set(id, job);
    this.chain = this.chain.then(async () => {
      if (job.controller.signal.aborted) { job.state = "stopped"; return; }
      job.log.push("Started.");
      try {
        job.result = await makeGraphic(this.cfg, req, (e) => {
          job.step = e.step;
          job.total = e.total;
          job.log.push(e.message);
          if (job.log.length > 200) job.log.splice(1, job.log.length - 200);
        }, job.controller.signal);
        job.state = "done";
      } catch (e) {
        job.state = job.controller.signal.aborted ? "stopped" : "failed";
        job.error = (e as Error).message;
      }
    });
    return job;
  }

  get(id: string) { return this.jobs.get(id); }
  list() { return [...this.jobs.values()]; }
  stop(id: string) {
    const j = this.jobs.get(id);
    if (j && j.state === "running") j.controller.abort();
    return j;
  }
}
