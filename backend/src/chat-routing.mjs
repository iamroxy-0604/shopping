export function isStructuredChatRequest({ message = '', answer } = {}) {
  return /防晒|防晒霜|防晒乳|sunscreen/i.test(String(message)) || Boolean(answer?.questionId);
}
