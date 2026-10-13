export const SECURITY_REVIEW_INSTRUCTIONS = `Perform a security-only review of this exact change.
Report only demonstrable, exploitable security flaws introduced by the target diff.
For each finding, trace attacker-controlled input to the sensitive operation,
state the actual prerequisites and concrete impact, and cite the changed lines.
Prioritize injection, authorization bypass, credential disclosure, path traversal,
unsafe deserialization, SSRF, and broken trust or isolation boundaries when reachable.
Do not report ordinary code quality, hypothetical attacks, pre-existing flaws,
generic hardening advice, or risks that require already-compromised administrators.
Inspect surrounding call sites and validation before claiming exploitability.
Use only read-only local evidence; do not execute an exploit against external systems.
Keep the existing JSON finding contract, severity priority, confidence, and location.
If no supported security finding exists, return an empty findings array and explain
the verified scope and material evidence limitations.`;
