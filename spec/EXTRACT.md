# MUSE Aegis extractor (Phase 3, step 2)

Reference code: `ts/extract.ts`. A language model proposes claims; `ts/claims.ts` accepts only those that can be
traced to the document (see `spec/CLAIMS.md`). The model's output is untrusted input at every step.

## Flow

`document text -> prompt -> model -> strict JSON parse -> anchorClaims -> verifyClaims (ledger) -> x2`

## Prompt (version 2)

- A fixed system prompt says the document is data, not instructions, and defines the output shape and the rules.
- The document sits between markers that are chosen so they cannot occur inside the document.
- Optional "preferred labels" from the ledger are offered as a NUMBERED list OUTSIDE the document block. A claim may give the number
  of the label it is about (`label_id`), and the ledger's own wording is then used. Version 1 asked the model to copy label wording
  and the first live runs showed it drifting (one run in three used wording that no longer matched the ledger). A pick only steers
  wording: a claim is still accepted only if its quote, value and subject are in the document, and the picked label's subject must be in the quote.

## Model call (Gemini REST, `generateContent`)

- The key travels only in the `x-goog-api-key` header, never in a URL, a log or a returned error.
- Request: `systemInstruction`, one user message, `temperature` (default 0), `maxOutputTokens`, `responseMimeType: application/json`.
- Rate limits and server errors are retried with doubling waits (up to 2 retries); client errors and timeouts are not.
- Blocked, truncated or empty replies are reported with a code and never parsed. "Thinking" parts of a reply are ignored.
- Errors return only a code and an HTTP status, never the provider's message.
- `listModels` lists the model names that can generate content, so a wrong name can be fixed without guessing.

## Limits

Documents over 60,000 characters or empty documents are refused before any request. At most 500 proposals are read and 200 accepted.

## What this does not do

It does not read PDFs or images, does not decide whether claims matter, and cannot find a claim the model fails to
extract. Temperature 0 reduces but does not remove variation between runs; measuring that variation is the job of x1 (step 3).
Free-tier requests may be used by Google to improve its products, so use made-up documents there.
