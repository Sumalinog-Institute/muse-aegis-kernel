# Phase 7 labelling guide (version 1)

You are checking 69 statements ("issues") that an AI system raised about 15 real Green Climate Fund (GCF) projects. For each issue you decide whether the documents back it up. You are not judging the project, the people or the AI. You do not need to know which method raised which issue, and you should not try to find out.

## What you have

- **The reading packet** (`reading_packet.csv`): one row per issue, with a hint under "where to look".
- **The documents:** the funding proposal and the annual performance report (APR) for each project, as PDFs named `FPxxx_proposal.pdf` and `FPxxx_apr.pdf` (`SAPxxx` for the simplified approval process).
- **The reference sheets** (`reference_sheets.md`): the fund's own transaction records (IATI) for each project. When an issue mentions "the fund's records", "IATI records" or "reference records", use these.

Use only these. Do not search the web, use AI tools, or look at other documents.

## The three labels

**Supported.** The key fact in the issue is true: the figures or statements it quotes appear in the sources, and they differ or conflict in the way the issue says. Small wording errors in the issue are fine if the main point is correct.

**Not supported.** The key fact is wrong. Typical cases: a quoted figure does not appear where the issue says; the figures actually agree; the issue adds up numbers wrongly; a unit or currency is misread (for example EUR read as USD, thousands read as millions); the issue describes something the documents say the opposite of.

**Unclear.** You cannot decide from the sources you have. Typical cases: the document does not contain the information (some APRs are short public versions without financial tables); a table is unreadable or incomplete; the issue is too vague to check; the answer depends on a judgement the documents do not settle.

## Rules for hard cases

1. **Check every figure the issue quotes.** If one quoted figure is wrong and it is central to the point, label Not supported. If it is a minor side detail and the main point holds, label Supported and say so in your reason.
2. **Rounding.** A difference smaller than 0.1% that the issue calls "significant" is Not supported. A tiny difference that the issue calls "slight" or "minor" can be Supported.
3. **Currency.** Never convert currencies yourself. If the issue compares amounts in different currencies as if they were the same, label Not supported. If the comparison needs a conversion to decide, label Unclear.
4. **Sums.** If the issue states a total, add the parts yourself. Use a calculator.
5. **"Differs from the fund's records."** Check the reference sheet totals and the individual record rows.
6. **Missing information is not evidence.** If you cannot find something, search the whole document for it (use the PDF search) before you choose. If the document truly does not contain it, label Unclear.
7. **Your own time.** If one issue takes you more than 15 minutes, label Unclear and note why. Do not guess.
8. **Do not label what the issue should have said.** Label only what it does say.

## What to return

Fill in three columns of the reading packet and change nothing else:

- `label`: exactly `Supported`, `Not supported` or `Unclear`.
- `reason`: one or two sentences, in your own words.
- `where I checked`: the document and page, or the reference record, that decided it (for example `FP125_apr p. 14, table E.2`).

Also note at the end of the file (in a separate line below the table, or in your email) the total time you spent.

## Working rules

- Work alone. Do not discuss any issue, label or reason with the other reviewer, the author, or anyone else until the author tells you the review is closed.
- Do not use AI tools or translation tools to read or label.
- Start with the five practice issues (P1 to P5) if you received them. The author will send you answers to those only, so that you and the other reviewer apply the standard in the same way. Then work through the packet in order.
- If something in these instructions is unclear, ask the author by email. The author will answer the question to both reviewers and will not comment on any specific issue.
