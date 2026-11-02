// Server-Sent Events framing (WHATWG "event stream"): blank-line separated blocks of `field: value` lines;
// lines starting with ":" are comments (heartbeats). k6 has no streaming client, so this parses a complete
// response body after the server has ended the stream.

/** [{ event, id, data }] with data JSON-decoded when it is JSON */
export function parseSse(body) {
  const events = [];
  for (const block of String(body ?? '').split(/\r?\n\r?\n/)) {
    let event = 'message';
    let id;
    const data = [];
    let hasField = false;
    for (const line of block.split(/\r?\n/)) {
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') {
        event = value;
        hasField = true;
      } else if (field === 'data') {
        data.push(value);
        hasField = true;
      } else if (field === 'id') {
        id = value;
      }
    }
    if (!hasField) continue;
    const raw = data.join('\n');
    let parsed = raw;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // plain-text data stays a string
    }
    events.push({ event, id, data: parsed });
  }
  return events;
}
