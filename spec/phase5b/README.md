# Phase 5b: plain AI judge versus Aegis on real GCF documents

- `judge_prompt_p5b_v1.txt`: the frozen plain-judge prompt for real documents (approved 2026-11-20).
  SHA-256 `b9559ce87ddb0fbf51d56e65c3d4da3d0553243596539d840ef757244a6883f3`. Any change means stage 2 is discarded and rerun in full.
- `ts/judge_real.ts` embeds the same text; `ts/judge_real.test.ts` checks it byte for byte against this file.
- `tools/phase5b/build_inputs.py` builds the pipeline inputs from IATI CSVs and the excerpts.
- The protocol is kept as a separate document; the paper subsection follows Section 8.7 once results exist.
