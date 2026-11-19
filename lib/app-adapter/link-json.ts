/** The JSON of an app link's answer, which may be plain JSON or an event stream holding it. */
export function linkJson(body: string, id?: number | string): Record<string, unknown> | null {
  const attempt = (text: string) => {
    try {
      const value = JSON.parse(text);
      return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  // An answer is for the question asked: one that carries another id is somebody else's, never taken for this one. (A reply with no id,
  // or a null one, is how a server answers a request it could not read, and is kept.)
  const answers = (message: Record<string, unknown>) => id === undefined || message.id === undefined || message.id === null || String(message.id) === String(id);
  const whole = attempt(body.trim());
  if (whole) return answers(whole) ? whole : null;
  // An event stream may carry notifications before the answer: the message that answers the question asked (its id) is the one wanted
  const messages: Record<string, unknown>[] = [];
  for (const line of body.split('\n')) {
    if (line.startsWith('data:')) {
      const found = attempt(line.slice(5).trim());
      if (found) messages.push(found);
    }
  }
  if (id === undefined) return messages[0] ?? null;
  return messages.find((message) => message.id !== undefined && message.id !== null && String(message.id) === String(id)) ?? messages.find((message) => (message.id === undefined || message.id === null) && 'error' in message) ?? null;
}
