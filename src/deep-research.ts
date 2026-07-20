import fs from "node:fs";
import path from "node:path";
import type { AppDatabase } from "./db.js";
import type { AppLogger } from "./logger.js";
import type { AgentProvider, ProviderRunInput, ProviderRunOutput } from "./providers/types.js";
import type { AgentSkill } from "./skills.js";
import type { JobMetrics, JobRow, TokenUsage } from "./types.js";

interface ResearchTrack {
  title: string;
  instruction: string;
}

interface CompletedTrack {
  track: ResearchTrack;
  message: string;
  metrics?: JobMetrics;
}

export interface DeepResearchRunInput {
  job: JobRow;
  identity: string;
  skills: AgentSkill[];
  workingDirectory: string;
  schemaPath: string;
  signal: AbortSignal;
  model?: string;
}

const DEFAULT_TRACKS: ResearchTrack[] = [
  { title: "Primary sources", instruction: "Find official documentation, primary announcements, and original data." },
  { title: "Chronology", instruction: "Establish recent developments and the relevant timeline from reliable reporting." },
  { title: "Technical evidence", instruction: "Assess scientific, technical, or empirical evidence behind the central claim." },
  { title: "Practical implications", instruction: "Identify concrete user, market, or operational implications and constraints." },
  { title: "Risks and dissent", instruction: "Look for limitations, credible counterevidence, and material uncertainty." },
];

const EXHAUSTIVE_TRACKS: ResearchTrack[] = [
  ...DEFAULT_TRACKS,
  { title: "Policy and regulation", instruction: "Check applicable policy, standards, regulation, or public-sector context." },
  { title: "Alternatives", instruction: "Compare credible alternatives and explain the decision tradeoffs." },
  { title: "Regional variation", instruction: "Identify geographic, stakeholder, or deployment differences that change the answer." },
  { title: "Economics", instruction: "Assess cost, pricing, incentives, and market evidence where relevant." },
  { title: "Expert consensus", instruction: "Find high-quality expert analysis and distinguish consensus from speculation." },
];

function wantsExhaustiveResearch(prompt: string): boolean {
  return /\b(?:exhaustive|all[- ]angles|every angle|full landscape|comprehensive)\b/i.test(prompt);
}

function sumUsage(metrics: Array<JobMetrics | undefined>): TokenUsage | undefined {
  const present = metrics.map((item) => item?.usage).filter((item): item is TokenUsage => Boolean(item));
  if (!present.length) return undefined;
  return present.reduce(
    (total, usage) => ({
      inputTokens: total.inputTokens + usage.inputTokens,
      cachedInputTokens: total.cachedInputTokens + usage.cachedInputTokens,
      outputTokens: total.outputTokens + usage.outputTokens,
    }),
    { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
  );
}

export class DeepResearchCoordinator {
  constructor(
    private readonly provider: AgentProvider,
    private readonly db: AppDatabase,
    private readonly logger: AppLogger,
  ) {}

  async run(input: DeepResearchRunInput): Promise<ProviderRunOutput> {
    const tracks = wantsExhaustiveResearch(input.job.prompt) ? EXHAUSTIVE_TRACKS : DEFAULT_TRACKS;
    const researchDirectory = path.join(input.workingDirectory, ".aimessenger-research", String(input.job.id));
    fs.mkdirSync(researchDirectory, { recursive: true, mode: 0o700 });
    this.logger.info("deep_research.started", { job_id: input.job.id, track_count: tracks.length });

    const settled = await Promise.allSettled(
      tracks.map((track, index) => this.runTrack(input, track, index, researchDirectory)),
    );
    const completed: CompletedTrack[] = [];
    let failed = 0;
    for (const result of settled) {
      if (result.status === "fulfilled") completed.push(result.value);
      else failed += 1;
    }
    if (completed.length < 3) {
      throw new Error(`Deep research completed only ${completed.length}/${tracks.length} tracks; at least 3 are required.`);
    }

    let synthesisPid: number | undefined;
    let synthesis: ProviderRunOutput;
    try {
      synthesis = await this.provider.run({
        identity: input.identity,
        skills: input.skills.filter((skill) => skill.name === "research"),
        provider: "codex",
        model: input.model,
        prompt: this.synthesisPrompt(input.job.prompt, completed),
        attachmentPaths: [],
        sessionId: null,
        workingDirectory: researchDirectory,
        schemaPath: input.schemaPath,
        signal: input.signal,
        onProcessStart: (pid) => {
          synthesisPid = pid;
          this.db.addJobProcess(input.job.id, pid, "deep-research-synthesis");
        },
      });
    } finally {
      if (synthesisPid) this.db.removeJobProcess(input.job.id, synthesisPid);
    }
    const metrics = [...completed.map((item) => item.metrics), synthesis.metrics];
    const usage = sumUsage(metrics);
    this.logger.info("deep_research.completed", {
      job_id: input.job.id,
      track_count: tracks.length,
      completed_tracks: completed.length,
      failed_tracks: failed,
    });
    return {
      ...synthesis,
      sessionId: null,
      result: {
        ...synthesis.result,
        message: `Research method: ${tracks.length} independent tracks (${completed.length} completed, ${failed} failed).\n\n${synthesis.result.message}`,
        sessionDisposition: "handoff",
      },
      ...(usage ? { metrics: { ...synthesis.metrics, usage } } : {}),
    };
  }

  private async runTrack(
    input: DeepResearchRunInput,
    track: ResearchTrack,
    index: number,
    workingDirectory: string,
  ): Promise<CompletedTrack> {
    let pid: number | undefined;
    const startedAt = Date.now();
    try {
      const output = await this.provider.run({
        identity: input.identity,
        skills: input.skills.filter((skill) => skill.name === "research"),
        provider: "codex",
        model: input.model,
        prompt: `<research_track>\nTrack ${index + 1}: ${track.title}\n${track.instruction}\n\nQuestion: ${input.job.prompt}\n\nReturn concise, source-backed findings with direct links. Do not edit files, message anyone, buy anything, or use private chat history.\n</research_track>`,
        attachmentPaths: [],
        sessionId: null,
        workingDirectory,
        schemaPath: input.schemaPath,
        signal: input.signal,
        onProcessStart: (startedPid) => {
          pid = startedPid;
          this.db.addJobProcess(input.job.id, startedPid, "deep-research-track");
        },
      });
      if (!output.result.message.trim()) throw new Error("Research track returned no findings.");
      this.logger.info("deep_research.track_completed", {
        job_id: input.job.id,
        track: track.title,
        duration_ms: Date.now() - startedAt,
      });
      return { track, message: output.result.message, metrics: output.metrics };
    } catch (error) {
      this.logger.warn("deep_research.track_failed", {
        job_id: input.job.id,
        track: track.title,
        duration_ms: Date.now() - startedAt,
      });
      throw error;
    } finally {
      if (pid) this.db.removeJobProcess(input.job.id, pid);
    }
  }

  private synthesisPrompt(question: string, tracks: CompletedTrack[]): string {
    const evidence = tracks
      .map((track) => `## ${track.track.title}\n${track.message.slice(0, 8_000)}`)
      .join("\n\n");
    return `<research_synthesis>\nAnswer the user’s question using the independent research tracks below. Synthesize rather than concatenate; resolve disagreements, distinguish fact from inference, and name material uncertainty. Include direct Markdown source links near supported claims.\n\nQuestion: ${question}\n\n${evidence}\n</research_synthesis>`;
  }
}
