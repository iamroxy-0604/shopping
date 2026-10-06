export function isStructuredChatRequest({ message = '', answer } = {}) {
  // The legacy structured implementation is a fallback only. Wit owns every
  // category and every questionnaire when it is available.
  return /防晒|防晒霜|防晒乳|sunscreen/i.test(String(message)) || Boolean(answer?.questionId);
}
