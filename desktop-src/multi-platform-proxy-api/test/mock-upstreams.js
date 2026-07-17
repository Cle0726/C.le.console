import http from 'node:http';

const SAMPLE_IMAGE_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==';

function startMock(port, name, failFirst = false) {
  const calls = {
    chat: 0,
    images: 0,
    responses: 0,
  };

  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      return json(res, 200, {
        object: 'list',
        data: [
          { id: `${name}-model`, object: 'model', created: 0, owned_by: name },
          { id: `${name}-image-model`, object: 'model', created: 0, owned_by: name },
        ],
      });
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      calls.chat += 1;
      const body = await readJson(req);
      if (failFirst && calls.chat === 1) return json(res, 429, { error: { message: `${name} simulated rate limit` } });
      return json(res, 200, {
        id: `chatcmpl-${name}-${calls.chat}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: `[${name}] proxied ${body.messages?.[0]?.content || ''}` }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }
    if (req.method === 'POST' && req.url === '/v1/images/generations') {
      calls.images += 1;
      const body = await readJson(req);
      if (failFirst && calls.images === 1) return json(res, 429, { error: { message: `${name} simulated image rate limit` } });
      return json(res, 200, {
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        data: [{
          b64_json: SAMPLE_IMAGE_B64,
          revised_prompt: `[${name}] ${body.prompt || ''}`.trim(),
        }],
      });
    }
    if (req.method === 'POST' && req.url === '/v1/responses') {
      calls.responses += 1;
      const body = await readJson(req);
      if (failFirst && calls.responses === 1) return json(res, 429, { error: { message: `${name} simulated responses rate limit` } });
      return json(res, 200, {
        id: `resp-${name}-${calls.responses}`,
        object: 'response',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        output: [{
          type: 'image_generation_call',
          id: `img-${name}-${calls.responses}`,
          result: SAMPLE_IMAGE_B64,
          revised_prompt: `[${name}] ${stringifyInput(body.input)}`.trim(),
        }],
        output_text: '',
      });
    }
    return json(res, 404, { error: 'not found' });
  });
  server.listen(port, '127.0.0.1', () => console.log(`${name} mock upstream listening on ${port}`));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function stringifyInput(input) {
  if (typeof input === 'string') return input;
  if (Array.isArray(input)) return input.map((item) => stringifyInput(item?.content ?? item)).join(' ');
  if (input && typeof input === 'object') return stringifyInput(input.content || input.text || '');
  return '';
}

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

startMock(19081, 'mock-a', true);
startMock(19082, 'mock-b', false);
