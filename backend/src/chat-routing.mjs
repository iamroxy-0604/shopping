export function isStructuredChatRequest({ message = '', answer } = {}) {
  // A sunscreen task belongs to the turn that created it. Do not let a stale
  // task hijack a later request for a different category (for example, 笔袋).
  // Explicit questionnaire answers still need the structured flow.
  return /防晒|防晒霜|防晒乳|sunscreen/i.test(String(message)) || Boolean(answer?.questionId);
}
