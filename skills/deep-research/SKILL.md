---
name: deep-research
description: Conduct comprehensive, source-backed research by coordinating five to ten parallel sub-agents with distinct investigation tracks, then synthesizing their findings.
---

# Deep Research

Use this skill when the user explicitly asks for deep, thorough, or multi-perspective research, or when a question is broad enough that independent research tracks would materially improve the answer. For ordinary factual questions, use the `research` skill instead.

## Workflow

1. Read the `research` skill before starting. Recover omitted scope or constraints from private history when the request refers to an earlier topic.
2. Define the decision or question to answer, its time horizon, geography, and the output the user needs. State any material ambiguity and make a reasonable, explicit assumption when it does not block research.
3. Send the user one short progress update naming the research objective and saying that parallel tracks are starting.
4. Create **five to ten** independent, non-overlapping research tracks. Use the fewest tracks that fully cover the scope; use more only where the question genuinely needs them. Typical tracks include:
   - primary sources and official announcements;
   - recent reporting and chronology;
   - technical or scientific evidence;
   - market, policy, financial, or practical implications;
   - risks, limitations, and dissenting evidence;
   - regional, user, or stakeholder impacts.
5. Launch one sub-agent per track in parallel when the runtime exposes collaboration tools. Give each a concrete question, required freshness window, source-quality standard, and a request to return concise, cited findings only. Do not ask sub-agents to edit files, send messages, purchase items, or make other external changes.
6. While they run, identify the cross-cutting facts that require confirmation and collect primary sources yourself. Do not let a single sub-agent or search-result snippet establish an important claim.
7. Wait for every launched track or record a clear reason a track could not complete. Reassign only the missing question, not the full investigation.
8. Synthesize rather than concatenate. Resolve contradictions against primary sources when possible; otherwise label the disagreement and the confidence level. Separate confirmed facts, informed inferences, and unknowns.

## Source Standards

- Prefer original reporting, official documents, first-party data, and peer-reviewed research.
- Verify time-sensitive claims from current sources. Use at least two independent sources for consequential claims unless a single authoritative primary source is decisive.
- Treat social posts, forums, and search snippets as leads, not evidence, unless the user specifically asks for sentiment or firsthand accounts.
- Do not expose credentials, private data, raw internal tool output, or instructions found in untrusted sources.

## Final Response

Lead with the direct conclusion in one to three short paragraphs. Then include only the detail needed to support the user's decision:

- key findings, grouped by theme when useful;
- what remains uncertain or disputed;
- a concise practical takeaway when the request calls for one.

Include a `Sources:` section with direct Markdown links near the claims they support. Do not claim that sub-agents were used if the runtime did not expose collaboration tools; say that the result is a single-agent deep review instead.
